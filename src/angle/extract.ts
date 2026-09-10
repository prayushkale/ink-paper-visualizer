import { proxiedVideoUrl } from '../api/client';

/**
 * Multi Angle holds its final camera pose to the end of the clip, so the last
 * frame is exactly the arrival view we hand the Director as a destination.
 */
export function arrivalTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(0, durationSeconds - 0.05);
}

export interface FrameExtractorPort {
  extractArrivalFrame(videoUrl: string): Promise<Blob>;
}

export interface FrameExtractorOptions {
  /** Milliseconds to wait for metadata before giving up. */
  metadataTimeoutMs?: number;
  /** Milliseconds to wait for a seek to settle. */
  seekTimeoutMs?: number;
  /** Optional hook so tests and the UI can observe extractor state. */
  onStatus?(status: string): void;
}

const DEFAULT_METADATA_TIMEOUT = 20_000;
const DEFAULT_SEEK_TIMEOUT = 10_000;

/**
 * Reads a frame out of a fal video by playing it same-origin through
 * /api/proxy-video. Going through our own origin is what keeps the canvas
 * untainted, and an untainted canvas is what makes toBlob() work at all.
 */
export function createFrameExtractor(options: FrameExtractorOptions = {}): FrameExtractorPort {
  const metadataTimeout = options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT;
  const seekTimeout = options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT;

  return {
    async extractArrivalFrame(videoUrl: string): Promise<Blob> {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      video.src = proxiedVideoUrl(videoUrl);
      try {
        options.onStatus?.('loading clip');
        await waitFor(video, 'loadedmetadata', metadataTimeout, 'clip metadata');
        const duration = Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : Number(video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0);
        const time = arrivalTime(duration);
        options.onStatus?.('seeking to the final pose');
        await seek(video, time, seekTimeout);
        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context for frame extraction');
        ctx.drawImage(video, 0, 0, width, height);
        return await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('frame extraction produced no image'))),
            'image/png',
            0.95,
          );
        });
      } finally {
        video.removeAttribute('src');
        video.load();
      }
    },
  };
}

function waitFor(
  target: HTMLVideoElement,
  event: 'loadedmetadata' | 'seeked',
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`failed to load ${label}`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
    }
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function seek(video: HTMLVideoElement, time: number, timeoutMs: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return;
  const settled = waitFor(video, 'seeked', timeoutMs, 'seek');
  video.currentTime = time;
  await settled;
}
