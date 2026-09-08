import type { VideoConfig } from '../state';

export interface SubmitResponse { request_id: string; status_url: string; response_url: string; }
export interface StatusResponse { status: string; videoUrl?: string | null; error?: string; queue_position?: number; }

export const api = {
  async interpret(imageDataUri: string, model: string, visionPrompt: string): Promise<string> {
    const res = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUri, model, visionPrompt }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'interpret failed');
    const data = (await res.json()) as { text: string };
    return data.text;
  },
  async submitVideo(body: { image: string; prompt: string; config: VideoConfig }): Promise<SubmitResponse> {
    const res = await fetch('/api/video/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'submit failed');
    return (await res.json()) as SubmitResponse;
  },
  async videoStatus(statusUrl: string, responseUrl: string): Promise<StatusResponse> {
    const q = `status_url=${encodeURIComponent(statusUrl)}&response_url=${encodeURIComponent(responseUrl)}`;
    const res = await fetch(`/api/video/status?${q}`);
    if (!res.ok) throw new Error((await res.json()).error ?? 'status failed');
    return (await res.json()) as StatusResponse;
  },
};
