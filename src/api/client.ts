export interface HealthResponse {
  openrouter: boolean;
  fal: boolean;
  realtime: boolean;
  multiAngle: boolean;
  proxyRoute: string;
  authTokenRequired: boolean;
  /** Whether this machine can convert a recording to mp4. */
  ffmpeg: boolean;
}

export interface InterpretRequest {
  image: string;
  model: string;
  visionPrompt: string;
}

/**
 * Browser-facing API. Everything that talks to fal (realtime sessions, Multi
 * Angle, storage uploads) goes through the fal client pointed at `proxyRoute`,
 * never through these routes - the proxy keeps FAL_KEY server-side.
 */
export const api = {
  async health(): Promise<HealthResponse> {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('health failed');
    return (await res.json()) as HealthResponse;
  },

  async interpret({ image, model, visionPrompt }: InterpretRequest): Promise<string> {
    const res = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, model, visionPrompt }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'interpret failed');
    return ((await res.json()) as { text: string }).text;
  },
};

/** Same-origin relay URL for a fal media file, so canvas reads never taint. */
export function proxiedVideoUrl(url: string): string {
  return `/api/proxy-video?url=${encodeURIComponent(url)}`;
}

/**
 * Converts a browser recording into an mp4 using the local ffmpeg route.
 * Only available when ffmpeg is installed; /api/health reports that.
 */
export async function remuxToMp4(blob: Blob): Promise<Blob> {
  const response = await fetch('/api/remux', {
    method: 'POST',
    headers: { 'content-type': blob.type || 'video/webm' },
    body: blob,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `conversion failed (${response.status})`);
  }
  return response.blob();
}

/** Saves a blob to the user's downloads. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `1m 04s` — used by the recording list and the session timer. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
