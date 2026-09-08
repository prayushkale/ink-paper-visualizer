import 'dotenv/config';
import express from 'express';

export function createServer({ fetchImpl = fetch, env = process.env } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const OPENROUTER_KEY = env.OPENROUTER_API_KEY;
  const FAL_KEY = env.FAL_KEY;
  const queueBase = 'https://queue.fal.run';

  // Health: tells the UI whether keys are present (never returns the keys)
  app.get('/api/health', (_req, res) => {
    res.json({ openrouter: !!OPENROUTER_KEY, fal: !!FAL_KEY });
  });

  // Vision interpretation via OpenRouter (OpenAI-compatible multimodal)
  app.post('/api/interpret', async (req, res) => {
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY missing in server .env' });
    const { image, model, visionPrompt } = req.body ?? {};
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'image must be a data URI' });
    }
    try {
      const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model || 'google/gemini-2.5-flash',
          messages: [
            { role: 'user', content: [
              { type: 'text', text: visionPrompt },
              { type: 'image_url', image_url: { url: image } },
            ] },
          ],
        }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.error?.message ?? 'openrouter error' });
      return res.json({ text: data.choices?.[0]?.message?.content ?? '' });
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // Submit video job to fal queue
  app.post('/api/video/submit', async (req, res) => {
    if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY missing in server .env' });
    const { image, prompt, config } = req.body ?? {};
    if (typeof prompt !== 'string' || prompt.length < 5) return res.status(400).json({ error: 'prompt required' });
    let extra = {};
    if (config?.extraParamsJson && String(config.extraParamsJson).trim() !== '') {
      try { extra = JSON.parse(config.extraParamsJson); } catch {
        return res.status(400).json({ error: 'extraParamsJson is not valid JSON' });
      }
    }
    const payload = {
      prompt,
      image_url: image,
      duration: config?.duration ?? 5,
      resolution: config?.resolution ?? '768P',
      prompt_expansion_mode: config?.promptExpansionMode ?? 'fast',
      ...(config?.seed != null ? { seed: config.seed } : {}),
      ...extra, // extra params can override defaults intentionally
    };
    try {
      const r = await fetchImpl(`${queueBase}/${config?.falModel ?? 'minimax/h3-max-turbo/image-to-video'}`, {
        method: 'POST',
        headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.detail ?? JSON.stringify(data) });
      return res.json({ request_id: data.request_id, status_url: data.status_url, response_url: data.response_url });
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  // Poll fal queue status; when COMPLETED, fetch the result for the video URL
  app.get('/api/video/status', async (req, res) => {
    if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY missing in server .env' });
    const { status_url, response_url } = req.query;
    if (typeof status_url !== 'string') return res.status(400).json({ error: 'status_url required' });
    try {
      const r = await fetchImpl(status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'fal status error' });
      if (data.status === 'COMPLETED' && typeof response_url === 'string') {
        const r2 = await fetchImpl(response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
        const result = await r2.json();
        return res.json({ status: 'COMPLETED', videoUrl: result.video?.url ?? null });
      }
      return res.json({ status: data.status, queue: data.queue_position, error: data.error });
    } catch (e) {
      return res.status(502).json({ error: String(e) });
    }
  });

  return app;
}

if (process.argv[1]?.endsWith('index.mjs')) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, () => console.log(`proxy on :${port}`));
}
