import { CAMERA_MOVES, type CameraMoveId } from '../presets/camera';
import { moodById } from '../presets/moods';
import { musicById } from '../presets/music';
import { inkRecipeFromSeed } from '../ink/recipe';
import { canvasForAspect, type AspectRatio, type InkRecipe } from '../ink/types';
import type { RenderedBlot } from '../ink/render';
import { BlotRail, DEFAULT_RAIL_OPTIONS, type BlotJob, type BlotState, type RailPorts, type RailProgress } from '../rail/queue';
import { createStudioInterpreter, type VisionCaller } from '../rail/interpreter';
import { buildMultiAngleInput, type MultiAngleInput } from '../angle/multiAngle';
import { MusicBed, generatedScoreBrief, type PinnedTrack } from '../audio/musicBed';
import { StreamRecorder, type Recording } from '../record/recorder';
import {
  directorRate,
  isPromo,
  multiAngleRate,
  type AngleResolution,
  type Settings,
  type StudioStatus,
} from '../state';
import { BudgetGuard } from '../stream/budget';
import { ChainController, chooseHandoffImage } from '../stream/chain';
import { createFrameGrabber, type FrameGrabberPort } from '../stream/frameGrabber';
import { composeWorldPrompt } from '../stream/promptComposer';
import { DirectorSession, realTimer, type DirectorSessionEvents, type Timer } from '../stream/session';
import { BlotScheduler, type SchedulerEpisode } from '../stream/scheduler';
import { buildConfigure, type ChunkInfo, type SessionInfo } from '../stream/protocol';
import type { DirectorTransport } from '../stream/transport';
import type { HealthResponse } from '../api/client';
import type { SharedSettings } from '../share/recipe';

/**
 * How long the pre-flight may spend warming the rail before it gives up.
 *
 * A blot needs a render, an upload, a vision call and two orbit takes, and an
 * orbit take can run into tens of seconds on its own, so a 45s ceiling fired on
 * a rail that was working perfectly well.
 */
export const PREFLIGHT_WAIT_MS = 150_000;

/** How often the pre-flight overlay repaints while the rail warms up. */
export const PREFLIGHT_TICK_MS = 500;

export interface LogLine {
  at: number;
  kind: 'info' | 'server' | 'warn' | 'error';
  text: string;
}

/** A one-shot message the shell turns into a toast. */
export interface StudioAlert {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export interface BlotView {
  id: string;
  state: BlotState;
  handmade: boolean;
  seed: number;
  thumb: string;
  subject: string | null;
  prompt: string | null;
  url: string | null;
  angles: Array<{
    id: string;
    move: CameraMoveId;
    label: string;
    state: string;
    videoUrl?: string;
    arrivalFrameUrl?: string;
  }>;
  error?: string;
}

export interface StudioView {
  status: StudioStatus;
  live: boolean;
  session: {
    elapsedSeconds: number;
    generatedSeconds: number;
    chunkIndex: number;
    chunks: number;
    bufferSeconds: number;
    route: string;
    buffering: boolean;
    promptVersion: number;
  };
  chain: { sessions: number; chains: number; failures: number; maxChains: number };
  spend: {
    sessionUsd: number;
    todayUsd: number;
    sessionCapUsd: number;
    dailyCapUsd: number;
    remainingSessionUsd: number;
    remainingTodayUsd: number;
    remainingSessionSeconds: number;
    rate: number;
    promo: boolean;
    dryRun: boolean;
  };
  rail: BlotView[];
  current: { blotId: string | null; subject: string | null; cameraLabel: string | null } | null;
  memory: string[];
  log: LogLine[];
  recording: { state: string; container: string | null; durationMs: number; bytes: number; result: Recording | null; parts: Recording[] };
  music: {
    label: string;
    mode: string;
    status: string;
    resolvedUrl: string | null;
    durationSeconds: number | null;
    bytes: number;
  };
  capabilities: { ffmpeg: boolean; sessionMaxSeconds: number | null; oneSessionPerMachine: boolean };
  sessionInfo: SessionInfo | null;
  warnings: string[];
  /** Newest-last. The shell toasts each id exactly once. */
  alerts: StudioAlert[];
  /**
   * Live progress of the pre-flight, or null once a session is opening. The wait
   * before the first frame is a minute or two of paid-for-by-nothing work, so it
   * has to say what it is doing.
   */
  preparing: (RailProgress & { elapsedMs: number }) | null;
}

export interface StudioOptions {
  settings: Settings;
  save(settings: Settings): void;
  health?: HealthResponse | null;
  transport: DirectorTransport;
  vision: VisionCaller;
  multiAngleSubscribe(input: MultiAngleInput): Promise<unknown>;
  upload(blob: Blob, name: string): Promise<string>;
  render(recipe: InkRecipe): Promise<RenderedBlot>;
  extractArrivalFrame(videoUrl: string): Promise<Blob>;
  fetchTrack(url: string): Promise<Blob>;
  probeDuration(blob: Blob): Promise<number | null>;
  remux(blob: Blob): Promise<Blob>;
  schedule?: Timer;
  now?(): number;
  /** Injected so tests do not wait on real time. */
  sleep?(ms: number): Promise<void>;
  onView?(view: StudioView): void;
  onStream?(stream: MediaStream): void;
}

const MAX_LOG = 200;
const HEARTBEAT_MS = 1000;

/**
 * One continuous film, made of chained Director sessions and fed by a rail of
 * ink blots.
 *
 * Every costly decision lives here - when to open a session, which blot lands
 * next, which camera views of it to orbit, when to hand over, and when to stop
 * - so the UI can stay a view of this object instead of a second source of
 * truth about the money.
 */
export class InkStudio {
  private readonly rail: BlotRail;
  private readonly musicBed: MusicBed;
  private readonly budget: BudgetGuard;
  private readonly chain: ChainController;
  private readonly interpreter: ReturnType<typeof createStudioInterpreter>;
  private readonly recorder: StreamRecorder;
  private readonly timer: Timer;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private session: DirectorSession | null = null;
  private readonly scheduler: BlotScheduler;
  private frameGrabber: FrameGrabberPort | null = null;
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private pendingMusicFile: Blob | null = null;

  private statusValue: StudioStatus = 'idle';
  private logLines: LogLine[] = [];
  private warnings: string[] = [];
  private alerts: StudioAlert[] = [];
  private alertSeq = 0;
  /** True while the user has paused the film; survives a chained session. */
  private pausedByUser = false;
  private lastChunk: ChunkInfo | null = null;
  private bufferingUntil = 0;
  private heartbeat: unknown = null;
  private tickCount = 0;
  private recordingResult: Recording | null = null;
  /** One recording per session, because a paused session cannot be rejoined. */
  private recordings: Recording[] = [];
  /** The frame the pause froze, used to open the next session on Play. */
  private pausedFrameUrl: string | null = null;
  /** In-flight pause teardown, so Play and Stop cannot race it. */
  private pauseWork: Promise<void> | null = null;
  private resuming = false;
  private musicStatus = 'not resolved';
  private pinned: PinnedTrack | null = null;
  private starting = false;
  /** Set when Stop lands during the pre-flight, so the start unwinds instead of opening a session. */
  private startCancelled = false;
  /** True while a failed run is being torn down, so the teardown happens once. */
  private failing = false;
  /**
   * The opening blot's own painting, shown as the player's poster until the
   * first generated frame arrives, so the stage is never a bare black rectangle.
   */
  private openingPoster: string | null = null;
  /** When the current pre-flight began, for the overlay's elapsed clock. */
  private preflightStartedAt = 0;
  /** Refresh handle for the pre-flight overlay; null when no run is warming up. */
  private preflightTicker: unknown = null;
  private idCounter = 0;
  private seedCounter = 0;

  constructor(private readonly options: StudioOptions) {
    this.now = options.now ?? (() => Date.now());
    this.timer = options.schedule ?? realTimer;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.budget = new BudgetGuard(
      {
        sessionCapUsd: options.settings.budget.sessionCapUsd,
        dailyCapUsd: options.settings.budget.dailyCapUsd,
        sessionCapSeconds: options.settings.budget.sessionCapSeconds,
        angleResolution: options.settings.camera.resolution,
        angleSecondsPerTake: options.settings.camera.duration,
        dryRun: options.settings.budget.dryRun,
      },
      { now: () => new Date(this.now()) },
    );
    this.chain = new ChainController({
      autoChain: options.settings.stream.autoChain,
      safetySeconds: 5,
    });
    this.musicBed = new MusicBed(
      {
        fetchTrack: options.fetchTrack,
        upload: options.upload,
        probeDurationSeconds: options.probeDuration,
      },
      { maxSourceSeconds: 600 },
    );
    this.interpreter = createStudioInterpreter({
      model: options.settings.openrouterModel,
      basePrompt: options.settings.studioPrompt,
      caller: options.vision,
    });
    this.recorder = new StreamRecorder({ remux: options.remux, timesliceMs: 1000 });
    this.rail = new BlotRail(this.railPorts(), {
      ...DEFAULT_RAIL_OPTIONS,
      preparedTarget: 3,
      maxJobs: 8,
      angleConcurrency: 2,
    });
    // an object-literal getter cannot be an arrow function, and the scheduler
    // reads live studio state, so it closes over this alias instead of `this`
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const studio = this;
    this.scheduler = new BlotScheduler({
      rail: this.rail,
      session: {
        get status() {
          return studio.statusValue;
        },
        get chunkIndex() {
          return studio.lastChunk?.chunkIndex ?? -1;
        },
        direct: (input) => studio.requireSession().direct(input),
      },
      readEpisode: () => this.episode(),
      events: {
        onDestination: ({ destination, promptVersion }) =>
          this.log(
            'info',
            destination.url
              ? `next: ${destination.label} (direction ${promptVersion})`
              : `next: a continuation (direction ${promptVersion})`,
          ),
        onBlotAirborne: ({ blotId }) => {
          const blot = this.rail.find(blotId);
          if (blot) this.log('info', `on screen: ${blot.reading?.subject ?? blot.id}`);
        },
        onBlotRetired: ({ blotId }) => {
          const blot = this.rail.find(blotId);
          if (blot) this.log('info', `done with ${blot.reading?.subject ?? blot.id}`);
        },
        onStall: () => this.warn('the rail ran dry; the film is continuing on its own for a moment'),
        onWarning: (message) => this.warn(message),
      },
      now: () => this.now(),
    });
  }

  // ------------------------------------------------------------------- view

  get settings(): Settings {
    return this.options.settings;
  }

  get status(): StudioStatus {
    return this.statusValue;
  }

  get view(): StudioView {
    const settings = this.options.settings;
    return {
      status: this.statusValue,
      live: this.statusValue === 'live',
      session: {
        elapsedSeconds: Math.round((this.session?.liveMs ?? 0) / 1000),
        generatedSeconds: Math.round(this.session?.generatedSeconds ?? 0),
        chunkIndex: this.lastChunk?.chunkIndex ?? -1,
        chunks: (this.lastChunk?.chunkIndex ?? -1) + 1,
        bufferSeconds: this.lastChunk?.bufferDepthSeconds ?? 0,
        route: this.lastChunk?.route ?? '-',
        buffering: this.now() < this.bufferingUntil,
        promptVersion: this.session?.promptVersion ?? 1,
      },
      chain: {
        sessions: this.chain.sessionCount,
        chains: this.chain.chainCount,
        failures: this.chain.failures,
        maxChains: this.chain.maxChains,
      },
      spend: {
        sessionUsd: this.budget.sessionUsd,
        todayUsd: this.budget.todayUsd,
        sessionCapUsd: settings.budget.sessionCapUsd,
        dailyCapUsd: settings.budget.dailyCapUsd,
        remainingSessionUsd: this.budget.remainingSessionUsd,
        remainingTodayUsd: this.budget.remainingTodayUsd,
        remainingSessionSeconds: this.budget.remainingSessionSeconds,
        rate: directorRate(new Date(this.now())),
        promo: isPromo(new Date(this.now())),
        dryRun: this.budget.dryRun,
      },
      rail: this.rail.all.map((job) => this.blotView(job)),
      current: this.currentView(),
      memory: this.rail.history(6),
      log: this.logLines,
      recording: {
        state: this.recorder.state,
        container: this.recorder.container,
        durationMs: this.recorder.elapsedMs(),
        bytes: this.recordingResult?.bytes ?? 0,
        result: this.recordingResult,
        parts: this.recordings,
      },
      music: {
        label: musicById(settings.music.musicId).label,
        mode: settings.music.mode,
        status: this.musicStatus,
        resolvedUrl: this.pinned?.url ?? null,
        durationSeconds: this.pinned?.durationSeconds ?? null,
        bytes: this.pinned?.bytes ?? 0,
      },
      capabilities: {
        ffmpeg: this.options.health?.ffmpeg === true,
        sessionMaxSeconds: this.session?.sessionInfo?.maxSessionSeconds ?? null,
        oneSessionPerMachine: this.session?.sessionInfo?.oneSessionPerMachine ?? true,
      },
      sessionInfo: this.session?.sessionInfo ?? null,
      warnings: this.warnings,
      alerts: this.alerts,
      preparing: this.preparingView(),
    };
  }

  private episode(): SchedulerEpisode {
    const settings = this.options.settings;
    const mood = moodById(settings.moodId);
    return {
      mood,
      music: musicById(settings.music.musicId),
      camera: settings.camera,
      moodStrength: settings.moodStrength,
      arrivalMode: settings.stream.arrivalMode,
      // colours are drawn per blot now, so nothing is locked in advance
      palette: [],
    };
  }

  private blotView(job: BlotJob): BlotView {
    return {
      id: job.id,
      state: job.state,
      handmade: job.handmade,
      seed: job.recipe.seed,
      thumb: job.thumbDataUri ?? '',
      subject: job.reading?.subject ?? null,
      prompt: job.reading?.prompt ?? null,
      url: job.url ?? null,
      angles: job.angles.map((take) => ({
        id: take.id,
        move: take.move,
        label: CAMERA_MOVES[take.move]?.label ?? take.move,
        state: take.state,
        videoUrl: take.videoUrl,
        arrivalFrameUrl: take.arrivalFrameUrl,
      })),
      error: job.error,
    };
  }

  private currentView(): StudioView['current'] {
    const blotId = this.scheduler.currentBlotId;
    if (!blotId) return null;
    const job = this.rail.find(blotId);
    if (!job) return { blotId, subject: null, cameraLabel: null };
    const camera = job.angles.find((take) => take.state === 'ready' && take.arrivalFrameUrl);
    return {
      blotId,
      subject: job.reading?.subject ?? null,
      cameraLabel: camera ? CAMERA_MOVES[camera.move]?.label ?? null : null,
    };
  }

  // ------------------------------------------------------------------ ports

  private railPorts(): RailPorts {
    const options = this.options;
    return {
      invent: (seed) => {
        const settings = options.settings;
        const mood = moodById(settings.moodId);
        // no palette is handed in: every blot draws its own random colours
        return inkRecipeFromSeed({
          seed,
          canvas: canvasForAspect(settings.stream.aspectRatio),
          tools: mood.tools,
          folds: 'auto',
        });
      },
      render: (recipe) => options.render(recipe),
      upload: (blob, name) => options.upload(blob, name),
      interpret: async ({ blot, mood, music, cameraMoveId, previousPrompts, beatIndex }) => {
        if (!blot.visionDataUri) throw new Error('blot has no vision image');
        return this.interpreter({
          imageDataUri: blot.visionDataUri,
          mood,
          music,
          cameraMoveId,
          previousPrompts,
          beatIndex,
          moodStrength: options.settings.moodStrength,
        });
      },
      generateAngle: async ({ blot, move, seed }) => {
        if (!blot.url) throw new Error('blot has no hosted image to orbit');
        const verdict = this.budget.checkBeforeAngleTake();
        if (!verdict.ok) {
          this.warn(`skipping an orbit take: ${verdict.detail}`);
          throw new Error(verdict.detail);
        }
        const camera = options.settings.camera;
        const input = buildMultiAngleInput({
          blotId: blot.id,
          imageUrl: blot.url,
          move,
          seed,
          duration: camera.duration,
          resolution: camera.resolution,
          promptExpansionMode: camera.promptExpansionMode,
        });
        const raw = await options.multiAngleSubscribe(input);
        const url = (raw as { video?: { url?: string } })?.video?.url;
        if (typeof url !== 'string' || url === '') throw new Error('multi angle returned no video url');
        this.budget.addAngleTake();
        return { videoUrl: url };
      },
      extractArrivalFrame: (videoUrl) => options.extractArrivalFrame(videoUrl),
      readEpisode: () => this.episode(),
      now: () => this.now(),
      nextId: (prefix) => `${prefix}-${++this.idCounter}`,
      nextSeed: () => this.nextSeed(),
      angleCostUsd: (seconds, resolution) =>
        seconds * multiAngleRate((resolution as AngleResolution) ?? '480P', new Date(this.now())),
    };
  }

  private nextSeed(): number {
    const configured = this.options.settings.ink.seed;
    const base = configured > 0 ? configured : Math.floor(Math.random() * 0xffffffff);
    this.seedCounter += 1;
    // the first blot is exactly the shared seed; later ones wander from it
    if (configured > 0 && this.seedCounter === 1) return configured >>> 0;
    return (base + this.seedCounter * 0x9e3779b1) >>> 0;
  }

  // -------------------------------------------------------------- lifecycle

  /** Prepares everything paid-for, then opens the first session. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.starting || this.failing) {
      return { ok: false, error: 'the last run is still shutting down' };
    }
    if (this.statusValue === 'live' || this.statusValue === 'connecting' || this.statusValue === 'preflight') {
      return { ok: false, error: 'already running' };
    }
    if (this.options.health && !this.options.health.fal) {
      return { ok: false, error: 'FAL_KEY is missing from the server .env' };
    }
    this.starting = true;
    this.startCancelled = false;
    this.failing = false;
    this.warnings = [];
    this.alerts = [];
    this.pausedByUser = false;
    this.pausedFrameUrl = null;
    this.pauseWork = null;
    this.resuming = false;
    this.recordings = [];
    this.recordingResult = null;
    this.setStatus('preflight');
    this.beginPreflight();
    this.log('info', 'preparing the first blot');
    try {
      await this.rail.pump();
      const opening = await this.waitForBlot();
      if (this.startCancelled) return { ok: false, error: 'stopped during the pre-flight' };
      if (!opening || !opening.url) {
        this.setStatus('idle');
        return { ok: false, error: 'could not prepare a blot — check the vision model and the fal key' };
      }
      const pinned = await this.resolveMusic();
      const settings = this.options.settings;
      const mood = moodById(settings.moodId);
      const music = musicById(settings.music.musicId);
      const world = composeWorldPrompt({
        mood,
        music,
        palette: opening.recipe.palette,
        moodStrength: settings.moodStrength,
        musicPinned: pinned !== null,
        scoreBrief: pinned ? undefined : generatedScoreBrief(music, mood.energy),
      });
      this.chain.reset();
      this.chain.setAutoChain(settings.stream.autoChain);
      this.openSession({ worldPrompt: world, imageUrl: opening.url, audioUrl: pinned?.url ?? null, opening });
      this.startHeartbeat();
      this.log('info', `opening inside blot #${opening.recipe.seed}`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`could not start: ${message}`);
      this.setStatus('idle');
      return { ok: false, error: message };
    } finally {
      this.endPreflight();
      this.starting = false;
    }
  }

  /** Stops the film and finalises the recording. */
  async stop(reason = 'stopped by the user'): Promise<void> {
    if (this.statusValue === 'idle' || this.statusValue === 'ended' || this.statusValue === 'stopping') return;
    // a failed run has already been torn down, and committing its spend again
    // would bill the day's meter twice for one session
    if (this.statusValue === 'failed') return;
    // A pre-flight has no session to close yet, so stopping it means cancelling
    // the start: without this the run would keep warming the rail and open a
    // paying session seconds after the user stopped it.
    if (this.statusValue === 'preflight') {
      this.startCancelled = true;
      this.setStatus('idle');
      this.log('info', 'stopped before a session opened; nothing was billed');
      this.emit();
      return;
    }
    // if a pause is still tearing the session down, let it finish first
    if (this.pauseWork) await this.pauseWork;
    this.pausedByUser = false;
    this.setStatus('stopping');
    this.log('info', `stopping: ${reason}`);
    this.stopHeartbeat();
    this.frameGrabber?.stop();
    await this.finishRecording();
    if (this.recordingResult) {
      this.log('info', `recording kept: ${this.recordingResult.container}, ${Math.round(this.recordingResult.bytes / 1024)} KB`);
    }
    this.budget.commitSession();
    const session = this.session;
    this.session = null;
    await session?.stop();
    this.setStatus('ended');
    this.emit();
  }

  /**
   * Tears the run down after the stream itself failed.
   *
   * A dead session is terminal: nothing will generate another chunk, so leaving
   * the studio alone would keep a recorder running over a dead stream, keep the
   * heartbeat warming the rail with paid vision calls, and leave the user
   * looking at a black stage under a status pill that never changes. The
   * recording is finalised and kept, and the run is reported as failed rather
   * than quietly finished.
   */
  private async failRun(reason: string): Promise<void> {
    if (this.failing) return;
    if (this.statusValue === 'idle' || this.statusValue === 'ended' || this.statusValue === 'stopping') return;
    if (this.statusValue === 'preflight') {
      // no session to fail: this is an ordinary cancellation of the pre-flight
      this.startCancelled = true;
      this.setStatus('idle');
      this.warn(`the run stopped before it started: ${reason}`);
      this.emit();
      return;
    }
    this.failing = true;
    this.pausedByUser = false;
    this.setStatus('failed');
    this.notify('error', `The stream failed (${reason}). The session was closed and the recording was kept.`);
    this.error(`the run failed: ${reason}`);
    this.stopHeartbeat();
    this.frameGrabber?.stop();
    this.chain.recordFailure();
    try {
      await this.finishRecording();
      if (this.recordingResult) {
        this.log('info', `recording kept: ${this.recordingResult.container}, ${Math.round(this.recordingResult.bytes / 1024)} KB`);
      }
      this.budget.commitSession();
    } catch (error) {
      this.warn(`could not keep the recording: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = this.session;
    this.session = null;
    try {
      await session?.stop();
    } catch {
      /* the peer is already gone; releasing it is what matters */
    }
    // the session reports its own teardown as 'ended': this run did not end,
    // it failed, and that is what the person watching has to see
    this.setStatus('failed');
    this.failing = false;
    this.emit();
  }

  /**
   * Pauses the film by ending the paid session.
   *
   * A Director session cannot be resumed once it is stopped, so this is the
   * only way to actually stop the meter mid-film: the current session is closed,
   * the recording is finalised, and the last picture is kept. Play opens a fresh
   * session on that exact frame, which is why a pause costs a new session
   * minimum.
   */
  pauseFilm(): void {
    if (this.pausedByUser) return;
    if (this.statusValue !== 'live' && this.statusValue !== 'connecting' && this.statusValue !== 'chaining') return;
    this.pausedByUser = true;
    this.setStatus('paused');
    this.notify('info', 'Film paused — the session is closed and the meter is stopped.');
    this.log('info', 'pausing: closing the session; Play opens a new one on this frame');
    this.pauseWork = this.settlePause().catch((error) => {
      this.warn(`pause stumbled: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.emit();
  }

  /** Freezes the picture, keeps its last frame, and tears the session down. */
  private async settlePause(): Promise<void> {
    this.stopHeartbeat();
    try {
      const frame = (await this.frameGrabber?.grabNow()) ?? this.frameGrabber?.latest() ?? null;
      if (frame) {
        this.pausedFrameUrl = await this.options.upload(frame.blob, `paused-${this.chain.chainCount + 2}.jpg`);
      }
    } catch (error) {
      this.warn(`could not keep the paused frame: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.frameGrabber?.stop();
    this.videoElement?.pause();
    // stop the recorder before the stream goes away, so this part is not lost
    await this.finishRecording();
    this.budget.commitSession();
    // the paused session is over: zero the counters so a later stop cannot bill
    // it a second time
    this.budget.beginSession();
    const session = this.session;
    this.session = null;
    await session?.stop();
    this.emit();
  }

  /** Finalises the current recording part, if one is running. */
  private async finishRecording(): Promise<void> {
    if (this.recorder.state === 'recording' || this.recorder.state === 'paused') {
      const part = await this.recorder.stop();
      if (part) this.recordings = [...this.recordings, part];
    }
    this.recorder.reset();
    this.recordingResult = this.recordings[this.recordings.length - 1] ?? null;
  }

  /**
   * Opens a new session on the frame the pause froze and starts playing again.
   * The session minimum applies again.
   */
  resumeFilm(): void {
    if (!this.pausedByUser || this.resuming) return;
    this.resuming = true;
    void (async () => {
      try {
        await this.pauseWork;
        this.pausedByUser = false;
        const settings = this.options.settings;
        const mood = moodById(settings.moodId);
        const music = musicById(settings.music.musicId);
        const pinnedUrl = this.pinned?.url ?? null;
        const world = composeWorldPrompt({
          mood,
          music,
          palette: [],
          moodStrength: settings.moodStrength,
          musicPinned: pinnedUrl !== null,
          scoreBrief: pinnedUrl ? undefined : generatedScoreBrief(music, mood.energy),
          openingAction: 'already mid-motion, continuing the take the pause interrupted',
        });
        if (!this.pausedFrameUrl) {
          this.warn('no frame was kept from before the pause; the new session starts from the prompt alone');
        }
        this.openSession({ worldPrompt: world, imageUrl: this.pausedFrameUrl, audioUrl: pinnedUrl });
        this.pausedFrameUrl = null;
        this.log('info', 'resuming: a new session opened on the paused frame');
      } catch (error) {
        this.pausedByUser = true;
        this.warn(`could not resume: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.resuming = false;
        this.emit();
      }
    })();
  }

  /** Adopts a hand-painted blot into the film. */
  enqueueHandmade(recipe: InkRecipe, blob?: Blob, thumbDataUri?: string): BlotJob {
    const job = this.rail.adopt(recipe, thumbDataUri, blob);
    this.log('info', 'a hand-painted blot joined the rail');
    void this.rail.pump().then(() => this.emit());
    this.emit();
    return job;
  }

  /** Moves the film on from whatever it is orbiting right now. */
  releaseCurrent(): void {
    this.scheduler.releaseCurrent();
    this.emit();
  }

  // --------------------------------------------------------------- settings

  /**
   * Adopts the server capabilities once `/api/health` answers.
   *
   * `health` is fetched asynchronously while the studio is being constructed,
   * so a value passed at construction would be the pre-flight `null` forever and
   * the UI would keep claiming ffmpeg is missing on a machine that has it.
   */
  setHealth(health: HealthResponse | null): void {
    this.options.health = health;
    this.emit();
  }

  updateSettings(patch: Partial<Settings>): void {
    const previousMood = this.options.settings.moodId;
    Object.assign(this.options.settings, patch);
    this.options.save(this.options.settings);
    this.syncBudgetLimits();
    if (patch.stream?.autoChain !== undefined) this.chain.setAutoChain(patch.stream.autoChain);
    if (patch.moodId && patch.moodId !== previousMood && this.statusValue === 'live') {
      this.scheduler.notifyMoodChanged(moodById(previousMood));
      this.log('info', `mood turned to ${moodById(patch.moodId).label}`);
    }
    this.emit();
  }

  /** Pushes the live caps and orbit rates into the guard that enforces them. */
  private syncBudgetLimits(): void {
    const settings = this.options.settings;
    this.budget.updateLimits({
      sessionCapUsd: settings.budget.sessionCapUsd,
      dailyCapUsd: settings.budget.dailyCapUsd,
      sessionCapSeconds: settings.budget.sessionCapSeconds,
      angleResolution: settings.camera.resolution,
      angleSecondsPerTake: settings.camera.duration,
      dryRun: settings.budget.dryRun,
    });
  }

  /** Changes genre, source or score mode. A genre swap re-pins mid-stream. */
  async setMusic(next: {
    musicId?: Settings['music']['musicId'];
    mode?: Settings['music']['mode'];
    customUrl?: string | null;
  }): Promise<void> {
    const settings = this.options.settings;
    const previousUrl = this.pinned?.url ?? null;
    Object.assign(settings.music, next);
    this.options.save(settings);
    if (next.mode === 'generated' && this.statusValue === 'live') {
      this.warn('the score was pinned when this session opened, so a generated score only takes effect on the next session');
    }
    const shouldRepin = settings.music.mode === 'pinned' && (next.musicId !== undefined || next.customUrl !== undefined);
    if (shouldRepin) {
      this.pinned = null;
      this.musicBed.clear();
      if (this.statusValue === 'live') {
        try {
          const track = await this.resolveMusic();
          if (track && track.url !== previousUrl) {
            this.session?.setAudio(track.url, 'replace');
            this.log('info', 'the soundtrack was swapped mid-stream');
          }
        } catch (error) {
          this.warn(error instanceof Error ? error.message : String(error));
        }
      }
    }
    this.emit();
  }

  /** Hands a user-dropped audio file to the music bed. */
  async setMusicFile(file: Blob): Promise<void> {
    this.pendingMusicFile = file;
    this.options.settings.music.mode = 'pinned';
    this.pinned = null;
    this.musicBed.clear();
    await this.setMusic({});
  }

  private async resolveMusic(): Promise<PinnedTrack | null> {
    const settings = this.options.settings;
    if (settings.music.mode !== 'pinned') {
      this.musicStatus = 'scored by the model';
      this.pinned = null;
      return null;
    }
    this.musicStatus = 'hosting the track';
    try {
      const track = await this.musicBed.resolve(
        settings.music,
        musicById(settings.music.musicId),
        this.pendingMusicFile,
      );
      this.pinned = track;
      this.musicStatus = track
        ? `pinned${track.durationSeconds ? ` · ${Math.round(track.durationSeconds)}s` : ''}`
        : 'no track to pin';
      if (!track) this.warn('no track is available to pin, so the model will score this run itself');
      return track;
    } catch (error) {
      this.pinned = null;
      this.musicStatus = 'could not host the track';
      this.warn(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  // ---------------------------------------------------------------- session

  private openSession(input: {
    worldPrompt: string;
    imageUrl: string | null;
    audioUrl: string | null;
    opening?: BlotJob;
  }): void {
    const settings = this.options.settings;
    const events: DirectorSessionEvents = {
      onStatus: (status, detail) => {
        // a paused film just closed its session: its teardown must not drag the
        // status along with it
        if (this.pausedByUser) return;
        if (status === 'failed') {
          // the peer is gone: the session cannot continue, and everything it
          // owns - the recording, the rail, the meter - has to be released
          void this.failRun(detail ?? 'the transport failed');
          return;
        }
        if (status === 'ended' && this.statusValue !== 'stopping' && this.statusValue !== 'chaining') {
          this.setStatus('ended');
          return;
        }
        this.setStatus(status);
      },
      onSessionInfo: (info) => {
        this.log(
          'server',
          `session: ${info.fps} fps, ${info.chunkSeconds}s chunks, ceiling ${info.maxSessionSeconds ?? 'undeclared'}`,
        );
        // the meter has to know the server's own ceiling, or an unattended run is
        // cut off by the server instead of stopping itself in time
        this.budget.updateLimits({ maxSessionSeconds: info.maxSessionSeconds ?? undefined });
        if (info.maxSessionSeconds !== null && !settings.stream.autoChain) {
          this.warn(`chaining is off, so the film will stop at ${info.maxSessionSeconds}s`);
        }
      },
      onConfigured: (info) => {
        this.log('server', `configured: ${info.resolution ?? '?'} ${info.aspectRatio ?? ''} memory ${info.memory ?? '?'}`);
        if (info.hasInitialImage === false) this.warn('the model did not accept the opening image');
        // only worth saying when a track was actually handed over: if hosting
        // already failed the user has that warning, and the server never saw it
        if (info.hasInitialAudio === false && this.pinned !== null) {
          this.warn('the pinned track was not accepted; this session will be scored by the model');
        }
      },
      onChunk: (chunk) => this.handleChunk(chunk),
      onBuffering: ({ lateBySeconds }) => {
        this.bufferingUntil = this.now() + Math.max(2000, lateBySeconds * 1000);
        this.warn(`generation fell ${lateBySeconds.toFixed(1)}s behind playback; the stream is holding the last frame`);
      },
      onPromptApplied: (version) => this.log('server', `direction ${version} admitted`),
      onPromptRejected: (info) => {
        this.log('warn', `direction ${info.promptVersion} rejected: ${info.reason}`);
        this.scheduler.onPromptRejected(info);
      },
      onAudioApplied: (info) => this.log('server', `audio ${info.behavior}: ${Math.round(info.durationSeconds)}s`),
      onAudioRejected: (info) => this.warn(`the pinned track was rejected: ${info.reason} — ${info.error}`),
      onAudioExhausted: () => this.warn('the pinned track ran out, so the rest of this session has no score'),
      onExhausted: (info) => {
        this.log('server', `stream ended: ${info.reason} after ${info.chunks} chunks`);
        // 'stopped' is the server acknowledging a stop we already sent; saying
        // "the stream ended" to someone who just pressed Stop is noise
        if (this.statusValue === 'stopping' || this.statusValue === 'ended' || this.statusValue === 'failed') return;
        if (info.reason === 'session_limit') {
          if (settings.stream.autoChain) {
            void this.handover('the server ended the session');
          } else {
            this.notify('warn', 'The server hit its session limit and chaining is off, so the film stops.');
            void this.stop('the server reached its session limit');
          }
        } else {
          this.notify('info', `The stream ended (${info.reason}); stopping.`);
          void this.stop('the stream ended');
        }
      },
      onError: (info) => {
        if (info.code === 'transport_error') this.error(`transport failed: ${info.message}`);
        else this.warn(`server error ${info.code}: ${info.message}`);
        // the session classifies a code it cannot recover from; the run is over
        // either way, so the teardown does not wait for the next heartbeat
        const fatal = this.session?.fatalError;
        if (fatal) void this.failRun(`${fatal.code}: ${fatal.message}`);
      },
      onUnknownMessage: (raw) => this.log('server', `unrecognised frame: ${String(raw.type)}`),
      onStream: (stream) => {
        if (this.videoElement) this.attachStream(stream, this.videoElement);
        else this.log('info', 'the stream arrived before the player was ready');
      },
    };
    const session = new DirectorSession({
      transport: this.options.transport,
      events,
      schedule: this.timer,
      now: () => this.now(),
    });
    this.session = session;
    this.scheduler.reset();
    this.budget.beginSession();
    this.chain.recordStart();
    this.statusValue = 'connecting';
    // the picture the session opens inside: the opening blot's own painting, or
    // the frame a chain and a resume carry over from the last session
    this.openingPoster = input.opening?.thumbDataUri ?? input.imageUrl ?? null;
    this.applyPoster();
    session.start(buildConfigure({
      prompt: input.worldPrompt,
      imageUrl: input.imageUrl ?? undefined,
      audioUrl: input.audioUrl ?? undefined,
      resolution: settings.stream.resolution,
      aspectRatio: settings.stream.aspectRatio,
      memory: settings.stream.memory,
      seed: settings.stream.seed,
      audioBitrate: input.audioUrl ? 192000 : undefined,
    }));
    if (input.opening) this.scheduler.beginWith(input.opening);
    this.emit();
  }

  private handleChunk(chunk: ChunkInfo): void {
    this.lastChunk = chunk;
    // the film has a picture of its own now: the opening still has done its job
    if (chunk.chunkIndex === 0) {
      this.openingPoster = null;
      this.applyPoster();
    }
    const verdict = this.budget.addChunk(chunk.requestedDurationSeconds);
    this.log(
      'server',
      `chunk ${chunk.chunkIndex} · ${chunk.requestedDurationSeconds}s · buffer ${chunk.bufferDepthSeconds.toFixed(1)}s · ${chunk.route}`,
    );
    if (!verdict.ok) {
      this.notify('warn', `Session limit reached: ${verdict.detail}`);
      void this.stop(verdict.detail);
      return;
    }
    this.scheduler.onChunk(chunk);
  }

  /** Retires this session and opens the next one on the previous picture. */
  private async handover(reason: string): Promise<void> {
    if (this.statusValue !== 'live' && this.statusValue !== 'paused') return;
    if (!this.session) return;
    this.setStatus('chaining');
    this.log('info', `handing over: ${reason}`);
    const settings = this.options.settings;
    let lastFrameUrl: string | null = null;
    try {
      const frame = (await this.frameGrabber?.grabNow()) ?? this.frameGrabber?.latest() ?? null;
      if (frame) lastFrameUrl = await this.options.upload(frame.blob, `handover-${this.chain.chainCount + 2}.jpg`);
    } catch (error) {
      this.warn(`could not capture the handover frame: ${error instanceof Error ? error.message : String(error)}`);
    }
    const currentJob = this.scheduler.currentBlotId ? this.rail.find(this.scheduler.currentBlotId) : undefined;
    const angleView = currentJob?.angles.find((take) => take.state === 'ready' && take.arrivalFrameUrl)?.arrivalFrameUrl ?? null;
    const handoff = chooseHandoffImage(settings.camera.handoff, lastFrameUrl, angleView);
    this.log('info', `the new session opens on ${handoff.used === 'turn' ? 'a different camera angle of the same world' : 'the last frame of the last one'}`);
    const pinnedUrl = this.pinned?.url ?? null;
    // The next session arrives on a new MediaStream, and a MediaRecorder cannot
    // be handed a different stream: it stops by itself when this one's tracks
    // end, and a recorder left latched would silently swallow session N+1. So
    // the part is closed here, before the session goes away, and the new stream
    // opens the next one.
    this.budget.commitSession();
    await this.finishRecording();
    if (this.recordingResult) {
      this.log('info', `recording kept: ${this.recordingResult.container}, ${Math.round(this.recordingResult.bytes / 1024)} KB`);
    }
    const session = this.session;
    this.session = null;
    await session.stop();
    // a pause that landed mid-handover wins: keep its frame and stay closed
    if (this.pausedByUser) {
      this.pausedFrameUrl = handoff.url;
      this.budget.beginSession();
      this.log('info', 'the pause interrupted a handover; the next session will open on this frame');
      this.emit();
      return;
    }
    // and so does a failure: opening the next session on a dead transport would
    // spend a session minimum to generate nothing. `failing` is set before the
    // teardown starts, so it is the honest signal here.
    if (this.failing) {
      this.budget.beginSession();
      this.log('info', 'the handover was abandoned: the stream failed');
      this.emit();
      return;
    }
    const mood = moodById(settings.moodId);
    const music = musicById(settings.music.musicId);
    const world = composeWorldPrompt({
      mood,
      music,
      palette: currentJob?.recipe.palette ?? [],
      moodStrength: settings.moodStrength,
      musicPinned: pinnedUrl !== null,
      scoreBrief: pinnedUrl ? undefined : generatedScoreBrief(music, mood.energy),
      openingAction: 'continuing the same take without a break, already mid-motion',
    });
    this.openSession({ worldPrompt: world, imageUrl: handoff.url, audioUrl: pinnedUrl });
    this.chain.recordOpened();
  }

  // ---------------------------------------------------------------- plumbing

  private requireSession(): DirectorSession {
    if (!this.session) throw new Error('there is no live session to direct');
    return this.session;
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = this.timer.set(() => void this.beat(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    this.timer.clear(this.heartbeat);
    this.heartbeat = null;
  }

  private async beat(): Promise<void> {
    this.tickCount += 1;
    // paused means paused: no dispatch, no chaining, and no paid rail work
    if (this.statusValue === 'paused') {
      this.emit();
      return;
    }
    if (this.tickCount % 2 === 0) {
      try {
        await this.rail.pump();
      } catch (error) {
        this.warn(`the rail stumbled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.checkChain();
    this.emit();
  }

  private checkChain(): void {
    const session = this.session;
    if (!session || this.statusValue !== 'live') return;
    if (session.fatalError) {
      void this.failRun(`${session.fatalError.code}: ${session.fatalError.message}`);
      return;
    }
    // A session that stops confirming directions - because it failed to generate
    // a chunk, or the acknowledgement was lost - must not freeze the film. The
    // scheduler cannot notice a chunk that never arrives, so it is checked here.
    if (this.scheduler.checkDispatchTimeout()) this.scheduler.tick();
    const verdict = this.budget.checkBeforeSession();
    const decision = this.chain.decide({
      status: this.statusValue,
      fatal: false,
      elapsedSeconds: session.liveMs / 1000,
      maxSessionSeconds: session.sessionInfo?.maxSessionSeconds ?? null,
      budgetAllows: verdict.ok,
      budgetDetail: verdict.detail,
    });
    if (decision.action === 'chain') void this.handover(decision.reason);
    else if (decision.action === 'stop') {
      this.notify('warn', `Stopping: ${decision.reason}`);
      void this.stop(decision.reason);
    }
  }

  private async waitForBlot(timeoutMs = PREFLIGHT_WAIT_MS): Promise<BlotJob | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (this.startCancelled) return null;
      const next = this.rail.next();
      if (next) return next;
      await this.sleep(250);
      await this.rail.pump();
    }
    return this.rail.next() ?? null;
  }

  /**
   * The pre-flight, as the overlay reads it.
   *
   * `pump()` awaits whole pipeline stages, so nothing else would repaint while a
   * vision call or an orbit take is in flight. A timer therefore carries the
   * updates, and the overlay is derived state rather than an event stream.
   */
  private preparingView(): (RailProgress & { elapsedMs: number }) | null {
    if (this.statusValue !== 'preflight') return null;
    return {
      ...this.rail.progress,
      elapsedMs: Math.max(0, this.now() - this.preflightStartedAt),
    };
  }

  private beginPreflight(): void {
    this.endPreflight();
    this.preflightStartedAt = this.now();
    this.preflightTicker = this.timer.set(() => this.emit(), PREFLIGHT_TICK_MS);
    this.emit();
  }

  private endPreflight(): void {
    if (this.preflightTicker === null) return;
    this.timer.clear(this.preflightTicker);
    this.preflightTicker = null;
  }

  private setStatus(status: StudioStatus): void {
    // a chained session must not drag a paused film back to life
    if (status === 'live' && this.pausedByUser) status = 'paused';
    if (this.statusValue === status) return;
    this.statusValue = status;
    if (status === 'live') {
      this.startRecordingIfPossible();
      this.frameGrabber?.start();
      this.scheduler.tick();
    } else if (status === 'ended' || status === 'failed' || status === 'idle') {
      // the heartbeat is what keeps the rail full, and a rail that fills spends
      // money on vision calls: a run that is over must stop doing either
      this.stopHeartbeat();
    }
    this.emit();
  }

  private startRecordingIfPossible(): void {
    if (!this.stream || this.recorder.state !== 'idle') return;
    // a stream left over from a closed session is inactive: recording it would
    // produce nothing while blocking the real stream from being recorded
    if (this.stream.active === false) return;
    try {
      const chosen = this.recorder.start(this.stream);
      this.log('info', `recording as ${chosen.mime}`);
    } catch (error) {
      this.warn(`this browser cannot record the stream: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The element the film is played in. Set once by the shell at boot. */
  setVideoElement(video: HTMLVideoElement): void {
    this.videoElement = video;
    this.applyPoster();
    if (this.stream) this.attachStream(this.stream, video);
  }

  /**
   * Shows the session's opening picture until the model's first frame arrives.
   *
   * A Director session takes a while to produce its first chunk, and the player
   * is a black rectangle until then - which reads as a broken film rather than
   * one that is being painted. The image the session opens *inside* is the right
   * thing to hold on screen: the first generated frame continues it.
   */
  private applyPoster(): void {
    if (!this.videoElement) return;
    this.videoElement.poster = this.openingPoster ?? '';
  }

  /** Called when the WebRTC receive stream arrives. */
  attachStream(stream: MediaStream, video: HTMLVideoElement): void {
    this.stream = stream;
    this.videoElement = video;
    video.srcObject = stream;
    this.applyPoster();
    void video.play().catch(() => this.warn('playback was blocked; press play on the film once'));
    if (this.pausedByUser) video.pause();
    // a second stream (a chained session) replaces the first: two grabbers would
    // both tick against the same element
    this.frameGrabber?.dispose();
    this.frameGrabber = createFrameGrabber({
      video,
      onStatus: (message) => this.log('info', message),
      now: () => this.now(),
    });
    // media can arrive before or after the session reports itself live, so the
    // grabber is started from whichever of the two happens second
    if (this.statusValue === 'live') this.frameGrabber.start();
    this.startRecordingIfPossible();
    this.options.onStream?.(stream);
  }

  get video(): HTMLVideoElement | null {
    return this.videoElement;
  }

  // ------------------------------------------------------------ share/export

  /** The configuration worth sharing: everything except the key and the money. */
  sharePayload(): SharedSettings {
    const settings = this.options.settings;
    return {
      seed: settings.ink.seed,
      recipe: settings.ink,
      moodId: settings.moodId,
      moodStrength: settings.moodStrength,
      musicId: settings.music.musicId,
      musicMode: settings.music.mode,
      camera: {
        enabled: settings.camera.enabled,
        moves: settings.camera.moves,
        anglesPerBlot: settings.camera.anglesPerBlot,
        resolution: settings.camera.resolution,
        duration: settings.camera.duration,
        handoff: settings.camera.handoff,
        repeatAngleCycle: settings.camera.repeatAngleCycle,
      },
      stream: {
        resolution: settings.stream.resolution,
        aspectRatio: settings.stream.aspectRatio as AspectRatio,
        memory: settings.stream.memory,
        arrivalMode: settings.stream.arrivalMode,
      },
      sessionCapSeconds: settings.budget.sessionCapSeconds,
    };
  }

  applyShare(shared: SharedSettings): void {
    const settings = this.options.settings;
    settings.ink = shared.recipe;
    settings.moodId = shared.moodId;
    settings.moodStrength = shared.moodStrength;
    settings.music = { ...settings.music, musicId: shared.musicId, mode: shared.musicMode, resolvedUrl: null };
    settings.camera = { ...settings.camera, ...shared.camera };
    settings.stream = {
      ...settings.stream,
      resolution: shared.stream.resolution,
      aspectRatio: shared.stream.aspectRatio,
      memory: shared.stream.memory,
      arrivalMode: shared.stream.arrivalMode,
    };
    settings.budget = { ...settings.budget, sessionCapSeconds: shared.sessionCapSeconds };
    this.options.save(settings);
    this.syncBudgetLimits();
    this.rail.reset();
    this.log('info', `loaded a shared run: ${shared.moodId} · ${shared.musicId} · blot #${shared.seed}`);
    this.emit();
  }

  // ------------------------------------------------------------ diagnostics

  private log(kind: LogLine['kind'], text: string): void {
    this.logLines = [...this.logLines.slice(-(MAX_LOG - 1)), { at: this.now(), kind, text }];
  }

  private warn(text: string): void {
    this.log('warn', text);
    if (!this.warnings.includes(text)) this.warnings = [...this.warnings.slice(-9), text];
  }

  /** Queues a one-shot message for the shell to show as a toast. */
  private notify(kind: StudioAlert['kind'], text: string): void {
    this.alerts = [...this.alerts.slice(-4), { id: (this.alertSeq += 1), kind, text }];
  }

  private error(text: string): void {
    this.log('error', text);
  }

  private emit(): void {
    this.options.onView?.(this.view);
  }

  dispose(): void {
    this.endPreflight();
    this.stopHeartbeat();
    this.frameGrabber?.dispose();
    this.recorder.reset();
    this.rail.reset();
  }
}
