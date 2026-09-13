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
  /** The move the blot's shot is asked for, from the take prepared for it. */
  cameraMoveId: CameraMoveId | null;
  label: string;
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
 * How many times an unconfirmed destination is sent again before the film gives
 * up on it.
 *
 * A direction nobody confirms - because the chunk that would have carried its
 * version never arrived, or the acknowledgement was lost - used to be dropped,
 * and the blot it was heading into was retired unvisited: the film simply kept
 * moving and the picture never arrived anywhere. One re-send costs a bounded
 * wait and saves the film's arrival.
 */
export const MAX_REDISPATCH = 1;

/**
 * Turns the blot rail into the film's next moment.
 *
 * One blot is one chunk: the film arrives at the photograph the imagining made
 * of it, holds that for the chunk and moves on to the next blot. The blot's
 * camera take does not extend its screen time - it is taken around the scene to
 * give this one shot its camera move - because a blot held for three chunks is
 * half a minute of film spent on one idea.
 *
 * One destination lands per dispatched chunk. Because a direction applies to the
 * next *undispatched* chunk, the scheduler opens its gate only when a chunk
 * arrives carrying the version it last sent - otherwise a burst of directions
 * would collapse into the last one and blots would silently vanish.
 */
export class BlotScheduler {
  private cursor = 0;
  private inFlight: InFlight | null = null;
  /** A destination whose direction was never confirmed, waiting to go again. */
  private redispatch: { destination: Destination; attempts: number } | null = null;
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

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 35_000;
    this.stallTicksBeforeContinuation = options.stallTicksBeforeContinuation ?? 3;
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

  /**
   * The destination for a blot: the photograph the imagining made of it.
   *
   * The blot itself is never the destination: the film arrives at the photograph
   * the imagining made of it, because a blot handed to the video model is a
   * painting the model then animates. The camera move is the one rolled for this
   * blot, so the shot, the reading and the take shot for it all agree.
   */
  destinationsFor(blot: BlotJob): Destination[] {
    return [{
      blotId: blot.id,
      url: blot.imaginedUrl ?? blot.url ?? null,
      cameraMoveId: blot.cameraMove ?? null,
      label: blot.reading?.subject ?? 'the blot',
    }];
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
   *
   * The destination is re-sent rather than abandoned: the film's arrival at its
   * blot is the beat, and moving straight on to the next blot would leave the
   * picture with nowhere it was asked to go.
   */
  checkDispatchTimeout(): boolean {
    if (!this.awaitingDispatch || !this.inFlight) return false;
    const { destination, retries, promptVersion } = this.inFlight;
    if (this.now() - this.inFlight.sentAt <= this.dispatchTimeoutMs) return false;
    this.inFlight = null;
    this.awaitingDispatch = false;
    // a continuation has no blot to arrive at, and a blot the rail has already
    // let go of cannot be sent again
    const sendable = destination.blotId !== CONTINUATION && retries < MAX_REDISPATCH;
    if (sendable && this.options.rail.find(destination.blotId)) {
      this.redispatch = { destination, attempts: retries + 1 };
      this.options.events?.onWarning?.(
        `no chunk confirmed prompt version ${promptVersion} within ${this.dispatchTimeoutMs}ms; sending the direction for ${destination.label} again`,
      );
      return true;
    }
    this.options.events?.onWarning?.(
      `no chunk confirmed prompt version ${promptVersion} within ${this.dispatchTimeoutMs}ms; reopening the dispatch gate`,
    );
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
    // a direction that went unconfirmed goes again before anything new does:
    // the blot it is heading into is still the film's next arrival
    if (this.redispatch) {
      const pending = this.redispatch;
      this.redispatch = null;
      const blot = this.options.rail.find(pending.destination.blotId);
      if (blot && blot.state !== 'passed' && blot.state !== 'failed') {
        this.send(pending.destination, blot, { advance: false, retries: pending.attempts });
        return;
      }
    }
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

  /** Moves past a blot whose chunk has been aired. */
  private advance(): void {
    const blot = this.currentBlot();
    if (!blot) return;
    if (this.cursor < this.destinationsFor(blot).length) return;
    this.retire(blot.id);
  }

  private retire(blotId: string): void {
    // a blot that is gone cannot be the place the film is still heading
    if (this.redispatch?.destination.blotId === blotId) this.redispatch = null;
    if (blotId === CONTINUATION || this.retired.has(blotId)) return;
    this.retired.add(blotId);
    this.options.rail.markPassed(blotId);
    this.options.events?.onBlotRetired?.({ blotId });
    this.held = null;
    this.cursor = 0;
  }

  private held: BlotJob | null = null;

  private currentBlot(): BlotJob | null {
    if (this.held && this.held.state !== 'passed' && this.held.state !== 'failed') return this.held;
    const next = this.options.rail.next();
    if (!next) {
      this.held = null;
      return null;
    }
    if (this.held?.id !== next.id) this.cursor = 0;
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
      destination: { blotId: CONTINUATION, url: null, cameraMoveId: null, label: 'continuation' },
      promptVersion: version,
      sentAt: this.lastSentAt,
      retries: 0,
    };
  }

  private send(destination: Destination, blot: BlotJob, options: { advance?: boolean; retries?: number } = {}): void {
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
    this.inFlight = { destination, promptVersion: version, sentAt: this.lastSentAt, retries: options.retries ?? 0 };
    // a re-sent direction is heading for a blot the cursor has already moved
    // past, and counting it again would retire the blot a second time
    if (options.advance !== false) this.cursor += 1;
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
   * that blot and the first thing to arrive is the next blot's photograph: the
   * opening blot has already had its chunk before the session opened.
   */
  beginWith(blot: BlotJob): void {
    this.held = blot;
    this.cursor = 1;
    this.retired.delete(blot.id);
    this.options.rail.markLive(blot.id);
  }

  /** Moves on from the current blot immediately, at the next opportunity. */
  releaseCurrent(): void {
    const blot = this.held;
    if (!blot) return;
    this.cursor = this.destinationsFor(blot).length;
    this.retire(blot.id);
    this.tick();
  }

  reset(): void {
    this.cursor = 0;
    this.inFlight = null;
    this.redispatch = null;
    this.awaitingDispatch = false;
    this.emptyTicks = 0;
    this.pendingMoodShift = null;
    this.held = null;
    this.retired.clear();
    this.softened.clear();
  }
}
