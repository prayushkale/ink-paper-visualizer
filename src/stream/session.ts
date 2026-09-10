import {
  asStudioErrorCode,
  buildPing,
  buildPrompt,
  buildStop,
  parseServerMessage,
  PromptVersions,
  type AudioBehavior,
  type ChunkInfo,
  type ConfigureMessage,
  type ScriptBeat,
  type ScriptMode,
  type SessionInfo,
  type StudioErrorCode,
} from './protocol';
import type { DirectorConnection, DirectorTransport, RealtimeStateName } from './transport';
import type { StudioStatus } from '../state';

export interface DirectorSessionEvents {
  onStatus?(status: StudioStatus, detail?: string): void;
  onTransportState?(state: RealtimeStateName): void;
  onSessionInfo?(info: SessionInfo): void;
  onConfigured?(info: {
    resolution: string | null;
    aspectRatio: string | null;
    memory: number | null;
    chunkDuration: number | null;
    hasInitialImage: boolean | null;
    hasInitialAudio: boolean | null;
  }): void;
  onChunk?(chunk: ChunkInfo): void;
  onBuffering?(info: { chunkIndex: number; lateBySeconds: number }): void;
  onPromptPending?(promptVersion: number): void;
  onPromptApplied?(promptVersion: number, scriptQueued: number | null): void;
  onPromptRejected?(info: { promptVersion: number; reason: string; error: string | null }): void;
  onAudioApplied?(info: { behavior: string | null; durationSeconds: number; remainingSeconds: number }): void;
  onAudioRejected?(info: { reason: string; error: string }): void;
  onAudioExhausted?(info: { chunkIndex: number; silentSeconds: number }): void;
  onExhausted?(info: { reason: string; chunks: number }): void;
  /** The WebRTC receive stream. The film's picture and sound. */
  onStream?(stream: MediaStream): void;
  onError?(info: { code: StudioErrorCode; message: string }): void;
  onUnknownMessage?(raw: Record<string, unknown>): void;
}

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimer: Timer = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Error codes that mean the session cannot continue at all. */
const FATAL_CODES = new Set(['balance_unavailable', 'not_configured', 'immutable_settings', 'invalid_input']);

export interface DirectorSessionOptions {
  transport: DirectorTransport;
  events?: DirectorSessionEvents;
  /** Omit to disable the keepalive entirely. */
  schedule?: Timer;
  pingIntervalMs?: number;
  now?: () => number;
}

/**
 * Owns one Director session: the configure handshake, strictly increasing
 * prompt versions, the server's telemetry, and teardown.
 *
 * It deliberately knows nothing about blots, moods or money. Those belong to
 * the scheduler, the composer and the budget guard, all of which talk to this
 * class through `direct()` and its events.
 */
export class DirectorSession {
  private connection: DirectorConnection | null = null;
  private readonly versions = new PromptVersions();
  private statusValue: StudioStatus = 'idle';
  private pingHandle: unknown = null;
  private stopped = false;
  private configured: ConfigureMessage | null = null;

  sessionInfo: SessionInfo | null = null;
  lastChunk: ChunkInfo | null = null;
  /** Seconds of video the server has told us it generated. Drives the meter. */
  generatedSeconds = 0;
  fatalError: { code: StudioErrorCode; message: string } | null = null;

  private readonly events: DirectorSessionEvents;
  private readonly now: () => number;
  private liveSince: number | null = null;
  /** Live time of every stretch that has already ended. */
  private accumulatedLiveMs = 0;

  /**
   * Wall-clock milliseconds the session has been live.
   *
   * Counts the stretch that is still running: the chain controller retires a
   * session before the server's ceiling, and it can only do that if this grows
   * while the film is on air rather than only once it has stopped.
   */
  get liveMs(): number {
    return this.accumulatedLiveMs + (this.liveSince === null ? 0 : Math.max(0, this.now() - this.liveSince));
  }

  constructor(private readonly options: DirectorSessionOptions) {
    this.events = options.events ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  get status(): StudioStatus {
    return this.statusValue;
  }

  get promptVersion(): number {
    return this.versions.current;
  }

  get config(): ConfigureMessage | null {
    return this.configured;
  }

  get chunkIndex(): number {
    return this.lastChunk?.chunkIndex ?? -1;
  }

  setStatus(status: StudioStatus, detail?: string): void {
    this.statusValue = status;
    this.events.onStatus?.(status, detail);
  }

  /** Opens the session and sends the single `configure` message. */
  start(configure: ConfigureMessage): void {
    if (this.connection) throw new Error('this session has already been started');
    this.connection = this.options.transport.open({
      onData: (raw) => this.handleData(raw),
      onState: (state) => this.handleState(state),
      onError: (error) => this.handleTransportError(error),
      onMedia: (stream) => this.events.onStream?.(stream),
    });
    this.configured = configure;
    this.setStatus('connecting');
    // The managed handle queues sends until the data channel is live, in order,
    // so the world can be handed over immediately.
    this.connection.send(configure);
  }

  /**
   * Sends the next direction. Returns the prompt version it used, so the caller
   * can correlate the server's `prompt_applied` / `prompt_rejected` frames.
   */
  direct(input: {
    prompt?: string;
    endImageUrl?: string | null;
    audioUrl?: string | null;
    audioBehavior?: AudioBehavior;
    replan?: boolean;
  }): number {
    this.assertOpen('direct');
    const promptVersion = this.versions.next();
    const message = buildPrompt({
      promptVersion,
      prompt: input.prompt,
      endImageUrl: input.endImageUrl ?? undefined,
      audioUrl: input.audioUrl ?? undefined,
      audioBehavior: input.audioBehavior,
      replan: input.replan,
    });
    this.connection!.send(message);
    return promptVersion;
  }

  /** Queues a plan-ahead script rather than a single beat. */
  queueScript(beats: ScriptBeat[], mode: ScriptMode = 'replace'): number {
    this.assertOpen('queue a script');
    const promptVersion = this.versions.next();
    const message = buildPrompt({ promptVersion, script: beats, scriptMode: mode });
    this.connection!.send(message);
    return promptVersion;
  }

  /** Swaps the pinned soundtrack mid-stream without touching the picture. */
  setAudio(url: string, behavior: AudioBehavior = 'replace'): number {
    return this.direct({ audioUrl: url, audioBehavior: behavior });
  }

  /** Sends a keepalive frame; the server answers with a pong. */
  ping(): void {
    if (!this.connection || this.stopped) return;
    this.connection.send(buildPing(this.now()));
  }

  /** Sends `stop`, releases the peer connection, and reports the ending once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopPing();
    this.freezeLive();
    this.setStatus('stopping');
    try {
      this.connection?.send(buildStop());
    } catch {
      /* the peer may already be gone; closing is what matters */
    }
    try {
      await this.connection?.close();
    } catch {
      /* already closed */
    }
    this.setStatus('ended');
  }

  private assertOpen(action: string): void {
    if (!this.connection) throw new Error(`cannot ${action} before the session is started`);
    if (this.stopped) throw new Error(`cannot ${action} after the session has stopped`);
  }

  private handleState(state: RealtimeStateName): void {
    this.events.onTransportState?.(state);
    switch (state) {
      case 'opening':
        this.setStatus('connecting');
        break;
      case 'live':
        this.liveSince = this.now();
        this.setStatus('live');
        this.startPing();
        break;
      case 'failed':
        this.freezeLive();
        this.setStatus('failed');
        break;
      case 'closed':
        this.stopPing();
        this.freezeLive();
        if (!this.stopped) this.setStatus('ended');
        break;
      default:
        break;
    }
  }

  private handleTransportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.fatalError = { code: 'transport_error', message };
    this.events.onError?.({ code: 'transport_error', message });
    this.setStatus('failed', message);
  }

  /** Folds the running live stretch into the accumulator, exactly once. */
  private freezeLive(): void {
    if (this.liveSince === null) return;
    this.accumulatedLiveMs += Math.max(0, this.now() - this.liveSince);
    this.liveSince = null;
  }

  private startPing(): void {
    const { schedule, pingIntervalMs } = this.options;
    if (!schedule || this.pingHandle !== null) return;
    this.pingHandle = schedule.set(() => this.ping(), pingIntervalMs ?? 5000);
  }

  private stopPing(): void {
    if (this.pingHandle === null) return;
    this.options.schedule?.clear(this.pingHandle);
    this.pingHandle = null;
  }

  /** Routes one server frame. Unparseable frames are dropped, never thrown. */
  handleData(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'session_info':
        this.sessionInfo = message.info;
        this.events.onSessionInfo?.(message.info);
        break;
      case 'configured':
        this.events.onConfigured?.({
          resolution: message.resolution,
          aspectRatio: message.aspectRatio,
          memory: message.memory,
          chunkDuration: message.chunkDuration,
          hasInitialImage: message.hasInitialImage,
          hasInitialAudio: message.hasInitialAudio,
        });
        break;
      case 'chunk':
        this.lastChunk = message.chunk;
        this.generatedSeconds += Math.max(0, message.chunk.requestedDurationSeconds);
        this.events.onChunk?.(message.chunk);
        break;
      case 'deadline_missed':
        this.events.onBuffering?.({ chunkIndex: message.chunkIndex, lateBySeconds: message.lateBySeconds });
        break;
      case 'prompt_pending':
        this.events.onPromptPending?.(message.promptVersion);
        break;
      case 'prompt_applied':
        this.events.onPromptApplied?.(message.promptVersion, message.scriptQueued);
        break;
      case 'prompt_rejected':
        this.events.onPromptRejected?.({
          promptVersion: message.promptVersion,
          reason: message.reason,
          error: message.error,
        });
        break;
      case 'audio_applied':
        this.events.onAudioApplied?.({
          behavior: message.behavior,
          durationSeconds: message.durationSeconds,
          remainingSeconds: message.remainingSeconds,
        });
        break;
      case 'audio_rejected':
        this.events.onAudioRejected?.({ reason: message.reason, error: message.error });
        break;
      case 'audio_exhausted':
        this.events.onAudioExhausted?.({ chunkIndex: message.chunkIndex, silentSeconds: message.silentSeconds });
        break;
      case 'stream_exhausted':
        this.events.onExhausted?.({ reason: message.reason, chunks: message.chunks });
        break;
      case 'error': {
        const code: StudioErrorCode = asStudioErrorCode(message.code);
        if (FATAL_CODES.has(code)) this.fatalError = { code, message: message.message };
        this.events.onError?.({ code, message: message.message });
        break;
      }
      case 'unknown':
        this.events.onUnknownMessage?.(message.raw);
        break;
      default:
        // pong, session_metrics, audio_pending: no app behaviour depends on them
        break;
    }
  }
}
