import dotenv from 'dotenv';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';

/**
 * `.env` is the single source of truth for this app's credentials.
 *
 * `dotenv` does not overwrite variables that are already set, and a stale
 * `export FAL_KEY=...` / `export OPENROUTER_API_KEY=...` in a shell rc file
 * would otherwise silently shadow `.env` (which is what makes the app look
 * like it is ignoring the key you just edited). `override: true` makes the
 * file win, so what you see in `.env` is what the server uses.
 */
dotenv.config({ override: true });

/** The fal server-proxy contract header carrying the real upstream URL. */
export const TARGET_URL_HEADER = 'x-fal-target-url';
/** Default proxy route the browser fal client is pointed at. */
export const FAL_PROXY_ROUTE = '/api/fal/proxy';

/**
 * Endpoint IDs the browser client may reach through the proxy.
 * `minimax/h3-max/**` covers the Director realtime app id and the Multi Angle
 * queue endpoint; the alias form covers the WMA bridge `app_id`.
 */
export const DEFAULT_ALLOWED_ENDPOINTS = ['minimax/h3-max/**', 'fal-ai/minimax-h3-max-director'];

/** WMA signalling bridge. Only these paths are reachable on it. */
export const SERVICE_HOST = 'wma.fal.run';
const SERVICE_APP_SCOPED_PATHS = new Set(['/ice', '/session']);
const SERVICE_SESSION_SCOPED_PATHS = new Set(['/session/heartbeat']);

/** Hosts we will relay video bytes from, for same-origin frame extraction. */
const MEDIA_HOSTS = ['fal.media', 'fal.run', 'fal.ai'];

/** picomatch-style matcher narrow enough for our allowlists. */
export function matchesAny(value, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) =>
    pattern.endsWith('/**')
      ? value === pattern.slice(0, -3) || value.startsWith(pattern.slice(0, -2))
      : value === pattern);
}

/** Exact storage paths the fal client uses for uploads. */
function isAllowedRestPath(pathname) {
  return pathname.startsWith('/storage/');
}

/**
 * Decides whether the proxy may forward to `rawUrl`.
 * Mirrors the semantics of fal's own server-proxy allowlist.
 */
export function isAllowedProxyTarget(rawUrl, allowedEndpoints = DEFAULT_ALLOWED_ENDPOINTS, body = {}, method = 'POST') {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

  if (host === SERVICE_HOST) {
    // The signalling bridge only answers POST.
    if (String(method).toUpperCase() !== 'POST') return false;
    const appScoped = SERVICE_APP_SCOPED_PATHS.has(path);
    if (appScoped) {
      const appId = typeof body?.app_id === 'string' ? body.app_id : undefined;
      if (!appId) return path === '/ice'; // /ice only mints TURN credentials
      return matchesAny(appId, allowedEndpoints);
    }
    return SERVICE_SESSION_SCOPED_PATHS.has(path);
  }

  // fal storage / other REST hosts
  if (host === 'rest.fal.ai') return isAllowedRestPath(path);

  // queue + direct run hosts are the only other surfaces we expose
  const isRunHost = host === 'fal.run' || host.endsWith('.fal.run');
  const isQueueHost = host === 'queue.fal.run' || host.endsWith('.queue.fal.run');
  if (!isRunHost && !isQueueHost) return false;

  // POSTs carry an endpoint id in the path; GETs are polls and are allowed.
  return matchesAny(path.replace(/^\//, ''), allowedEndpoints);
}

/** true when `url` is an https URL on a host/prefix we are willing to relay. */
export function isAllowedMediaUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (host === 'storage.googleapis.com') return url.pathname.startsWith('/falserverless/');
  return false;
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Is a usable ffmpeg on this machine? Reported by /api/health. */
export function detectFfmpeg(spawnSyncImpl = nodeSpawnSync, binary = process.env.FFMPEG_PATH || 'ffmpeg') {
  try {
    const result = spawnSyncImpl(binary, ['-version'], { stdio: 'ignore' });
    return result?.status === 0;
  } catch {
    return false;
  }
}

/**
 * ffmpeg arguments for turning a browser recording into an mp4 that a social
 * platform will accept. Written to a temp file rather than stdout so the moov
 * atom lands at the front (`+faststart`), which is what makes it seekable.
 */
export function buildRemuxArgs(input, output, { crf = 20, preset = 'veryfast', audioBitrate = '160k' } = {}) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', audioBitrate,
    '-movflags', '+faststart',
    output,
  ];
}

const REMUX_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Pull the real complaint out of an OpenRouter error.
 *
 * When an upstream provider rejects a request OpenRouter collapses everything
 * to `{"message":"Provider returned error","code":400}` and buries the useful
 * sentence in `error.metadata.raw` as a JSON string. Without this a bad image
 * or a model the provider will not serve is invisible in the UI.
 */
export function upstreamErrorDetail(bodyError) {
  const raw = bodyError?.metadata?.raw;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof inner === 'string' && inner.trim() !== '') return inner.trim();
    return null;
  } catch {
    return raw.trim().slice(0, 300);
  }
}

export function createServer({
  fetchImpl = fetch,
  env = process.env,
  spawnImpl = nodeSpawn,
  hasFfmpeg = detectFfmpeg(),
  workDir = join(tmpdir(), 'ink-paper-remux'),
} = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const OPENROUTER_KEY = env.OPENROUTER_API_KEY;
  const FAL_KEY = env.FAL_KEY;
  const PROXY_AUTH_TOKEN = env.PROXY_AUTH_TOKEN;
  const allowedEndpoints = env.ALLOWED_ENDPOINTS ?? DEFAULT_ALLOWED_ENDPOINTS;

  // ---------------------------------------------------------------- health
  app.get('/api/health', (_req, res) => {
    res.json({
      openrouter: !!OPENROUTER_KEY,
      fal: !!FAL_KEY,
      realtime: true,
      multiAngle: true,
      proxyRoute: FAL_PROXY_ROUTE,
      authTokenRequired: !!PROXY_AUTH_TOKEN,
      ffmpeg: !!hasFfmpeg,
    });
  });

  // ------------------------------------------------- vision interpretation
  // OpenRouter (OpenAI-compatible multimodal). A struggling upstream provider
  // reports itself two different ways — a non-2xx status, or an error object
  // inside an HTTP 200 — so both are retried on the same terms.
  app.post('/api/interpret', async (req, res) => {
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY missing in server .env' });
    const { image, model, visionPrompt } = req.body ?? {};
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'image must be a data URI' });
    }
    try {
      const orBody = JSON.stringify({
        model: model || 'deepseek/deepseek-v4.1-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
      });
      const MAX_ATTEMPTS = 3;
      const RETRY_DELAY_MS = Number(env.VISION_RETRY_DELAY_MS ?? 250);
      /** `true` when the failure is an upstream hiccup worth another roll. */
      const isTransient = (status, message, code) => {
        if (status === 408 || status === 429 || status >= 500) return true;
        if (code === 408 || code === 429 || code === 502 || code === 503 || code === 504) return true;
        return /abort|timeout|timed out|overloaded|rate limit|provider returned error|temporarily unavailable/i
          .test(String(message ?? ''));
      };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
          },
          body: orBody,
        });
        const data = await r.json();
        const bodyError = data?.error;
        if (!r.ok || bodyError) {
          const base = String(bodyError?.message ?? `openrouter error (${r.status})`);
          const detail = upstreamErrorDetail(bodyError);
          const code = bodyError?.code ?? null;
          // Judge transience on the most specific text available: OpenRouter
          // wraps genuine provider complaints behind a generic message.
          if (attempt < MAX_ATTEMPTS && isTransient(r.status, detail ?? base, code)) {
            // brief backoff: an immediately-retried provider usually fails again
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
            continue;
          }
          const message = detail && !base.includes(detail) ? `${base}: ${detail}` : base;
          // in-body errors keep their original 502 + prefixed shape; a real HTTP
          // status is passed through so 401/400 are not disguised as a gateway fault
          if (r.ok) return res.status(502).json({ error: `openrouter error: ${message}`, code, attempts: attempt });
          return res.status(r.status).json({ error: message, code, attempts: attempt });
        }
        const msg = data.choices?.[0]?.message ?? {};
        const text = msg.content ?? msg.reasoning ?? '';
        if (typeof text === 'string' && text.trim() === '') {
          return res.status(502).json({
            error: 'empty completion from openrouter',
            finish_reason: data.choices?.[0]?.finish_reason ?? null,
            raw_keys: Object.keys(data),
            usage: data.usage ?? null,
          });
        }
        return res.json({ text });
      }
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // ------------------------------------------------------------ fal proxy
  // Holds FAL_KEY server-side. Carries the WMA signalling bridge the Director
  // session negotiates through, fal storage uploads (blot + music hosting),
  // and queue calls for Multi Angle.
  app.all(FAL_PROXY_ROUTE, async (req, res) => {
    if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY missing in server .env' });
    if (PROXY_AUTH_TOKEN && req.headers['x-ink-token'] !== PROXY_AUTH_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const target = singleHeader(req.headers[TARGET_URL_HEADER]);
    if (typeof target !== 'string' || target === '') {
      return res.status(400).json({ error: 'missing ' + TARGET_URL_HEADER });
    }
    const method = (req.method || 'POST').toUpperCase();
    if (!isAllowedProxyTarget(target, allowedEndpoints, req.body, method)) {
      return res.status(400).json({ error: 'target not allowed' });
    }
    try {
      const upstreamHeaders = { authorization: `Key ${FAL_KEY}`, accept: 'application/json' };
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase().startsWith('x-fal-') && key.toLowerCase() !== TARGET_URL_HEADER) {
          upstreamHeaders[key.toLowerCase()] = value;
        }
      }
      const init = { method, headers: upstreamHeaders };
      if (method !== 'GET' && method !== 'HEAD') {
        upstreamHeaders['content-type'] = 'application/json';
        init.body = JSON.stringify(req.body ?? {});
      }
      const upstream = await fetchImpl(target, init);
      const body = upstream.body ?? (await upstream.text?.());
      const contentType = upstream.headers?.get?.('content-type');
      if (contentType) res.setHeader('content-type', contentType);
      res.status(upstream.status);
      if (body == null) return res.end();
      if (typeof body === 'string') return res.send(body);
      if (typeof body.getReader === 'function') return Readable.fromWeb(body).pipe(res);
      return res.send(String(body));
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // --------------------------------------------------------- video relay
  // Same-origin relay for fal media so <video> + canvas frame extraction
  // never taints the canvas, and therefore never blocks toBlob().
  app.get('/api/proxy-video', async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!isAllowedMediaUrl(url)) return res.status(400).json({ error: 'url not allowed' });
    try {
      const range = req.headers.range;
      const upstream = await fetchImpl(url, { headers: range ? { range } : {} });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: 'upstream media error' });
      }
      res.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers?.get?.(header);
        if (value) res.setHeader(header, value);
      }
      if (!res.getHeader('accept-ranges')) res.setHeader('accept-ranges', 'bytes');
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // ------------------------------------------------------------- remux
  // Browsers record webm; social platforms want mp4. Local-only by design,
  // which is exactly why shelling out to ffmpeg here is acceptable.
  app.post('/api/remux', (req, res) => {
    if (!hasFfmpeg) {
      return res.status(503).json({ error: 'ffmpeg is not available on this machine, so the recording cannot be converted' });
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > REMUX_LIMIT_BYTES) {
      return res.status(413).json({ error: 'recording is too large to convert' });
    }
    try {
      mkdirSync(workDir, { recursive: true });
    } catch (error) {
      return res.status(500).json({ error: `could not prepare a working directory: ${error}` });
    }
    const input = join(workDir, `${randomUUID()}.webm`);
    const output = join(workDir, `${randomUUID()}.mp4`);
    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > REMUX_LIMIT_BYTES) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => { aborted = true; });
    req.on('end', () => {
      if (aborted) {
        if (!res.headersSent) res.status(413).json({ error: 'recording is too large to convert' });
        return;
      }
      if (received === 0) {
        if (!res.headersSent) res.status(400).json({ error: 'no recording received' });
        return;
      }
      try {
        writeFileSync(input, Buffer.concat(chunks));
      } catch (error) {
        return res.status(500).json({ error: `could not stage the recording: ${error}` });
      }
      const args = buildRemuxArgs(input, output);
      let stderr = '';
      const child = spawnImpl(env.FFMPEG_PATH || 'ffmpeg', args);
      child.stderr?.on?.('data', (data) => { stderr += String(data); });
      child.on('error', (error) => {
        cleanup([input, output]);
        if (!res.headersSent) res.status(500).json({ error: `could not run ffmpeg: ${error.message}` });
      });
      child.on('close', (code) => {
        if (code !== 0 || !existsSync(output)) {
          cleanup([input, output]);
          if (!res.headersSent) {
            res.status(500).json({ error: `ffmpeg failed (${code}): ${stderr.trim().slice(0, 500) || 'no output'}` });
          }
          return;
        }
        res.setHeader('content-type', 'video/mp4');
        res.setHeader('content-disposition', 'attachment; filename="ink-film.mp4"');
        const stream = createReadStream(output);
        stream.on('error', () => {
          cleanup([input, output]);
          if (!res.headersSent) res.status(500).json({ error: 'could not read the converted file' });
        });
        stream.on('close', () => cleanup([input, output]));
        stream.pipe(res);
      });
    });
  });

  return app;
}

function cleanup(paths) {
  for (const path of paths) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* nothing else to do about a leftover temp file */
    }
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  createServer().listen(port, host, () => console.log(`proxy on http://${host}:${port}`));
}
