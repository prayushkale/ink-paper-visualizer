import { describe, it, expect, afterEach } from 'vitest';
import { FAL_PROXY_URL, falRequestMiddleware, getProxyToken, setProxyToken } from './fal';

const request = () => ({ method: 'POST', url: 'https://queue.fal.run/minimax/h3-max/multi-angle/image-to-video' });

afterEach(() => {
  setProxyToken(null);
});

describe('the fal proxy route', () => {
  it('points the browser client at our own origin, never at fal directly', () => {
    expect(FAL_PROXY_URL).toBe('/api/fal/proxy');
  });
});

describe('setProxyToken', () => {
  it('is off by default, because the proxy binds to loopback', () => {
    expect(getProxyToken()).toBeNull();
  });

  it('normalises blank and whitespace input to no token', () => {
    setProxyToken('   ');
    expect(getProxyToken()).toBeNull();
    setProxyToken('');
    expect(getProxyToken()).toBeNull();
  });

  it('remembers a real token, trimmed', () => {
    setProxyToken('  sekret  ');
    expect(getProxyToken()).toBe('sekret');
  });
});

describe('falRequestMiddleware', () => {
  it('adds the token header only when the server asked for one', async () => {
    setProxyToken(null);
    const bare = await falRequestMiddleware(request());
    expect(bare.headers).toBeUndefined();

    setProxyToken('sekret');
    const signed = await falRequestMiddleware(request());
    expect(signed.headers).toMatchObject({ 'x-ink-token': 'sekret' });
  });

  it('leaves the target url and method alone, since the proxy middleware rewrites those', async () => {
    setProxyToken('sekret');
    const result = await falRequestMiddleware(request());
    expect(result.url).toBe('https://queue.fal.run/minimax/h3-max/multi-angle/image-to-video');
    expect(result.method).toBe('POST');
  });

  it('keeps any headers the client already set', async () => {
    setProxyToken('sekret');
    const result = await falRequestMiddleware({
      ...request(),
      headers: { 'x-fal-object-lifecycle-preference': '{"expiration_duration_seconds":3600}' },
    });
    expect(result.headers).toMatchObject({
      'x-fal-object-lifecycle-preference': '{"expiration_duration_seconds":3600}',
      'x-ink-token': 'sekret',
    });
  });
});
