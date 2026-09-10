export interface HealthResponse {
  openrouter: boolean;
  fal: boolean;
  realtime: boolean;
  multiAngle: boolean;
  proxyRoute: string;
  authTokenRequired: boolean;
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
