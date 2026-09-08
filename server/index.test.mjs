import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './index.mjs';

const jsonRes = (body, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => body,
});

// tiny helper: start the app on an ephemeral port, hit it, close it
async function inject(app, method, path, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

const withKeys = (fetchImpl) => createServer({
  fetchImpl,
  env: { OPENROUTER_API_KEY: 'test-or', FAL_KEY: 'test-fal' },
});

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
  const app = createServer({ fetchImpl: async () => { called = true; return jsonRes({}); } });
  const res = await inject(app, 'POST', '/api/interpret', { image: 'data:image/png;base64,AAA' });
  assert.equal(res.status, 500);
  assert.equal(called, false);
});

test('POST /api/interpret rejects non-data-uri image with 400', async () => {
  const app = withKeys(async () => jsonRes({}));
  const res = await inject(app, 'POST', '/api/interpret', { image: 'http://x/y.png' });
  assert.equal(res.status, 400);
});

test('POST /api/video/submit forwards to fal queue with merged extra params', async () => {
  const calls = [];
  const app = withKeys(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return jsonRes({ request_id: 'rq_1', status_url: 's', response_url: 'r' });
  });
  const res = await inject(app, 'POST', '/api/video/submit', {
    image: 'data:image/png;base64,AAA',
    prompt: 'a cinematic sunrise over the blot',
    config: {
      falModel: 'minimax/h3-max-turbo/image-to-video',
      duration: 5, resolution: '768P', promptExpansionMode: 'fast',
      seed: 7, extraParamsJson: '{"subject_motion":"fast"}',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.request_id, 'rq_1');
  const falCall = calls[0];
  assert.equal(falCall.url, 'https://queue.fal.run/minimax/h3-max-turbo/image-to-video');
  assert.equal(falCall.body.image_url, 'data:image/png;base64,AAA');
  assert.equal(falCall.body.duration, 5);
  assert.equal(falCall.body.resolution, '768P');
  assert.equal(falCall.body.prompt_expansion_mode, 'fast');
  assert.equal(falCall.body.seed, 7);
  assert.equal(falCall.body.subject_motion, 'fast'); // extra params merged at top level
  assert.ok(!('extraParamsJson' in falCall.body));
});

test('submit uses default fal model when config.falModel missing', async () => {
  const calls = [];
  const app = withKeys(async (url) => {
    calls.push(url);
    return jsonRes({ request_id: 'rq_2' });
  });
  await inject(app, 'POST', '/api/video/submit', { image: 'data:image/png;base64,AAA', prompt: 'hello world prompt', config: {} });
  assert.equal(calls[0], 'https://queue.fal.run/minimax/h3-max-turbo/image-to-video');
});

test('submit rejects invalid extraParamsJson with 400', async () => {
  let called = false;
  const app = withKeys(async () => { called = true; return jsonRes({}); });
  const res = await inject(app, 'POST', '/api/video/submit', {
    image: 'i', prompt: 'p',
    config: { extraParamsJson: 'not json' },
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('GET /api/video/status maps completed fal payload to videoUrl', async () => {
  let n = 0;
  const app = withKeys(async (url) => {
    n++;
    if (n === 1) return jsonRes({ status: 'COMPLETED', response_url: 'https://f/r' });
    return jsonRes({ video: { url: 'https://cdn/v.mp4' } });
  });
  const res = await inject(app, 'GET',
    '/api/video/status?status_url=' + encodeURIComponent('https://queue.fal.run/x/rq1/status') +
    '&response_url=' + encodeURIComponent('https://f/r'));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'COMPLETED');
  assert.equal(res.body.videoUrl, 'https://cdn/v.mp4');
});

test('GET /api/video/status passes through IN_QUEUE', async () => {
  const app = withKeys(async () => jsonRes({ status: 'IN_QUEUE', queue_position: 2 }));
  const res = await inject(app, 'GET',
    '/api/video/status?status_url=' + encodeURIComponent('https://queue.fal.run/x/s'));
  assert.equal(res.body.status, 'IN_QUEUE');
  assert.equal(res.body.queue, 2);
});

test('GET /api/video/status without status_url returns 400', async () => {
  const app = withKeys(async () => jsonRes({}));
  const res = await inject(app, 'GET', '/api/video/status');
  assert.equal(res.status, 400);
});
