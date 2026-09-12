import { CAMERA_MOVES, type CameraConfig, type CameraMoveId } from '../presets/camera';
import type { MoodPreset } from '../presets/moods';
import type { MusicPreset } from '../presets/music';
import type { StudioStatus } from '../state';
import type { BlotJob, BlotRail } from '../rail/queue';
import type { ChunkInfo } from './protocol';
import { PRESERVE_CLAUSE, composeDirection, composeMoodShift, softenDirection } from './promptComposer';

/** What the scheduler needs from a live session. */
export interface SchedulerSession {
  readonly status: StudioStatus;
  readonly chunkIndex: number;
  direct(input: {
    prompt?: string;
    endImageUrl?: string | null;
    audioUrl?: string | null;
    audioBehavior?: 'replace' | 'queue';
    replan?: boolean;
  }): number;
}

export interface SchedulerEpisode {
  mood: MoodPreset;
  music: MusicPreset;
  camera: CameraConfig;
  moodStrength: number;
  arrivalMode: 'hard' | 'soft';
  palette: readonly string[];
}

export interface Destination {
  blotId: string;
  /** null for a mood-only continuation with no arrival image. */
  url: string | null;
  cameraMoveId: CameraMoveId | null;
  label: string;
  /** Index within the blot's destination sequence. */
  index: number;
}

export interface SchedulerEvents {
  onDestination?(info: { destination: Destination; promptVersion: number; chunkIndex: number }): void;
  onBlotAirborne?(info: { blotId: string; chunkIndex: number }): void;
  onBlotRetired?(info: { blotId: string }): void;
  onStall?(info: { emptyTicks: number }): void;
  onWarning?(message: string): void;
}

export interface SchedulerOptions {
  rail: BlotRail;
  session: SchedulerSession;
  readEpisode(): SchedulerEpisode;
  events?: SchedulerEvents;
  now?: () => number;
  /**
   * If a direction is never confirmed by a chunk carrying its version, the gate
   * is forced open rather than stalling the film forever.
   */
  dispatchTimeoutMs?: number;
  /** Consecutive ticks with nothing to dispatch before a mood continuation. */
  stallTicksBeforeContinuation?: number;
  /** Extra passes over a blot's angle set before it is retired. */
  maxAngleCycles?: number;
}

interface InFlight {
  destination: Destination;
  promptVersion: number;
  sentAt: number;
  retries: number;
}

/** Marks a direction that carries no blot, only the film's own momentum. */
export const CONTINUATION = 'continuation';

/**
 * Turns the blot rail into the film's next moment.
 *
 * One destination lands per dispatched chunk, so a blot with two camera angles
 * occupies three chunks: the blot itself, then two views of it. Because a
 * direction applies to the next *undispatched* chunk, the scheduler opens its
 * gate only when a chunk arrives carrying the version it last sent - otherwise
 * a burst of directions would collapse into the last one and blots would
 * silently vanish.
 */
export class BlotScheduler {
  private cursor = 0;
  private cycles = 0;
  private inFlight: InFlight | null = null;
  private awaitingDispatch = false;
  private lastSentAt = 0;
  private emptyTicks = 0;
  private pendingMoodShift: string | null = null;
  private retired = new Set<string>();
  /** Blots already given their one softening after a content rejection. */
  private softened = new Set<string>();

  private readonly now: () => number;
  private readonly dispatchTimeoutMs: number;
  private readonly stallTicksBeforeContinuation: number;
  private readonly maxAngleCycles: number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 35_000;
    this.stallTicksBeforeContinuation = options.stallTicksBeforeContinuation ?? 3;
    this.maxAngleCycles = options.maxAngleCycles ?? 2;
  }

  get currentBlotId(): string | null {
    return this.inFlight?.destination.blotId ?? null;
  }

  get pending(): number {
    return this.awaitingDispatch ? 1 : 0;
  }

  get waitingForDispatchSince(): number {
    return this.awaitingDispatch ? this.lastSentAt : 0;
  }

  get moodShiftQueued(): boolean {
    return this.pendingMoodShift !== null;
  }

  /** The destination sequence for a blot: itself, then each angle view. */
  destinationsFor(blot: BlotJob): Destination[] {
    const destinations: Destination[] = [];
    const hasArrival = blot.url !== undefined;
    destinations.push({
      blotId: blot.id,
      url: hasArrival ? blot.url! : null,
      cameraMoveId: null,
      label: blot.reading?.subject ?? 'the blot',
      index: 0,
    });
    for (const take of blot.angles) {
      if (take.state !== 'ready' || !take.arrivalFrameUrl) continue;
      destinations.push({
        blotId: blot.id,
        url: take.arrivalFrameUrl,
        cameraMoveId: take.move,
        label: `${blot.reading?.subject ?? 'the blot'} from ${CAMERA_MOVES[take.move]?.label ?? take.move}`,
        index: destinations.length,
      });
    }
    return destinations;
  }

  /** Queues a mood change into the next direction. Never opens a new session. */
  notifyMoodChanged(previous: MoodPreset): string | null {
    const episode = this.options.readEpisode();
    const text = composeMoodShift({
      from: previous,
      to: episode.mood,
      strength: episode.moodStrength,
      palette: episode.palette,
    });
    this.pendingMoodShift = text;
    return text;
  }

  clearMoodShift(): void {
    this.pendingMoodShift = null;
  }

  /** A chunk arrived: this is both the dispatch clock and the arrival signal. */
  onChunk(chunk: ChunkInfo): void {
    if (this.inFlight && chunk.promptVersion >= this.inFlight.promptVersion) {
      const { destination } = this.inFlight;
      if (destination.blotId !== CONTINUATION) {
        this.options.rail.markLive(destination.blotId);
        this.options.events?.onBlotAirborne?.({ blotId: destination.blotId, chunkIndex: chunk.chunkIndex });
      }
      this.inFlight = null;
      this.awaitingDispatch = false;
    } else {
      this.checkDispatchTimeout();
    }
    this.tick();
  }

  /**
   * Reopens the dispatch gate when a direction was never confirmed.
   *
   * A chunk that never arrives cannot be noticed from inside `onChunk`, and a
   * session that fails to generate one still has a film to run, so this is
   * called on the studio's heartbeat as well as on every late chunk. Returns
   * true when the gate was actually reopened.
   */
  checkDispatchTimeout(): boolean {
    if (!this.awaitingDispatch || !this.inFlight) return false;
    if (this.now() - this.inFlight.sentAt <= this.dispatchTimeoutMs) return false;
    this.options.events?.onWarning?.(
      `no chunk confirmed prompt version ${this.inFlight.promptVersion} within ${this.dispatchTimeoutMs}ms; reopening the dispatch gate`,
    );
    this.inFlight = null;
    this.awaitingDispatch = false;
    return true;
  }

  onPromptRejected(info: { promptVersion: number; reason: string; error?: string | null }): void {
    if (!this.inFlight || info.promptVersion !== this.inFlight.promptVersion) return;
    const retryable = info.reason === 'queue_full' || info.reason === 'preparation_failed' || info.reason === 'infeasible_timing';
    if (retryable && this.inFlight.retries < 2) {
      this.inFlight.retries += 1;
      this.inFlight = null;
      this.awaitingDispatch = false;
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (info.reason === 'content_policy') {
      // the film cannot pause for a rejected idea: soften once, then drop the
      // blot. The flag is tracked rather than sniffed out of the prompt text,
      // because softening appends to the prompt rather than replacing it.
      const blotId = this.inFlight.destination.blotId;
      const blot = this.options.rail.find(blotId);
      if (blot?.reading && !this.softened.has(blotId)) {
        this.softened.add(blotId);
        blot.reading = { ...blot.reading, prompt: softenDirection(blot.reading.prompt) };
        this.inFlight = null;
        this.awaitingDispatch = false;
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      }
    }
    this.options.events?.onWarning?.(`direction rejected (${info.reason}); retiring the blot`);
    this.retire(this.inFlight.destination.blotId);
    this.inFlight = null;
    this.awaitingDispatch = false;
  }

  /** Sends the next destination if the film is ready for one. */
  tick(): void {
    const session = this.options.session;
    if (session.status !== 'live') return;
    if (this.awaitingDispatch || this.inFlight) return;
    this.advance();
    const blot = this.currentBlot();
    if (!blot) {
      this.emptyTicks += 1;
      if (this.pendingMoodShift || this.emptyTicks >= this.stallTicksBeforeContinuation) this.sendContinuation();
      return;
    }
    this.emptyTicks = 0;
    const destinations = this.destinationsFor(blot);
    // a ready blot always yields at least itself, so there is always a target
    const destination = destinations[Math.min(this.cursor, destinations.length - 1)];
    if (!destination) return;
    this.send(destination, blot);
  }

  /** Moves past a blot whose whole sequence has been aired. */
  private advance(): void {
    const blot = this.currentBlot();
    if (!blot) return;
    const destinations = this.destinationsFor(blot);
    if (this.cursor < destinations.length) return;
    const angleViews = destinations.length - 1;
    if (this.options.readEpisode().camera.repeatAngleCycle && angleViews > 0 && this.cycles < this.maxAngleCycles) {
      this.cycles += 1;
      this.cursor = 1; // re-enter the orbit rather than repeating the blot itself
      return;
    }
    this.retire(blot.id);
  }

  private retire(blotId: string): void {
    if (blotId === CONTINUATION || this.retired.has(blotId)) return;
    this.retired.add(blotId);
    this.options.rail.markPassed(blotId);
    this.options.events?.onBlotRetired?.({ blotId });
    this.held = null;
    this.cursor = 0;
    this.cycles = 0;
  }

  private held: BlotJob | null = null;

  private currentBlot(): BlotJob | null {
    if (this.held && this.held.state !== 'passed' && this.held.state !== 'failed') return this.held;
    const next = this.options.rail.next();
    if (!next) {
      this.held = null;
      return null;
    }
    if (this.held?.id !== next.id) {
      this.cursor = 0;
      this.cycles = 0;
    }
    this.held = next;
    return next;
  }

  /** Sends a direction with no arrival image: the film keeps its own momentum. */
  private sendContinuation(): void {
    const episode = this.options.readEpisode();
    const shift = this.pendingMoodShift;
    const prompt = shift ?? `Continue the same take. ${episode.mood.lead} ${PRESERVE_CLAUSE} ${episode.music.accent}.`;
    // A continuation goes out for two different reasons: the rail is empty, or a
    // mood change is riding along in the direction. Only the first is a stall -
    // the second is the user's own doing, on a rail that may be perfectly full -
    // and reporting it as one told people the rail had run dry when it had not.
    if (this.emptyTicks >= this.stallTicksBeforeContinuation) {
      this.options.events?.onStall?.({ emptyTicks: this.emptyTicks });
    }
    const version = this.options.session.direct({ prompt, replan: true });
    this.pendingMoodShift = null;
    this.emptyTicks = 0;
    this.lastSentAt = this.now();
    this.awaitingDispatch = true;
    this.inFlight = {
      destination: { blotId: CONTINUATION, url: null, cameraMoveId: null, label: 'continuation', index: 0 },
      promptVersion: version,
      sentAt: this.lastSentAt,
      retries: 0,
    };
  }

  private send(destination: Destination, blot: BlotJob): void {
    const episode = this.options.readEpisode();
    const camera = destination.cameraMoveId ? CAMERA_MOVES[destination.cameraMoveId] ?? null : null;
    const shift = this.pendingMoodShift;
    const body = composeDirection({
      reading: blot.reading ?? {
        subject: destination.label, prompt: '', transition: '', moodTags: [], sound: '', structured: false,
      },
      mood: episode.mood,
      music: episode.music,
      camera,
      moodStrength: episode.moodStrength,
      arrivalMode: episode.arrivalMode,
      palette: blot.recipe.palette,
    });
    const prompt = shift ? `${shift} ${body}` : body;
    const version = this.options.session.direct({
      prompt,
      // 'soft' describes the blot without pinning the final frame to it
      endImageUrl: episode.arrivalMode === 'hard' ? destination.url : null,
      replan: true,
    });
    this.pendingMoodShift = null;
    this.lastSentAt = this.now();
    this.awaitingDispatch = true;
    this.inFlight = { destination, promptVersion: version, sentAt: this.lastSentAt, retries: 0 };
    this.cursor += 1;
    // Only a blot that has not yet gone to air is 'scheduled'; once its first
    // view has landed it stays 'live' while its remaining views are sent.
    if (this.options.rail.find(blot.id)?.state === 'ready') {
      this.options.rail.markScheduled(blot.id, this.options.session.chunkIndex);
    }
    this.options.events?.onDestination?.({
      destination,
      promptVersion: version,
      chunkIndex: this.options.session.chunkIndex,
    });
  }

  /**
   * Adopts the blot that already opened the session.
   *
   * Its own image is the session's first frame, so the film starts *inside*
   * that blot and the first thing to arrive is a view of it from elsewhere.
   */
  beginWith(blot: BlotJob): void {
    this.held = blot;
    this.cursor = 1;
    this.cycles = 0;
    this.retired.delete(blot.id);
    this.options.rail.markLive(blot.id);
  }

  /** Moves on from the current blot immediately, at the next opportunity. */
  releaseCurrent(): void {
    const blot = this.held;
    if (!blot) return;
    this.cursor = this.destinationsFor(blot).length;
    this.cycles = this.maxAngleCycles;
    this.retire(blot.id);
    this.tick();
  }

  reset(): void {
    this.cursor = 0;
    this.cycles = 0;
    this.inFlight = null;
    this.awaitingDispatch = false;
    this.emptyTicks = 0;
    this.pendingMoodShift = null;
    this.held = null;
    this.retired.clear();
    this.softened.clear();
  }
}
