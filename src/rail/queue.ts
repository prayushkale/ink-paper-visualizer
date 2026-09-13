import type { CameraConfig, CameraMoveId } from '../presets/camera';
import { cameraMoveForSeed } from '../presets/camera';
import type { MoodPreset } from '../presets/moods';
import type { MusicPreset } from '../presets/music';
import type { InkRecipe } from '../ink/types';
import { recipeKey } from '../ink/recipe';
import type { BlotReading } from './reading';

/**
 * How long an ink blot is held on screen before what was made of it takes over.
 *
 * The blot is a reference, not a picture: it is shown for a beat - the card on
 * the rail, the still over the film as the picture arrives at it - and then the
 * photograph the imagining made of it is what the film is. Long enough to be
 * looked at, short enough to read as a flash rather than as a shot.
 */
export const BLOT_HOLD_MS = 600;

export type BlotState =
  | 'invented'
  | 'rendered'
  | 'uploaded'
  | 'interpreted'
  /** Realised as a photograph by the image model; the film opens on this, not the blot. */
  | 'imagined'
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
  /** Small preview for the rail: the ink blot itself. */
  thumbDataUri?: string;
  /** Full-quality data URI handed to the vision model. */
  visionDataUri?: string;
  /** When this blot's own picture is held on the rail, then handed over. */
  inkUntil?: number;
  /** fal storage URL used as `image_url` / `end_image_url`. */
  url?: string;
  /**
   * The photograph the image model made of this blot. This is the picture the
   * film opens inside and arrives at; the blot itself is only ever a reference.
   */
  imaginedUrl?: string;
  reading?: BlotReading;
  /**
   * The camera move rolled for this blot, or undefined for the four in five
   * that get none.
   *
   * Stamped when the blot is invented so the reading the vision model writes, the
   * take shot around the photograph and the direction the film is handed all
   * agree on one move. Roughly one blot in five wins the roll, at random, and the
   * move itself is drawn from the whole set - so the film's shots vary instead of
   * walking a fixed cycle.
   */
  cameraMove?: CameraMoveId;
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
  /**
   * Realises the blot as the photograph the film will be made of. Optional: a
   * rail with no image model falls back to handing the blot itself over, which
   * is what every run did before the imagining existed.
   */
  imagine?(args: {
    blot: BlotJob;
    mood: MoodPreset;
    music: MusicPreset;
    aspectRatio: '16:9' | '9:16' | '1:1';
  }): Promise<{ url: string }>;
  generateAngle(args: { blot: BlotJob; move: CameraMoveId; seed: number; imageUrl: string }): Promise<{ videoUrl: string }>;
  extractArrivalFrame(videoUrl: string): Promise<Blob>;
  readEpisode(): { mood: MoodPreset; music: MusicPreset; camera: CameraConfig; moodStrength: number; palette: readonly string[] };
  now(): number;
  nextId(prefix: string): string;
  /** Fresh seed for a newly invented blot. */
  nextSeed(): number;
  /** What one orbit clip costs at the run's own resolution and clip length. */
  angleCostUsd(): number;
}

export interface RailOptions {
  /**
   * Ready blots to keep ahead of the stream.
   *
   * One blot is one chunk, so the film eats a blot every ten seconds and nothing
   * else makes them. This is headroom rather than a queue: twenty finished blots
   * is a little over three minutes of film in hand, four ready and waiting for
   * every one the film is using.
   */
  preparedTarget: number;
  /**
   * Hard ceiling on blots on the rail at once, so a stalled rail cannot pile up
   * unbounded work.
   *
   * It has to leave room above the buffer: a blot is only *ready* at the end of
   * five stages, so the buffer is held up by blots still walking them - size
   * this to the buffer alone and the rail can never hold the number it was asked
   * for, and the pre-flight waits for a buffer that will not arrive.
   */
  maxJobs: number;
  /**
   * Blot sheets that may be painted at once.
   *
   * Painting is canvas work on the same thread the film plays on, so this is the
   * one gate here that protects playback rather than an upstream service: twenty
   * sheets painted at once would stall the page the film is playing on.
   */
  renderConcurrency: number;
  /**
   * Vision calls that may be in flight at once.
   *
   * One call per blot, and the slowest stage by a wide margin - tens of seconds
   * against the film's ten - so this is what the rail's throughput actually is.
   * It is deliberately several times the rate the film consumes: the buffer can
   * only fill as fast as this admits calls.
   */
  interpretConcurrency: number;
  /**
   * Imaginings that may be in flight at once. Each one is several seconds of
   * image generation, so this is what keeps a deep enough buffer of finished
   * stills ahead of the film rather than one blot landing at a time.
   */
  imagineConcurrency: number;
  /** Multi Angle clips that may be in flight at once. */
  angleConcurrency: number;
  /** Stage attempts before a blot is dropped. */
  maxAttempts: number;
}

/**
 * The stage the film is waiting on, named for what the rail is doing rather than
 * for the state a blot happens to sit in.
 */
export type RailStage = 'painting' | 'hosting' | 'imagining' | 'realising' | 'shooting' | 'ready' | 'stalled';

/**
 * What the pre-flight is waiting for.
 *
 * A run opens no session until the rail holds `preparedTarget` ready blots, and
 * a blot is only ready at the end of a render, an upload, a vision call and an
 * imagining. Derived on demand so the overlay can be refreshed on a timer
 * without the rail having to announce anything.
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
  preparedTarget: 20,
  // the buffer plus the pipeline's own slack, so a top-up is never refused by
  // the ceiling on the way in
  maxJobs: 28,
  renderConcurrency: 3,
  interpretConcurrency: 6,
  imagineConcurrency: 8,
  angleConcurrency: 4,
  maxAttempts: 2,
};

/** The gates a stage can be admitted by. See `underGate`. */
export type RailGate = 'render' | 'interpret' | 'imagine' | 'angle';

/** What each pre-session state means for the person waiting on it. */
const STAGE_BY_STATE: Partial<Record<BlotState, RailStage>> = {
  invented: 'painting',
  rendered: 'hosting',
  uploaded: 'imagining',
  interpreted: 'realising',
  imagined: 'shooting',
  ready: 'ready',
};

/** Cheapest first, so the first state still in play is the gating one. */
const STAGE_ORDER: BlotState[] = ['invented', 'rendered', 'uploaded', 'interpreted', 'imagined', 'ready'];

/** The shape a blot's own sheet is drawn at: the session's own aspect ratio. */
function aspectOf(canvas: { width: number; height: number }): '16:9' | '9:16' | '1:1' {
  if (canvas.width === canvas.height) return '1:1';
  return canvas.width > canvas.height ? '16:9' : '9:16';
}

/**
 * The blot rail. It invents blots, renders and uploads them, asks the vision
 * model what each one could be, and rolls a camera move for about one blot in
 * five. Everything happens ahead of the stream so the scheduler never waits on
 * it.
 *
 * The rail never blocks: a blot that fails repeatedly is dropped and the rail
 * invents another one, because a live film cannot pause to fix a picture.
 *
 * Every blot runs its own pipeline, one stage after another. There is no shared
 * step: a blot that has been painted goes straight on to being hosted, read and
 * realised without waiting for the blot beside it to finish a vision call, so
 * the rail's rate is set by each stage's own concurrency rather than by the sum
 * of its stages. What this replaces was a single pump that advanced the whole
 * rail one stage and awaited them all, so every blot in the rail moved at the
 * speed of the slowest stage in it - five stages at the pace of one vision call,
 * which is why a blot took the better part of a minute to make while the film
 * was eating one every ten seconds, and why the rail was empty a minute into a
 * run and the last blot played on.
 */
export class BlotRail {
  private jobs: BlotJob[] = [];
  /**
   * In-flight readings, not resolved ones: two blots sharing a recipe must
   * await the same vision call rather than racing two of them.
   */
  private readingsByRecipe = new Map<string, Promise<BlotReading>>();
  /** The run each blot walks its own pipeline in, by blot id. One per blot. */
  private runs = new Map<string, Promise<void>>();
  /**
   * Bumped by anything that makes work in flight nobody's business - a reset, a
   * run that has ended. A run still walking a blot that was dropped stops there
   * rather than spending a vision call and an imagining on a blot no film will
   * ever arrive at.
   */
  private generation = 0;
  /** Stages in flight, counted per gate. */
  private inFlight: Record<RailGate, number> = { render: 0, interpret: 0, imagine: 0, angle: 0 };
  /**
   * Blots that stopped where they are during the current pump pass.
   *
   * A blot at a closed gate or with a take already in the air has nothing to do
   * until something else finishes, and a pump that started it again would spin
   * on it - so a pass leaves it parked and the next pass, a heartbeat or a
   * quarter-second later, is what tries it again.
   */
  private parked = new Set<string>();

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
    const live = this.jobs.filter((job) => job.state !== 'passed' && job.state !== 'failed');
    // A blot whose photograph exists but whose take is still being shot is the
    // rail's own camera work, and this is the only label it could have: the blot
    // is the film's either way, because the picture is what the film arrives at.
    const stateOf = (job: BlotJob): BlotState =>
      job.state === 'ready' && job.angles.some((take) => take.state !== 'ready' && take.state !== 'failed')
        ? 'imagined'
        : job.state;
    const gatingState = STAGE_ORDER.find((state) => live.some((job) => stateOf(job) === state));
    // Without an image model there is no 'realised' step: a reading goes
    // straight to the orbits, and the label has to say so rather than claim a
    // photograph that was never made.
    const stage = this.ports.imagine
      ? STAGE_BY_STATE
      : { ...STAGE_BY_STATE, interpreted: 'shooting' as RailStage };
    return {
      target: this.options.preparedTarget,
      ready: live.filter((job) => job.state === 'ready').length,
      working: live.filter((job) => job.state !== 'ready').length,
      failed: this.failedCount,
      anglesReady: live.reduce(
        (sum, job) => sum + job.angles.filter((take) => take.state === 'ready').length,
        0,
      ),
      // one take each, and only for the blots that rolled a move
      anglesWanted: camera.enabled ? live.filter((job) => job.cameraMove !== undefined).length : 0,
      // nothing live and nothing dropped yet means the rail is about to invent
      stage: gatingState ? stage[gatingState]! : this.failedCount > 0 ? 'stalled' : 'painting',
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
  adopt(recipe: InkRecipe, thumbDataUri?: string, blob?: Blob, visionDataUri?: string): BlotJob {
    const camera = this.ports.readEpisode().camera;
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
      visionDataUri,
      cameraMove: camera.enabled ? cameraMoveForSeed(recipe.seed) ?? undefined : undefined,
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
    this.generation += 1;
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
    // whatever was mid-pipeline is dropped, so its run has nowhere left to go
    this.generation += 1;
  }

  /** Set by the plan-ahead scheduler so cached readings are not re-used across films. */
  forgetReadings(): void {
    this.readingsByRecipe.clear();
  }

  /**
   * Invents up to the buffer's worth of blots and drives the rail as far as it
   * can go right now, then resolves.
   *
   * A pass ends when every blot has either finished for the moment or stopped
   * where it is, and a pass that freed a gate is followed by another, so one
   * pump walks as many blots through as the gates allow. It resolves when the
   * rail has stood still rather than when a stage has finished, so a caller that
   * only wants the work started - the heartbeat, a run that has just been asked
   * to start - must not await it. Overlapping calls are harmless: a blot has
   * exactly one run at a time.
   */
  async pump(): Promise<void> {
    // every call is a fresh chance: a blot that stopped at a closed gate, or on
    // a stage that has to be tried again, is picked up here. Inside the passes
    // below a parked blot stays parked unless something else finished, which is
    // what the clears at each gate's own release are for.
    this.parked.clear();
    // a top-up belongs to the call, not to a pass: a blot that has just been
    // dropped is replaced by the next pump rather than by the pass that dropped
    // it, or the rail would never be seen to be down to nothing
    this.fill();
    for (;;) {
      this.kick();
      if (this.runs.size === 0) return;
      await Promise.all([...this.runs.values()]);
    }
  }

  /** Starts a run for every blot that has work to do and none in flight. */
  private kick(): void {
    for (const job of this.jobs) {
      // a blot the rail is done with has nothing left to start: it is on the
      // rail as a card, not as work
      if (job.state === 'passed' || job.state === 'failed') continue;
      if (this.runs.has(job.id) || this.parked.has(job.id)) continue;
      const generation = this.generation;
      const run = this.drive(job, generation)
        // a run that throws is a bug in the rail rather than a blot's fault: the
        // stage that failed has already counted the blot's own attempts
        .catch(() => undefined)
        .finally(() => {
          if (this.runs.get(job.id) === run) this.runs.delete(job.id);
        });
      this.runs.set(job.id, run);
    }
  }

  /**
   * Walks one blot through its stages back to back.
   *
   * A stage that could not start because its own gate is full ends the run - the
   * blot simply stops where it is - and the next pump picks it up. That is how a
   * slot freed by another blot's stage gets used, and how a stage that failed
   * gets its own seconds of space before it is tried again.
   */
  private async drive(job: BlotJob, generation: number): Promise<void> {
    while (this.generation === generation) {
      if (job.state === 'passed' || job.state === 'failed') return;
      if (await this.advance(job)) continue;
      this.parked.add(job.id);
      return;
    }
  }

  /**
   * Invents until the rail holds `preparedTarget` *ready* blots, or is at its
   * ceiling.
   *
   * Ready is the point of the number: the film can only be handed a finished
   * blot, so a blot still walking its stages is the buffer's own supply line
   * rather than part of it. Counting those against the buffer is what left the
   * pre-flight waiting for a count it could never reach - twenty ready on a rail
   * that only ever invented twenty blots, a couple of them mid-pipeline for as
   * long as the rail ran - and `maxJobs` is what keeps the supply line bounded.
   */
  private fill(): void {
    const camera = this.ports.readEpisode().camera;
    for (;;) {
      const live = this.jobs.filter((job) => job.state !== 'passed' && job.state !== 'failed');
      if (live.length >= this.options.maxJobs) break;
      if (live.filter((job) => job.state === 'ready').length >= this.options.preparedTarget) break;
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
        cameraMove: camera.enabled ? cameraMoveForSeed(recipe.seed) ?? undefined : undefined,
        angles: [],
      });
    }
    this.jobs.sort((a, b) => Number(b.handmade) - Number(a.handmade) || a.createdAt - b.createdAt);
  }

  /**
   * Moves one blot on by one stage. False means it cannot move right now, which
   * is what ends a run.
   */
  private async advance(job: BlotJob): Promise<boolean> {
    switch (job.state) {
      case 'invented':
        return this.underGate('render', job, async () => {
          const rendered = await this.ports.render(job.recipe);
          job.blob = rendered.blob;
          job.thumbDataUri = rendered.thumbDataUri;
          job.visionDataUri = rendered.visionDataUri;
          // the blot is on the card from the next emit to the shell, so its
          // hold is stamped here rather than in the view
          job.inkUntil = this.ports.now() + BLOT_HOLD_MS;
        }, 'rendered');
      case 'rendered':
        // Hosting is the one ungated stage: it is a single upload of a picture
        // the rail has already paid to paint, and holding it behind a wait would
        // only leave a finished sheet sitting on a machine nobody can read.
        return this.step(job, async () => {
          if (!job.blob) throw new Error('rendered blot has no blob');
          job.url = await this.ports.upload(job.blob, `${job.recipeKey}.png`);
        }, 'uploaded');
      case 'uploaded':
        return this.underGate('interpret', job, async () => {
          job.reading = await this.readFor(job);
        }, 'interpreted');
      case 'interpreted':
        return this.realise(job);
      case 'imagined':
        this.startAngles(job);
        return true;
      case 'ready':
        // the takes are still being shot: the blot is already the film's, and
        // this is where the ones the gate turned away get started
        this.shootAngles(job);
        return false;
      default:
        return false;
    }
  }

  /**
   * Turns the reading into a photograph, or skips straight to the orbits when
   * no image model is wired up.
   *
   * A blot that cannot be realised never reaches the film: the whole point of
   * the step is that the video model is handed a photograph rather than a
   * painting, so a blot with no photograph is dropped and another is invented.
   */
  private async realise(job: BlotJob): Promise<boolean> {
    const imagine = this.ports.imagine;
    if (!imagine) {
      this.startAngles(job);
      return true;
    }
    const episode = this.ports.readEpisode();
    return this.underGate('imagine', job, async () => {
      const imagined = await imagine({
        blot: job,
        mood: episode.mood,
        music: episode.music,
        aspectRatio: aspectOf(job.recipe.canvas),
      });
      job.imaginedUrl = imagined.url;
    }, 'imagined');
  }

  private readyReadings(): string[] {
    return this.ready.map((job) => job.reading?.prompt ?? '').filter((text) => text !== '');
  }

  /** The blot's reading, shared with any other blot of the same recipe. */
  private readFor(job: BlotJob): Promise<BlotReading> {
    const existing = this.readingsByRecipe.get(job.recipeKey);
    if (existing) return existing;
    const episode = this.ports.readEpisode();
    const moveId = episode.camera.enabled ? job.cameraMove ?? null : null;
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

  /**
   * Opens a blot's camera take and hands the blot to the film.
   *
   * The film only ever needs a blot's photograph, so this never waits on the
   * cameras: one take is camera work - the move a blot's shot is given is the
   * one shot for it - and it is shot while the blot is already on the rail. A
   * blot that rolls no move, or whose take fails, still goes to air, because the
   * film arrives at its photograph either way.
   */
  private startAngles(job: BlotJob): void {
    const episode = this.ports.readEpisode();
    const camera = episode.camera;
    // the orbits are taken around the photograph, not the blot: the film lives
    // in the realised scene, and an ink view of it would be a different world
    const source = job.imaginedUrl ?? job.url;
    if (!source) {
      job.state = 'failed';
      return;
    }
    // The blot rolled a move when it was invented, and most blots roll none:
    // one take for the blots that won, nothing for the rest. The move is the
    // take's own, so the reading and the film's shot agree with the camera.
    const move = camera.enabled ? job.cameraMove : undefined;
    if (move && job.angles.length === 0) {
      job.angles.push({
        id: this.ports.nextId('angle'),
        blotId: job.id,
        move,
        seed: (job.recipe.seed + 7919) >>> 0,
        state: 'pending',
        costUsd: this.ports.angleCostUsd(),
      });
    }
    job.state = 'ready';
    job.updatedAt = this.ports.now();
    this.shootAngles(job);
  }

  /**
   * Starts whatever of a blot's orbit takes can run now, without blocking.
   *
   * Called on every pass over a ready blot, so a take the gate turned away is
   * picked up as soon as there is room. A take that fails is left failed: the
   * film never needed it.
   */
  private shootAngles(job: BlotJob): void {
    const source = job.imaginedUrl ?? job.url;
    if (!source) return;
    const pending = job.angles.filter((take) => take.state === 'pending');
    if (pending.length === 0) return;
    void Promise.all(pending.map((take) => this.advanceAngle(job, take, source))).then(() => {
      // A blot whose every take failed has no camera work, and the film arrives at
      // its photograph either way. The card should not keep the corpses of orbits
      // that never happened.
      if (job.angles.length > 0 && job.angles.every((take) => take.state === 'failed')) job.angles = [];
    });
  }

  private async advanceAngle(job: BlotJob, take: AngleTake, source: string): Promise<void> {
    if (this.inFlight.angle >= this.limitFor('angle')) return;
    if (take.state === 'failed') return; // already spent its attempts
    this.inFlight.angle++;
    take.state = 'generating';
    try {
      const created = await this.ports.generateAngle({ blot: job, move: take.move, seed: take.seed, imageUrl: source });
      take.videoUrl = created.videoUrl;
      take.state = 'extracting';
      const frame = await this.ports.extractArrivalFrame(created.videoUrl);
      take.arrivalFrameUrl = await this.ports.upload(frame, `${job.recipeKey}-${take.move}.png`);
      take.state = 'ready';
    } catch (error) {
      take.state = 'failed';
      take.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight.angle--;
      this.parked.clear();
      job.updatedAt = this.ports.now();
    }
  }

  /**
   * Runs a stage under its own gate.
   *
   * The gates are what make the rail parallel without letting it flood: several
   * vision calls, several imaginings, a few sheets being painted, all at once,
   * and never more than that however many blots the buffer holds. A stage that
   * arrives at a closed gate is not queued behind it - the blot stops where it
   * is and the next pump starts it again - so a slow call cannot hold a place it
   * is not using while another blot could be moving.
   */
  private async underGate(
    gate: RailGate,
    job: BlotJob,
    run: () => Promise<void>,
    onSuccess: BlotState,
  ): Promise<boolean> {
    if (this.inFlight[gate] >= this.limitFor(gate)) {
      this.parked.add(job.id);
      return false;
    }
    this.inFlight[gate] += 1;
    try {
      return await this.step(job, run, onSuccess);
    } finally {
      this.inFlight[gate] -= 1;
      // a slot has opened: the blots parked behind this gate are exactly the
      // ones that can use it, so the current pump pass is not over yet
      this.parked.clear();
    }
  }

  private limitFor(gate: RailGate): number {
    switch (gate) {
      case 'render':
        return this.options.renderConcurrency;
      case 'interpret':
        return this.options.interpretConcurrency;
      case 'imagine':
        return this.options.imagineConcurrency;
      case 'angle':
        return this.options.angleConcurrency;
    }
  }

  /**
   * Runs one stage, counting attempts and dropping the blot when it gives up.
   *
   * False on a failure, which ends the run: the blot is left where it was with
   * its attempt counted, so the next pump tries the stage again rather than the
   * rail spending both attempts in one breath.
   */
  private async step(job: BlotJob, run: () => Promise<void>, onSuccess: BlotState): Promise<boolean> {
    try {
      await run();
      job.state = onSuccess;
      job.attempts = 0;
      job.error = undefined;
      job.updatedAt = this.ports.now();
      return true;
    } catch (error) {
      job.attempts++;
      job.error = error instanceof Error ? error.message : String(error);
      if (job.attempts >= this.options.maxAttempts) job.state = 'failed';
      job.updatedAt = this.ports.now();
      return false;
    }
  }
}
