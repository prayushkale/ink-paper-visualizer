import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  isAllowedMediaUrl,
  isAllowedProxyTarget,
  matchesAny,
  DEFAULT_ALLOWED_ENDPOINTS,
  FAL_PROXY_ROUTE,
} from './index.mjs';

const jsonRes = (body, status = 200) => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Fake upstream that streams a fixed body (used by the media relay tests). */
const streamRes = (chunks, status = 200, headers = {}) => {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }),
  };
};

// tiny helper: start the app on an ephemeral port, hit it, close it
async function inject(app, method, path, body, headers = {}) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body (media relay) */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  } finally {
    server.close();
  }
}

const withKeys = (fetchImpl, env = {}) => createServer({
  fetchImpl,
  env: { OPENROUTER_API_KEY: 'test-or', FAL_KEY: 'test-fal', ...env },
});

const TARGET = 'https://queue.fal.run/minimax/h3-max/multi-angle/image-to-video';

// ---------------------------------------------------------------- interpret

test('POST /api/interpret forwards to openrouter with image content parts', async () => {
  const calls = [];
  const app = withKeys(async (url, opts = {}) => {
    calls.push({ url, body: JSON.parse(opts.body ?? '{}') });
    return jsonRes({ choices: [{ message: { content: 'A phoenix rising.' } }] });
  });
  const res = await inject(app, 'POST', '/api/interpret', {
    image: 'data:image/png;base64,AAA', model: 'm1', visionPrompt: 'vp',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'A phoenix rising.');
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/chat/completions'));
  assert.equal(calls[0].body.model, 'm1');
  assert.equal(calls[0].body.messages.length, 1);
  assert.deepEqual(calls[0].body.messages[0].content[0], { type: 'text', text: 'vp' });
  assert.deepEqual(calls[0].body.messages[0].content[1], {
    type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' },
  });
});

test('POST /api/interpret without key returns 500 and never calls fetch', async () => {
  let called = false;
  const app = createServer({ fetchImpl: async () => { called = true; return jsonRes({}); }, env: {} });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 500);
  assert.equal(called, false);
});

test('POST /api/interpret rejects non-data-uri image with 400', async () => {
  const app = withKeys(async () => jsonRes({}));
  const res = await inject(app, 'POST', '/api/interpret', { image: 'http://x/y.png' });
  assert.equal(res.status, 400);
});

test('POST /api/interpret surfaces HTTP-200-wrapped openrouter error after retrying', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    return jsonRes({ id: 'gen-1', error: { message: 'The operation was aborted', code: 504 } });
  });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /The operation was aborted/);
  assert.equal(res.body.code, 504);
  assert.equal(res.body.attempts, 3);
  assert.equal(calls, 3);
});

test('POST /api/interpret recovers when openrouter 200-error clears on retry', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    if (calls === 1) return jsonRes({ id: 'gen-1', error: { message: 'The operation was aborted', code: 504 } });
    return jsonRes({ choices: [{ message: { content: 'Recovered.' } }] });
  });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'Recovered.');
  assert.equal(calls, 2);
});

test('POST /api/interpret does not retry non-transient openrouter 200-errors', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    return jsonRes({ error: { message: 'Model blocked by guardrail', code: 404 } });
  });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Model blocked by guardrail/);
  assert.equal(res.body.attempts, 1);
  assert.equal(calls, 1);
});

// ------------------------------------------------------------------- health

test('GET /api/health reports key presence without leaking keys', async () => {
  const app = withKeys(async () => jsonRes({}));
  const res = await inject(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(
    { openrouter: res.body.openrouter, fal: res.body.fal, realtime: res.body.realtime, multiAngle: res.body.multiAngle },
    { openrouter: true, fal: true, realtime: true, multiAngle: true },
  );
  assert.equal(res.body.proxyRoute, FAL_PROXY_ROUTE);
  assert.ok(!JSON.stringify(res.body).includes('test-fal'));
  assert.ok(!JSON.stringify(res.body).includes('test-or'));
});

// ------------------------------------------------------- proxy target rules

test('matchesAny handles the /** suffix patterns we rely on', () => {
  assert.equal(matchesAny('minimax/h3-max/director', ['minimax/h3-max/**']), true);
  assert.equal(matchesAny('minimax/h3-max/multi-angle/image-to-video', ['minimax/h3-max/**']), true);
  assert.equal(matchesAny('minimax/h3-max', ['minimax/h3-max/**']), true);
  assert.equal(matchesAny('fal-ai/flux/dev', ['minimax/h3-max/**']), false);
  assert.equal(matchesAny('anything', []), true);
});

test('isAllowedProxyTarget permits director, multi angle, storage and polls', () => {
  const E = DEFAULT_ALLOWED_ENDPOINTS;
  assert.equal(isAllowedProxyTarget(TARGET, E), true);
  assert.equal(isAllowedProxyTarget('https://queue.fal.run/minimax/h3-max/multi-angle/image-to-video/requests/x/status', E), true);
  assert.equal(isAllowedProxyTarget('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', E), true);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/session', E, { app_id: 'minimax/h3-max/director' }), true);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/session/heartbeat', E, {}, 'POST'), true);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/ice', E, {}, 'POST'), true);
});

test('isAllowedProxyTarget refuses everything outside the allowlists', () => {
  const E = DEFAULT_ALLOWED_ENDPOINTS;
  assert.equal(isAllowedProxyTarget('https://evil.example.com/steal', E), false);
  assert.equal(isAllowedProxyTarget('http://queue.fal.run/minimax/h3-max/x', E), false, 'https only');
  assert.equal(isAllowedProxyTarget('file:///etc/passwd', E), false);
  assert.equal(isAllowedProxyTarget('not a url', E), false);
  assert.equal(isAllowedProxyTarget('https://api.openai.com/v1/chat', E), false);
  assert.equal(isAllowedProxyTarget('https://queue.fal.run/fal-ai/flux/dev', E), false);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/admin', E, {}, 'POST'), false);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/session', E, { app_id: 'fal-ai/flux' }), false);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/session', E, {}, 'GET'), false);
  assert.equal(isAllowedProxyTarget('https://wma.fal.run/session', E, {}, 'DELETE'), false);
});

// ------------------------------------------------------------- proxy route

test('fal proxy injects the server key and forwards to the queued endpoint', async () => {
  const calls = [];
  const app = withKeys(async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    return jsonRes({ video: { url: 'https://fal.media/x.mp4' } });
  });
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, { image_url: 'https://fal.media/b.png' }, {
    'x-fal-target-url': TARGET,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.video.url, 'https://fal.media/x.mp4');
  assert.equal(calls[0].url, TARGET);
  assert.equal(calls[0].headers.authorization, 'Key test-fal');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { image_url: 'https://fal.media/b.png' });
});

test('fal proxy forwards WMA signalling for the director session', async () => {
  const calls = [];
  const app = withKeys(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return jsonRes({ session_id: 'sess_1', sdp: 'v=0' });
  });
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {
    app_id: 'minimax/h3-max/director', sdp: 'v=0',
  }, { 'x-fal-target-url': 'https://wma.fal.run/session' });
  assert.equal(res.status, 200);
  assert.equal(res.body.session_id, 'sess_1');
  assert.equal(calls[0].url, 'https://wma.fal.run/session');
  assert.equal(calls[0].body.app_id, 'minimax/h3-max/director');
});

test('fal proxy passes x-fal-* request headers through but never the target header', async () => {
  const calls = [];
  const app = withKeys(async (_url, opts) => {
    calls.push(opts.headers);
    return jsonRes({});
  });
  await inject(app, 'POST', FAL_PROXY_ROUTE, {}, {
    'x-fal-target-url': TARGET,
    'x-fal-object-lifecycle-preference': '{"expiration_duration_seconds":3600}',
  });
  assert.equal(calls[0]['x-fal-object-lifecycle-preference'], '{"expiration_duration_seconds":3600}');
  assert.equal(calls[0]['x-fal-target-url'], undefined);
});

test('fal proxy does not send a body on GET polls', async () => {
  const calls = [];
  const app = withKeys(async (url, opts) => {
    calls.push({ url, body: opts.body });
    return jsonRes({ status: 'COMPLETED' });
  });
  await inject(app, 'GET', `${FAL_PROXY_ROUTE}?x=1`, undefined, {
    'x-fal-target-url': 'https://queue.fal.run/minimax/h3-max/multi-angle/image-to-video/requests/r1/status',
  });
  assert.equal(calls[0].body, undefined);
});

test('fal proxy rejects a target URL outside the allowlist', async () => {
  let called = false;
  const app = withKeys(async () => { called = true; return jsonRes({}); });
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {}, {
    'x-fal-target-url': 'https://evil.example.com/steal',
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('fal proxy rejects an endpoint outside DEFAULT_ALLOWED_ENDPOINTS', async () => {
  let called = false;
  const app = withKeys(async () => { called = true; return jsonRes({}); });
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {}, {
    'x-fal-target-url': 'https://queue.fal.run/fal-ai/flux/dev',
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('fal proxy requires the target header', async () => {
  const app = withKeys(async () => jsonRes({}));
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /x-fal-target-url/);
});

test('fal proxy enforces the local auth token when configured', async () => {
  let called = false;
  const app = withKeys(async () => { called = true; return jsonRes({}); }, { PROXY_AUTH_TOKEN: 'sekret' });
  const denied = await inject(app, 'POST', FAL_PROXY_ROUTE, {}, { 'x-fal-target-url': TARGET });
  assert.equal(denied.status, 401);
  assert.equal(called, false);

  const allowed = await inject(app, 'POST', FAL_PROXY_ROUTE, {}, {
    'x-fal-target-url': TARGET, 'x-ink-token': 'sekret',
  });
  assert.equal(allowed.status, 200);
  assert.equal(called, true);
});

test('fal proxy returns 500 instead of crashing when FAL_KEY is absent', async () => {
  const app = createServer({ fetchImpl: async () => jsonRes({}), env: { OPENROUTER_API_KEY: 'x' } });
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {}, { 'x-fal-target-url': TARGET });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /FAL_KEY/);
});

test('fal proxy surfaces upstream failures as 502', async () => {
  const app = withKeys(async () => { throw new Error('socket hang up'); });
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {}, { 'x-fal-target-url': TARGET });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /socket hang up/);
});

// -------------------------------------------------------------- media relay

test('isAllowedMediaUrl permits fal media hosts and rejects everything else', () => {
  assert.equal(isAllowedMediaUrl('https://fal.media/files/a.mp4'), true);
  assert.equal(isAllowedMediaUrl('https://v3b.fal.media/files/a.mp4'), true);
  assert.equal(isAllowedMediaUrl('https://queue.fal.run/x'), true);
  assert.equal(isAllowedMediaUrl('https://storage.googleapis.com/falserverless/x.png'), true);
  assert.equal(isAllowedMediaUrl('https://storage.googleapis.com/other-bucket/x.png'), false);
  assert.equal(isAllowedMediaUrl('http://fal.media/a.mp4'), false);
  assert.equal(isAllowedMediaUrl('https://evil.example.com/a.mp4'), false);
  assert.equal(isAllowedMediaUrl('not a url'), false);
  assert.equal(isAllowedMediaUrl('file:///etc/passwd'), false);
});

test('GET /api/proxy-video streams allowed media through the server origin', async () => {
  const app = withKeys(async (url) => {
    assert.equal(url, 'https://fal.media/files/a.mp4');
    return streamRes(['he', 'llo'], 200, { 'content-type': 'video/mp4' });
  });
  const res = await inject(app, 'GET', `/api/proxy-video?url=${encodeURIComponent('https://fal.media/files/a.mp4')}`);
  assert.equal(res.status, 200);
  assert.equal(res.text, 'hello');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('GET /api/proxy-video forwards HTTP 206 range responses', async () => {
  const app = withKeys(async (_url, opts) => {
    assert.equal(opts.headers.range, 'bytes=0-1');
    return streamRes(['he'], 206, { 'content-range': 'bytes 0-1/5' });
  });
  const res = await inject(
    app, 'GET',
    `/api/proxy-video?url=${encodeURIComponent('https://fal.media/files/a.mp4')}`,
    undefined,
    { range: 'bytes=0-1' },
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-1/5');
});

test('GET /api/proxy-video refuses non-whitelisted hosts without fetching', async () => {
  let called = false;
  const app = withKeys(async () => { called = true; return streamRes(['x']); });
  const res = await inject(app, 'GET', `/api/proxy-video?url=${encodeURIComponent('https://evil.example.com/a.mp4')}`);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('GET /api/proxy-video requires a url param', async () => {
  const app = withKeys(async () => streamRes(['x']));
  const res = await inject(app, 'GET', '/api/proxy-video');
  assert.equal(res.status, 400);
});

// --------------------------------------------------------- removed surfaces

test('the legacy queue clip routes are gone', async () => {
  const app = withKeys(async () => jsonRes({}));
  const submit = await inject(app, 'POST', '/api/video/submit', { prompt: 'hello world' });
  assert.equal(submit.status, 404);
  const status = await inject(app, 'GET', '/api/video/status?status_url=x');
  assert.equal(status.status, 404);
});
