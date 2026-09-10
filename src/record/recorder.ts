export type RecordingContainer = 'mp4' | 'webm' | 'ogg' | 'unknown';

export interface RecordingSupport {
  isTypeSupported(mime: string): boolean;
}

/**
 * Container candidates, best first.
 *
 * An mp4 is the only thing a social platform will take without a conversion
 * step, so it is tried first wherever the browser can produce one. WebM is the
 * reliable fallback, and it can be converted locally with ffmpeg afterwards.
 */
export function recordingCandidates(preferMp4 = true): string[] {
  const mp4 = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
  ];
  const webm = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return preferMp4 ? [...mp4, ...webm] : [...webm, ...mp4];
}

export function containerOf(mime: string): RecordingContainer {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  if (base === 'video/mp4') return 'mp4';
  if (base === 'video/webm') return 'webm';
  if (base === 'video/ogg') return 'ogg';
  return 'unknown';
}

export interface ChosenRecording {
  mime: string;
  container: RecordingContainer;
}

/** Picks the best container this browser will actually record. */
export function chooseRecordingMime(support: RecordingSupport, preferMp4 = true): ChosenRecording | null {
  for (const mime of recordingCandidates(preferMp4)) {
    try {
      if (support.isTypeSupported(mime)) return { mime, container: containerOf(mime) };
    } catch {
      /* an exotic implementation: keep trying */
    }
  }
  return null;
}

/** The subset of MediaRecorder the recorder actually uses. */
export interface RecorderLike {
  start(timesliceMs?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  addEventListener(type: 'dataavailable', listener: (event: { data: Blob }) => void): void;
  addEventListener(type: 'stop' | 'error', listener: (event: unknown) => void): void;
}

export interface RecorderOptions {
  support?: RecordingSupport;
  createRecorder?: (stream: MediaStream, mime: string) => RecorderLike;
  /** Defaults to mp4-first. */
  preferMp4?: boolean;
  /** How often the browser hands over a chunk. */
  timesliceMs?: number;
  now?: () => number;
  /** Converts a webm into an mp4 using the local ffmpeg proxy route. */
  remux?: (blob: Blob) => Promise<Blob>;
}

export interface Recording {
  blob: Blob;
  mime: string;
  container: RecordingContainer;
  durationMs: number;
  bytes: number;
  /** True when an ffmpeg remux produced an mp4 from another container. */
  remuxed: boolean;
}

export class RecorderUnavailableError extends Error {
  constructor() {
    super('this browser cannot record a stream: MediaRecorder found no usable container');
    this.name = 'RecorderUnavailableError';
  }
}

/**
 * Records the live stream to a file.
 *
 * The stream is a WebRTC receive track, so there is no file on the server to
 * collect: whatever the user gets is what the browser chose to write down.
 */
export class StreamRecorder {
  private recorder: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private chosen: ChosenRecording | null = null;
  private startedAt = 0;
  private pausedMs = 0;
  private pausedAt: number | null = null;
  private stopped: Promise<Recording | null> | null = null;
  private error: unknown = null;
  /** Set when the browser's recorder has stopped, however it got there. */
  private ended = false;
  private endWaiters: Array<() => void> = [];

  private readonly now: () => number;

  constructor(private readonly options: RecorderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  get state(): 'idle' | 'recording' | 'paused' | 'stopping' {
    if (!this.recorder) return 'idle';
    if (this.stopped) return 'stopping';
    if (this.pausedAt !== null) return 'paused';
    return 'recording';
  }

  get container(): RecordingContainer | null {
    return this.chosen?.container ?? null;
  }

  /** Starts recording. Returns what it will produce, or throws if it cannot. */
  start(stream: MediaStream): ChosenRecording {
    if (this.recorder) throw new Error('already recording');
    const support = this.options.support ?? (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    if (!support) throw new RecorderUnavailableError();
    const chosen = chooseRecordingMime(support, this.options.preferMp4 ?? true);
    if (!chosen) throw new RecorderUnavailableError();
    const create = this.options.createRecorder
      ?? ((target: MediaStream, mime: string) => new MediaRecorder(target, { mimeType: mime }) as unknown as RecorderLike);
    const recorder = create(stream, chosen.mime);
    this.chosen = chosen;
    this.chunks = [];
    this.error = null;
    this.ended = false;
    this.endWaiters = [];
    this.startedAt = this.now();
    this.pausedMs = 0;
    this.pausedAt = null;
    this.recorder = recorder;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener('error', (event) => {
      this.error = event;
      // an errored recorder will never fire stop; finalise what was captured
      this.markEnded();
    });
    // Registered here rather than inside stop(): the browser stops a recorder
    // itself once every track of its stream has ended, and that is exactly what
    // happens when the session behind the stream dies. A listener attached only
    // for the duration of stop() would miss it and wait forever.
    recorder.addEventListener('stop', () => this.markEnded());
    recorder.start(this.options.timesliceMs ?? 1000);
    return chosen;
  }

  /** Latches the end of recording and releases anyone waiting on it. */
  private markEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.stoppedAt = this.now();
    const waiters = this.endWaiters;
    this.endWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolves once the recorder has stopped, or once waiting stops being useful. */
  private waitForEnd(timeoutMs = 5000): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.endWaiters = this.endWaiters.filter((waiter) => waiter !== done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.endWaiters.push(done);
    });
  }

  pause(): void {
    if (!this.recorder || this.pausedAt !== null) return;
    this.pausedAt = this.now();
    try {
      this.recorder.pause();
    } catch {
      /* some implementations refuse to pause; the clock still stops */
    }
  }

  resume(): void {
    if (!this.recorder || this.pausedAt === null) return;
    this.pausedMs += this.now() - this.pausedAt;
    this.pausedAt = null;
    try {
      this.recorder.resume();
    } catch {
      /* nothing to do: recording continues regardless */
    }
  }

  /** The elapsed recorded wall-clock time, excluding any paused stretch. */
  elapsedMs(): number {
    if (!this.recorder) return 0;
    const end = this.stopped ? this.stoppedAt : this.now();
    const paused = this.pausedAt !== null ? end - this.pausedAt : 0;
    return Math.max(0, end - this.startedAt - this.pausedMs - paused);
  }

  private stoppedAt = 0;

  /**
   * Stops and finalises. Resolves with null when nothing was recorded, which is
   * an ordinary outcome for a session that lasted a few seconds.
   */
  async stop(): Promise<Recording | null> {
    if (this.stopped) return this.stopped;
    const recorder = this.recorder;
    if (!recorder) return null;
    const chosen = this.chosen!;
    this.stopped = (async () => {
      if (!this.ended) {
        const settled = this.waitForEnd();
        try {
          recorder.stop();
        } catch {
          // already stopped by the browser: the latch above still releases us
        }
        await settled;
      }
      const durationMs = this.elapsedMs();
      const raw = new Blob(this.chunks, { type: chosen.mime });
      this.chunks = [];
      if (raw.size === 0) return null;
      let blob = raw;
      let container = chosen.container;
      let remuxed = false;
      if (container !== 'mp4' && this.options.remux) {
        try {
          const converted = await this.options.remux(raw);
          if (converted.size > 0) {
            blob = converted;
            container = 'mp4';
            remuxed = true;
          }
        } catch {
          // conversion is a nicety: keep the original rather than losing it
        }
      }
      return { blob, mime: blob.type, container, durationMs, bytes: blob.size, remuxed };
    })();
    return this.stopped;
  }

  /** Clears state so a chained session can record again. */
  reset(): void {
    this.recorder = null;
    this.chosen = null;
    this.chunks = [];
    this.stopped = null;
    this.error = null;
    this.ended = false;
    this.endWaiters = [];
    this.pausedAt = null;
    this.pausedMs = 0;
    this.startedAt = 0;
    this.stoppedAt = 0;
  }

  get lastError(): unknown {
    return this.error;
  }
}
