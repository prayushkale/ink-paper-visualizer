import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemuxArgs,
  createServer,
  detectFfmpeg,
  isAllowedMediaUrl,
  isAllowedProxyTarget,
  legibleFalError,
  matchesAny,
  upstreamErrorDetail,
  DEFAULT_ALLOWED_ENDPOINTS,
  FAL_PROXY_ROUTE,
} from './index.mjs';

const HAS_FFMPEG = detectFfmpeg();

const jsonRes = (body, status = 200) => ({
  ok: status < 300,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
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

test('POST /api/interpret retries a transient HTTP status from openrouter', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    if (calls === 1) return jsonRes({ error: { message: 'Provider returned error' } }, 502);
    return jsonRes({ choices: [{ message: { content: 'Recovered.' } }] });
  }, { VISION_RETRY_DELAY_MS: '0' });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'Recovered.');
  assert.equal(calls, 2);
});

test('POST /api/interpret gives up on a persistent 5xx and reports the attempts', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    return jsonRes({ error: { message: 'Provider returned error' } }, 503);
  }, { VISION_RETRY_DELAY_MS: '0' });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Provider returned error/);
  assert.equal(res.body.attempts, 3);
  assert.equal(calls, 3);
});

test('POST /api/interpret passes a non-retryable HTTP status straight through', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    return jsonRes({ error: { message: 'No auth credentials found' } }, 401);
  });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /No auth credentials found/);
  assert.equal(calls, 1);
});

test('upstreamErrorDetail unwraps the provider complaint openrouter hides', () => {
  assert.equal(
    upstreamErrorDetail({
      message: 'Provider returned error',
      code: 400,
      metadata: { raw: '{"error":{"message":"unsupported image"}}' },
    }),
    'unsupported image',
  );
  assert.equal(upstreamErrorDetail({ message: 'no metadata here' }), null);
  assert.equal(upstreamErrorDetail({ metadata: { raw: 'not json' } }), 'not json');
});

test('POST /api/interpret surfaces the real provider complaint', async () => {
  let calls = 0;
  const app = withKeys(async () => {
    calls++;
    return jsonRes({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: { raw: '{"error":{"message":"You have uploaded an unsupported image"}}' },
      },
    }, 400);
  }, { VISION_RETRY_DELAY_MS: '0' });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Provider returned error: You have uploaded an unsupported image/);
  // an unsupported image is not a hiccup: it must not be replayed
  assert.equal(calls, 1);
});

test('POST /api/interpret defaults to the deepseek vision model', async () => {
  const calls = [];
  const app = withKeys(async (url, opts = {}) => {
    calls.push(JSON.parse(opts.body ?? '{}'));
    return jsonRes({ choices: [{ message: { content: 'ok' } }] });
  });
  await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(calls[0].model, 'deepseek/deepseek-v4.1-flash');
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

// ------------------------------------------------------- legible fal errors

test('legibleFalError turns a fal detail string into a message', () => {
  const rewritten = legibleFalError(JSON.stringify({ detail: 'Error initiating upload' }));
  assert.deepEqual(JSON.parse(rewritten), { detail: 'Error initiating upload', message: 'Error initiating upload' });
});

test('legibleFalError joins the Pydantic detail array', () => {
  const rewritten = legibleFalError(JSON.stringify({
    detail: [{ msg: 'Field required', loc: ['body', 'file_name'] }, { msg: 'bad content type' }],
  }));
  assert.equal(JSON.parse(rewritten).message, 'Field required; bad content type');
});

test('legibleFalError leaves a body that already has a message alone', () => {
  const body = JSON.stringify({ message: 'fine', detail: 'ignored' });
  assert.equal(legibleFalError(body), null);
});

test('legibleFalError ignores anything that is not a JSON object', () => {
  assert.equal(legibleFalError('<html>Internal Server Error</html>'), null);
  assert.equal(legibleFalError(JSON.stringify({ detail: 42 })), null);
  assert.equal(legibleFalError(JSON.stringify(['a'])), null);
});

// The storage service answers an upload it will not host with a 500 whose only
// detail is a `detail` string, which the browser client reads as the bare HTTP
// status text - "Internal Server Error". Add the `message` it looks for.
test('fal proxy makes an upstream fal error body legible', async () => {
  const app = withKeys(async () => jsonRes({ detail: 'Error initiating upload' }, 500));
  const res = await inject(app, 'POST', FAL_PROXY_ROUTE, {
    content_type: 'text/html', file_name: 'ambient-music-bed.mp3',
  }, { 'x-fal-target-url': 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3' });
  assert.equal(res.status, 500);
  assert.equal(res.body.detail, 'Error initiating upload');
  assert.equal(res.body.message, 'Error initiating upload');
});

test('fal proxy leaves a successful body and a non-JSON error untouched', async () => {
  const ok = withKeys(async () => jsonRes({ file_url: 'https://v3b.fal.media/x.png' }));
  const uploaded = await inject(ok, 'POST', FAL_PROXY_ROUTE, {}, {
    'x-fal-target-url': 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
  });
  assert.deepEqual(uploaded.body, { file_url: 'https://v3b.fal.media/x.png' });

  const html = withKeys(async () => ({
    ok: false, status: 500, headers: { get: () => 'text/html' },
    text: async () => '<html>Internal Server Error</html>',
  }));
  const broken = await inject(html, 'POST', FAL_PROXY_ROUTE, {}, {
    'x-fal-target-url': 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
  });
  assert.equal(broken.status, 500);
  assert.match(broken.text, /Internal Server Error/);
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

// ------------------------------------------------------------------ remux

test('buildRemuxArgs produces a faststart h264/aac mp4', () => {
  const args = buildRemuxArgs('/tmp/in.webm', '/tmp/out.mp4');
  assert.ok(args.includes('-i'));
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/in.webm');
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('+faststart'));
  assert.equal(args[args.length - 1], '/tmp/out.mp4');
});

test('POST /api/remux refuses to run when ffmpeg is missing', async () => {
  const app = createServer({
    fetchImpl: async () => jsonRes({}),
    env: { FAL_KEY: 'k' },
    hasFfmpeg: false,
  });
  const res = await inject(app, 'POST', '/api/remux', { some: 'webm' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /ffmpeg is not available/);
});

test('POST /api/remux rejects an empty recording', async () => {
  const app = createServer({ fetchImpl: async () => jsonRes({}), env: { FAL_KEY: 'k' }, hasFfmpeg: true });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/remux`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm' },
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /no recording received/);
  } finally {
    server.close();
  }
});

test('POST /api/remux reports an ffmpeg failure rather than hanging', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      child.stderr.emit('data', 'Invalid data found when processing input');
      child.emit('close', 1);
    }, 1);
    return child;
  };
  const app = createServer({
    fetchImpl: async () => jsonRes({}),
    env: { FAL_KEY: 'k' },
    hasFfmpeg: true,
    spawnImpl,
    workDir: mkdtempSync(join(tmpdir(), 'ink-remux-test-')),
  });
  const res = await inject(app, 'POST', '/api/remux', { fake: true }, { 'content-type': 'video/webm' });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /ffmpeg failed \(1\)/);
  assert.match(res.body.error, /Invalid data/);
});

test('POST /api/remux streams back the converted file', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ink-remux-ok-'));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii')]);
  const spawnImpl = (_binary, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const output = args[args.length - 1];
    setTimeout(() => {
      writeFileSync(output, mp4);
      child.emit('close', 0);
    }, 1);
    return child;
  };
  const app = createServer({
    fetchImpl: async () => jsonRes({}),
    env: { FAL_KEY: 'k' },
    hasFfmpeg: true,
    spawnImpl,
    workDir,
  });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/remux`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm' },
      body: Buffer.from('fake webm bytes'),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.match(response.headers.get('content-disposition') ?? '', /ink-film\.mp4/);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, mp4.length);
    assert.equal(body.subarray(4, 12).toString('ascii'), 'ftypisom');
  } finally {
    server.close();
  }
});

test('POST /api/remux really converts a webm when ffmpeg is present', { skip: !HAS_FFMPEG }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ink-remux-real-'));
  const source = join(workDir, 'source.webm');
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=12:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libvpx', '-c:a', 'libopus', source,
    ]);
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fixture ffmpeg exited ${code}`))));
  });
  const app = createServer({
    fetchImpl: async () => jsonRes({}),
    env: { FAL_KEY: 'k' },
    hasFfmpeg: true,
    workDir,
  });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/remux`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm' },
      body: readFileSync(source),
    });
    assert.equal(response.status, 200);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.length > 0, 'converted file is empty');
    assert.equal(body.subarray(4, 8).toString('ascii'), 'ftyp', 'output is not an mp4');
    const produced = join(workDir, 'verify.mp4');
    writeFileSync(produced, body);
    const hasVideo = await new Promise((resolve) => {
      const probe = spawn('ffmpeg', ['-hide_banner', '-i', produced, '-f', 'null', '-']);
      let log = '';
      probe.stderr.on('data', (data) => { log += String(data); });
      probe.on('close', (code) => resolve(code === 0 && /Video: h264/.test(log)));
    });
    assert.ok(hasVideo, 'converted file has no h264 video stream');
  } finally {
    server.close();
  }
});

// --------------------------------------------------------- removed surfaces

test('the legacy queue clip routes are gone', async () => {
  const app = withKeys(async () => jsonRes({}));
  const submit = await inject(app, 'POST', '/api/video/submit', { prompt: 'hello world' });
  assert.equal(submit.status, 404);
  const status = await inject(app, 'GET', '/api/video/status?status_url=x');
  assert.equal(status.status, 404);
});
