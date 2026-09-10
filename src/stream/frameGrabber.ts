export interface GrabbedFrame {
  blob: Blob;
  /** Wall-clock ms when the frame was taken. */
  at: number;
  width: number;
  height: number;
}

export interface FrameGrabberPort {
  start(): void;
  stop(): void;
  /**
   * Takes a frame right now. Used at a handover, where the newest possible
   * picture matters more than the interval.
   */
  grabNow(): Promise<GrabbedFrame | null>;
  latest(): GrabbedFrame | null;
  dispose(): void;
}

export interface FrameGrabberOptions {
  /** A muted <video> attached to the live MediaStream. */
  video: HTMLVideoElement;
  /** How often to refresh the rolling frame, in ms. */
  intervalMs?: number;
  /** Longest edge of the captured frame; the model only needs 768p. */
  maxEdge?: number;
  onStatus?(message: string): void;
  /** Injected for tests. */
  schedule?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  now?(): number;
}

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_EDGE = 1344;

/** Whether the rolling frame is stale enough to refresh. */
export function frameIsStale(lastAt: number | null, now: number, intervalMs: number): boolean {
  if (lastAt === null) return true;
  return now - lastAt >= intervalMs;
}

/** Scales a video frame down to the model's working size, keeping the ratio. */
export function scaledFrameSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width: Math.max(1, width), height: Math.max(1, height) };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Keeps the newest frame of the live stream in hand.
 *
 * Sessions are not resumable, so a chain's seam is only invisible if the next
 * session starts on this one's last picture. Refreshing on a timer means the
 * frame is already there when the server ends a session, rather than racing a
 * teardown to read one.
 */
export function createFrameGrabber(options: FrameGrabberOptions): FrameGrabberPort {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? {
    set: (fn: () => void, ms: number) => setInterval(fn, ms),
    clear: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let handle: unknown = null;
  let frame: GrabbedFrame | null = null;
  let disposed = false;

  const grabNow = async (): Promise<GrabbedFrame | null> => {
    const video = options.video;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null;
    try {
      const size = scaledFrameSize(video.videoWidth, video.videoHeight, maxEdge);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) return null;
      frame = { blob, at: now(), width: size.width, height: size.height };
      return frame;
    } catch (error) {
      options.onStatus?.(`could not capture a frame: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const tick = (): void => {
    if (disposed) return;
    void grabNow();
  };

  return {
    start(): void {
      if (handle !== null || disposed) return;
      options.onStatus?.('keeping the last frame in hand for the next session');
      void grabNow();
      handle = schedule.set(tick, intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      schedule.clear(handle);
      handle = null;
    },
    grabNow,
    latest: () => frame,
    dispose(): void {
      disposed = true;
      if (handle !== null) schedule.clear(handle);
      handle = null;
      frame = null;
    },
  };
}
