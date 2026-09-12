import type { CameraConfig, CameraMoveId } from '../presets/camera';
import type { MoodPreset } from '../presets/moods';
import type { MusicPreset } from '../presets/music';
import type { InkRecipe } from '../ink/types';
import { recipeKey } from '../ink/recipe';
import { paintShowMs, type PaintFrame } from '../ink/paintReel';
import type { BlotReading } from './reading';

export type BlotState =
  | 'invented'
  | 'rendered'
  | 'uploaded'
  | 'interpreted'
  | 'ready'
  | 'scheduled'
  | 'live'
  | 'passed'
  | 'failed';

export interface AngleTake {
  id: string;
  blotId: string;
  move: CameraMoveId;
  seed: number;
  state: 'pending' | 'generating' | 'extracting' | 'ready' | 'failed';
  videoUrl?: string;
  /** The held final pose, used as a Director destination. */
  arrivalFrameUrl?: string;
  error?: string;
  costUsd: number;
}

export interface BlotJob {
  id: string;
  recipe: InkRecipe;
  recipeKey: string;
  state: BlotState;
  /** Hand-painted rather than invented. */
  handmade: boolean;
  attempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  blob?: Blob;
  /** Small preview for the rail. */
  thumbDataUri?: string;
  /** Full-quality data URI handed to the vision model. */
  visionDataUri?: string;
  /**
   * The blot's own painting, a beat at a time, so the rail can show it being
   * made. Dropped once its show has run, because the frames are only of use
   * while they are playing.
   */
  paint?: PaintFrame[];
  /** When that show ends. A blot whose painting is still at this moment is painting. */
  showUntil?: number;
  /** fal storage URL used as `image_url` / `end_image_url`. */
  url?: string;
  reading?: BlotReading;
  angles: AngleTake[];
  /** Which chunk of the film this blot was dispatched on. */
  dispatchedAtChunk?: number;
}

/** Callbacks the rail needs. Everything external is injected, so it is testable. */
export interface RailPorts {
  invent(seed: number): InkRecipe;
  render(recipe: InkRecipe): Promise<{
    blob: Blob;
    thumbDataUri: string;
    visionDataUri: string;
    paint?: PaintFrame[];
  }>;
  upload(blob: Blob, name: string): Promise<string>;
  interpret(args: {
    blot: BlotJob;
    mood: MoodPreset;
    music: MusicPreset;
    cameraMoveId: CameraMoveId | null;
    previousPrompts: string[];
    beatIndex: number;
  }): Promise<BlotReading>;
  generateAngle(args: { blot: BlotJob; move: CameraMoveId; seed: number }): Promise<{ videoUrl: string }>;
  extractArrivalFrame(videoUrl: string): Promise<Blob>;
  readEpisode(): { mood: MoodPreset; music: MusicPreset; camera: CameraConfig; moodStrength: number; palette: readonly string[] };
  now(): number;
  nextId(prefix: string): string;
  /** Fresh seed for a newly invented blot. */
  nextSeed(): number;
  angleCostUsd(seconds: number, resolution: string): number;
}

export interface RailOptions {
  /** Ready blots to keep ahead of the stream. */
  preparedTarget: number;
  /** Hard ceiling so a stalled rail cannot pile up unbounded work. */
  maxJobs: number;
  /** Vision calls that may be in flight at once. */
  interpretConcurrency: number;
  /** Multi Angle clips that may be in flight at once. */
  angleConcurrency: number;
  /** Stage attempts before a blot is dropped. */
  maxAttempts: number;
  /**
   * Whether the rail paces itself by the paintings it is showing.
   *
   * On, a blot is invented only once the one before it has finished playing on
   * the rail, so the pre-flight reads as a sequence of paintings rather than a
   * batch of cards appearing at once. Off, the rail fills as fast as its ports
   * allow - and nothing is paced by a painting that has no frames to show.
   */
  showPainting: boolean;
}

/**
 * The stage the film is waiting on, named for what the rail is doing rather than
 * for the state a blot happens to sit in.
 */
export type RailStage = 'painting' | 'hosting' | 'imagining' | 'shooting' | 'ready' | 'stalled';

/**
 * What the pre-flight is waiting for.
 *
 * A run opens no session until the rail holds `preparedTarget` ready blots, and
 * that pipeline is slow - a render, an upload, a vision call and two orbit takes
 * per blot. Derived on demand so the overlay can be refreshed on a timer without
 * the rail having to announce anything.
 */
export interface RailProgress {
  target: number;
  ready: number;
  /** Invented, painted, hosted or imagined - not finished, not dropped. */
  working: number;
  failed: number;
  anglesReady: number;
  anglesWanted: number;
  /** The least-finished live blot: the one actually gating the start. */
  stage: RailStage;
}

export const DEFAULT_RAIL_OPTIONS: RailOptions = {
  preparedTarget: 3,
  maxJobs: 8,
  interpretConcurrency: 2,
  angleConcurrency: 2,
  maxAttempts: 2,
  showPainting: false,
};

/** What each pre-session state means for the person waiting on it. */
const STAGE_BY_STATE: Partial<Record<BlotState, RailStage>> = {
  invented: 'painting',
  rendered: 'hosting',
  uploaded: 'imagining',
  interpreted: 'shooting',
  ready: 'ready',
};

/** Cheapest first, so the first state still in play is the gating one. */
const STAGE_ORDER: BlotState[] = ['invented', 'rendered', 'uploaded', 'interpreted', 'ready'];

/**
 * The blot rail. It invents blots, renders and uploads them, asks the vision
 * model what each one could be, and builds a small set of consistent camera
 * angles for each. Everything happens ahead of the stream so the scheduler
 * never waits on it.
 *
 * The rail never blocks: a blot that fails repeatedly is dropped and the rail
 * invents another one, because a live film cannot pause to fix a picture.
 */
export class BlotRail {
  private jobs: BlotJob[] = [];
  /**
   * In-flight readings, not resolved ones: two blots sharing a recipe must
   * await the same vision call rather than racing two of them.
   */
  private readingsByRecipe = new Map<string, Promise<BlotReading>>();
  private pumping = false;
  private interpretInFlight = 0;
  private angleInFlight = 0;
  private invented = 0;

  constructor(
    private readonly ports: RailPorts,
    private readonly options: RailOptions = DEFAULT_RAIL_OPTIONS,
  ) {}

  get all(): readonly BlotJob[] {
    return this.jobs;
  }

  get ready(): BlotJob[] {
    return this.jobs.filter((job) => job.state === 'ready');
  }

  /**
   * Ready blots the rail is asked to hold ahead of the film.
   *
   * The pre-flight waits for this many before it opens a paid session, so it is
   * the size of the buffer the film starts on.
   */
  get target(): number {
    return this.options.preparedTarget;
  }

  get failedCount(): number {
    return this.jobs.filter((job) => job.state === 'failed').length;
  }

  /**
   * How far the pre-flight has got. Pure derived state: nothing to subscribe to,
   * so the studio can poll it on a timer while `pump()` is mid-flight.
   */
  get progress(): RailProgress {
    const camera = this.ports.readEpisode().camera;
    const perBlot = camera.enabled ? Math.max(0, Math.min(4, camera.anglesPerBlot)) : 0;
    const live = this.jobs.filter((job) => job.state !== 'passed' && job.state !== 'failed');
    const gatingState = STAGE_ORDER.find((state) => live.some((job) => job.state === state));
    return {
      target: this.options.preparedTarget,
      ready: live.filter((job) => job.state === 'ready').length,
      working: live.filter((job) => job.state !== 'ready').length,
      failed: this.failedCount,
      anglesReady: live.reduce(
        (sum, job) => sum + job.angles.filter((take) => take.state === 'ready').length,
        0,
      ),
      anglesWanted: perBlot * live.length,
      // nothing live and nothing dropped yet means the rail is about to invent
      stage: gatingState ? STAGE_BY_STATE[gatingState]! : this.failedCount > 0 ? 'stalled' : 'painting',
    };
  }

  find(id: string): BlotJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  /** Prompts of beats already dispatched, oldest first: the film's memory. */
  history(limit: number): string[] {
    return this.jobs
      .filter((job) => job.reading && (job.state === 'scheduled' || job.state === 'live' || job.state === 'passed'))
      .map((job) => job.reading!.prompt)
      .slice(-limit);
  }

  /** Adds a hand-painted blot, ahead of the invented ones. */
  adopt(recipe: InkRecipe, thumbDataUri?: string, blob?: Blob): BlotJob {
    const job: BlotJob = {
      id: this.ports.nextId('blot'),
      recipe,
      recipeKey: recipeKey(recipe),
      state: blob ? 'rendered' : 'invented',
      handmade: true,
      attempts: 0,
      createdAt: this.ports.now(),
      updatedAt: this.ports.now(),
      blob,
      thumbDataUri,
      angles: [],
    };
    this.jobs.unshift(job);
    // a hand-painted blot jumps the queue
    this.jobs.sort((a, b) => Number(b.handmade) - Number(a.handmade) || a.createdAt - b.createdAt);
    return job;
  }

  /** The next blot the film should arrive at, if one is ready. */
  next(): BlotJob | undefined {
    return this.jobs.find((job) => job.state === 'ready');
  }

  markScheduled(id: string, chunkIndex: number): void {
    const job = this.find(id);
    if (!job) return;
    job.state = 'scheduled';
    job.dispatchedAtChunk = chunkIndex;
    job.updatedAt = this.ports.now();
  }

  markLive(id: string): void {
    const job = this.find(id);
    if (!job) return;
    job.state = 'live';
    job.updatedAt = this.ports.now();
  }

  markPassed(id: string): void {
    const job = this.find(id);
    if (!job) return;
    job.state = 'passed';
    job.updatedAt = this.ports.now();
  }

  /** True while a dispatched blot's destination is still ahead of the film. */
  takeDispatched(limit: number): BlotJob[] {
    return this.jobs.filter((job) => job.state === 'scheduled').slice(0, limit);
  }

  reset(): void {
    this.jobs = [];
    this.readingsByRecipe.clear();
    this.invented = 0;
  }

  /**
   * Drops every blot that never made it to the screen.
   *
   * A run that ends - at a cap, on a failure, at the user's stop - leaves the
   * rail holding blots that were mid-pipeline: a render nobody will upload, a
   * vision call nobody is waiting for. They are not history, they are the
   * leavings of a stopped run, and a card still reading "waiting for the vision
   * model" after the film is over claims work that is not happening. Anything
   * the film actually arrived at - or could still arrive at - is kept, because
   * that is what the run made.
   */
  abandonUnfinished(): void {
    this.jobs = this.jobs.filter((job) =>
      job.state === 'ready' || job.state === 'scheduled' || job.state === 'live' || job.state === 'passed');
  }

  /** Set by the plan-ahead scheduler so cached readings are not re-used across films. */
  forgetReadings(): void {
    this.readingsByRecipe.clear();
  }

  /**
   * Advances every job one step and tops the rail up to its target. Safe to call
   * repeatedly: overlapping calls are folded into the one already running.
   */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.dropSpentReels();
      this.fill();
      const work = this.jobs.map((job) => this.advance(job));
      await Promise.all(work);
    } finally {
      this.pumping = false;
    }
  }

  /** Invent more blots until the rail holds `preparedTarget` prepared-or-coming. */
  private fill(): void {
    const inFlight = this.jobs.filter((job) => job.state !== 'passed' && job.state !== 'failed').length;
    let needed = this.options.preparedTarget - inFlight;
    // When the rail is showing the paintings, one blot at a time is the whole
    // point: the next is invented only after the last one's ink has been on
    // screen. Everything the rail waits on downstream (hosting, the vision
    // call, the orbits) still overlaps across blots, so this paces the show
    // rather than the pipeline.
    if (this.options.showPainting) {
      if (this.painting()) return;
      needed = Math.min(needed, 1);
    }
    for (let i = 0; i < needed; i++) {
      if (inFlight + i >= this.options.maxJobs) break;
      const recipe = this.ports.invent(this.ports.nextSeed());
      this.jobs.push({
        id: this.ports.nextId('blot'),
        recipe,
        recipeKey: recipeKey(recipe),
        state: 'invented',
        handmade: false,
        attempts: 0,
        createdAt: this.ports.now(),
        updatedAt: this.ports.now(),
        angles: [],
      });
      this.invented++;
    }
    this.jobs.sort((a, b) => Number(b.handmade) - Number(a.handmade) || a.createdAt - b.createdAt);
  }

  /** True while a blot is being painted, or its painting is still on screen. */
  private painting(): boolean {
    const now = this.ports.now();
    return this.jobs.some((job) =>
      job.state === 'invented'
      || (job.paint !== undefined && job.showUntil !== undefined && now < job.showUntil));
  }

  /** Forgets the frames whose show has finished: a reel is only of use while it plays. */
  private dropSpentReels(): void {
    const now = this.ports.now();
    for (const job of this.jobs) {
      if (job.paint !== undefined && job.showUntil !== undefined && now >= job.showUntil) delete job.paint;
    }
  }

  private async advance(job: BlotJob): Promise<void> {
    switch (job.state) {
      case 'invented':
        await this.step(job, async () => {
          const rendered = await this.ports.render(job.recipe);
          job.blob = rendered.blob;
          job.thumbDataUri = rendered.thumbDataUri;
          job.visionDataUri = rendered.visionDataUri;
          job.paint = rendered.paint;
          // the show starts when the frames reach the screen, which is the next
          // emit to the shell, so its clock is stamped here rather than in the view
          job.showUntil = rendered.paint && rendered.paint.length > 0
            ? this.ports.now() + paintShowMs(rendered.paint)
            : undefined;
        }, 'rendered');
        break;
      case 'rendered':
        await this.step(job, async () => {
          if (!job.blob) throw new Error('rendered blot has no blob');
          job.url = await this.ports.upload(job.blob, `${job.recipeKey}.png`);
        }, 'uploaded');
        break;
      case 'uploaded':
        if (this.interpretInFlight >= this.options.interpretConcurrency) return;
        await this.step(job, async () => {
          job.reading = await this.readFor(job);
        }, 'interpreted', 'interpret');
        break;
      case 'interpreted':
        await this.buildAngles(job);
        break;
      default:
        break;
    }
  }

  private readyReadings(): string[] {
    return this.ready.map((job) => job.reading?.prompt ?? '').filter((text) => text !== '');
  }

  /** The blot's reading, shared with any other blot of the same recipe. */
  private readFor(job: BlotJob): Promise<BlotReading> {
    const existing = this.readingsByRecipe.get(job.recipeKey);
    if (existing) return existing;
    const episode = this.ports.readEpisode();
    const moves = episode.camera.enabled ? episode.camera.moves : [];
    const moveId = moves.length > 0 ? moves[job.angles.length % moves.length] : null;
    let promise!: Promise<BlotReading>;
    promise = this.ports.interpret({
      blot: job,
      mood: episode.mood,
      music: episode.music,
      cameraMoveId: moveId,
      previousPrompts: [...this.history(6), ...this.readyReadings()],
      beatIndex: this.history(50).length,
    }).catch((error: unknown) => {
      // never cache a failure: the next attempt must be able to try again
      if (this.readingsByRecipe.get(job.recipeKey) === promise) this.readingsByRecipe.delete(job.recipeKey);
      throw error;
    });
    this.readingsByRecipe.set(job.recipeKey, promise);
    return promise;
  }

  /** Builds the blot's consistent multi-view set, then marks it ready. */
  private async buildAngles(job: BlotJob): Promise<void> {
    const episode = this.ports.readEpisode();
    const camera = episode.camera;
    const wanted = camera.enabled ? Math.max(0, Math.min(4, camera.anglesPerBlot)) : 0;
    const moves = camera.moves.length > 0 ? camera.moves : [];
    while (job.angles.length < wanted && moves.length > 0) {
      const move = moves[job.angles.length % moves.length]!;
      job.angles.push({
        id: this.ports.nextId('angle'),
        blotId: job.id,
        move,
        seed: (job.recipe.seed + job.angles.length * 7919) >>> 0,
        state: 'pending',
        costUsd: this.ports.angleCostUsd(camera.duration, camera.resolution),
      });
    }
    const pending = job.angles.filter((take) => take.state === 'pending' || take.state === 'failed');
    await Promise.all(pending.map((take) => this.advanceAngle(job, take)));
    const settled = job.angles.every((take) => take.state === 'ready' || take.state === 'failed');
    if (!settled) return;
    if (!job.url || !job.reading) {
      job.state = 'failed';
      return;
    }
    // A failed orbit degrades instead of blocking: the film simply arrives at
    // the blot itself rather than at one of its camera angles.
    if (job.angles.every((take) => take.state === 'failed')) job.angles = [];
    job.state = 'ready';
    job.updatedAt = this.ports.now();
  }

  private async advanceAngle(job: BlotJob, take: AngleTake): Promise<void> {
    if (this.angleInFlight >= this.options.angleConcurrency) return;
    if (take.state === 'failed') return; // already spent its attempts
    this.angleInFlight++;
    take.state = 'generating';
    try {
      const created = await this.ports.generateAngle({ blot: job, move: take.move, seed: take.seed });
      take.videoUrl = created.videoUrl;
      take.state = 'extracting';
      const frame = await this.ports.extractArrivalFrame(created.videoUrl);
      take.arrivalFrameUrl = await this.ports.upload(frame, `${job.recipeKey}-${take.move}.png`);
      take.state = 'ready';
    } catch (error) {
      take.state = 'failed';
      take.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.angleInFlight--;
      job.updatedAt = this.ports.now();
    }
  }

  /** Runs one stage, counting attempts and dropping the blot when it gives up. */
  private async step(
    job: BlotJob,
    run: () => Promise<void>,
    onSuccess: BlotState,
    kind: 'interpret' | 'stage' = 'stage',
  ): Promise<void> {
    if (kind === 'interpret') this.interpretInFlight++;
    try {
      await run();
      job.state = onSuccess;
      job.attempts = 0;
      job.error = undefined;
    } catch (error) {
      job.attempts++;
      job.error = error instanceof Error ? error.message : String(error);
      if (job.attempts >= this.options.maxAttempts) job.state = 'failed';
    } finally {
      if (kind === 'interpret') this.interpretInFlight--;
      job.updatedAt = this.ports.now();
    }
  }
}
