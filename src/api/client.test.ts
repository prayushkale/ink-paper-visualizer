import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadBlob, formatDuration, remuxToMp4 } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remuxToMp4', () => {
  it('posts the recording and returns the converted file', async () => {
    const converted = new Blob([new Uint8Array(128)], { type: 'video/mp4' });
    const fetchMock = vi.fn(async () => new Response(converted, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await remuxToMp4(new Blob(['webm'], { type: 'video/webm' }));
    expect(result.type).toBe('video/mp4');
    expect(result.size).toBe(128);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/remux');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('video/webm');
  });

  it('surfaces the server reason when ffmpeg is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'ffmpeg is not available on this machine' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )));
    await expect(remuxToMp4(new Blob(['x']))).rejects.toThrow(/ffmpeg is not available/);
  });

  it('falls back to a generic message when the body has no reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(remuxToMp4(new Blob(['x']))).rejects.toThrow(/conversion failed \(500\)/);
  });
});

describe('formatDuration', () => {
  it('reads naturally at every scale', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(9_400)).toBe('9s');
    expect(formatDuration(64_000)).toBe('1m 04s');
    expect(formatDuration(120_000)).toBe('2m 00s');
  });

  it('never reports a negative duration', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('downloadBlob', () => {
  it('clicks a temporary link, names the file, and cleans it up', () => {
    const link = { click: vi.fn(), remove: vi.fn(), href: '', download: '' };
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('document', {
      createElement: () => link,
      body: { appendChild: vi.fn() },
    });
    downloadBlob(new Blob(['x'], { type: 'video/mp4' }), 'ink-film.mp4');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(link.href).toBe('blob:fake');
    expect(link.download).toBe('ink-film.mp4');
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it('revokes the object url once the download has started', () => {
    vi.useFakeTimers();
    const link = { click: vi.fn(), remove: vi.fn(), href: '', download: '' };
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL });
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: vi.fn() } });
    downloadBlob(new Blob(['x']), 'a.mp4');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    vi.useRealTimers();
  });
});
