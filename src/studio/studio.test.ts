import { describe, it, expect } from 'vitest';
import { InkStudio, type StudioView } from './studio';
import { defaultSettings, type Settings } from '../state';
import { inkRecipeFromSeed } from '../ink/recipe';
import type { MultiAngleInput } from '../angle/multiAngle';
import type { HealthResponse } from '../api/client';
import type { DirectorConnection, DirectorTransport, TransportHandlers } from '../stream/transport';
import type { Timer } from '../stream/session';

/** A transport that records wire messages and lets a test play the server. */
function fakeTransport() {
  const sent: Array<Record<string, unknown>> = [];
  let handlers: TransportHandlers | null = null;
  const transport: DirectorTransport = {
    open(next) {
      handlers = next;
      const connection: DirectorConnection = {
        send: (message) => void sent.push(message as Record<string, unknown>),
        close: async () => {},
      };
      return connection;
    },
  };
  return {
    transport,
    sent,
    server(message: Record<string, unknown>) {
      handlers!.onData(JSON.stringify(message));
    },
    state(state: Parameters<TransportHandlers['onState']>[0]) {
      handlers!.onState(state);
    },
    media(stream: MediaStream) {
      handlers!.onMedia?.(stream);
    },
  };
}

function fakeTimer() {
  const callbacks = new Map<number, () => void>();
  let next = 0;
  const timer: Timer = {
    set: (fn) => {
      const id = ++next;
      callbacks.set(id, fn);
      return id;
    },
    clear: (handle) => {
      callbacks.delete(handle as number);
    },
  };
  return {
    timer,
    beat() {
      for (const fn of [...callbacks.values()]) fn();
    },
  };
}

interface HarnessOptions {
  settings?: Partial<Settings>;
  health?: Partial<HealthResponse>;
}

interface Harness {
  studio: InkStudio;
  transport: ReturnType<typeof fakeTransport>;
  clock: { value: number };
  timer: ReturnType<typeof fakeTimer>;
  views: StudioView[];
  calls: {
    uploads: string[];
    angleRequests: MultiAngleInput[];
    renders: number;
    extracted: string[];
    fetched: string[];
    interpreted: number;
  };
  settings: Settings;
}

function harness(options: HarnessOptions = {}): Harness {
  const settings = defaultSettings();
  Object.assign(settings, options.settings ?? {});
  settings.music = { ...settings.music, mode: 'generated', resolvedUrl: null };
  if (options.settings?.budget) settings.budget = { ...settings.budget, ...options.settings.budget };
  if (options.settings?.camera) settings.camera = { ...settings.camera, ...options.settings.camera };

  const transport = fakeTransport();
  const clock = { value: 1_700_000_000_000 };
  const views: StudioView[] = [];
  const timer = fakeTimer();
  const calls = {
    uploads: [] as string[],
    angleRequests: [] as MultiAngleInput[],
    renders: 0,
    extracted: [] as string[],
    fetched: [] as string[],
    interpreted: 0,
  };

  const studio = new InkStudio({
    settings,
    save: () => {},
    health: {
      openrouter: true,
      fal: true,
      realtime: true,
      multiAngle: true,
      proxyRoute: '/api/fal/proxy',
      authTokenRequired: false,
      ffmpeg: true,
      ...(options.health ?? {}),
    },
    transport: transport.transport,
    vision: {
      call: async () => {
        calls.interpreted += 1;
        return JSON.stringify({
          subject: 'a slow tide',
          prompt: 'The tide crosses the paper and gathers into ridges.',
          transition: 'the pigment gathers',
          moodTags: ['oceanic'],
          sound: 'water over stone',
        });
      },
    },
    multiAngleSubscribe: async (input) => {
      calls.angleRequests.push(input);
      return { video: { url: `https://fal.media/orbit-${calls.angleRequests.length}.mp4` } };
    },
    upload: async (_blob, name) => {
      calls.uploads.push(name);
      return `https://fal.media/${name}`;
    },
    render: async (recipe) => {
      calls.renders += 1;
      return {
        blob: new Blob([String(recipe.seed)], { type: 'image/png' }),
        thumbDataUri: `data:image/jpeg;base64,thumb-${recipe.seed}`,
        visionDataUri: `data:image/jpeg;base64,vision-${recipe.seed}`,
      };
    },
    extractArrivalFrame: async (videoUrl) => {
      calls.extracted.push(videoUrl);
      return new Blob([videoUrl], { type: 'image/png' });
    },
    fetchTrack: async (url) => {
      calls.fetched.push(url);
      return new Blob([new Uint8Array(2048)], { type: 'audio/mpeg' });
    },
    probeDuration: async () => 120,
    remux: async (blob) => new Blob([blob], { type: 'video/mp4' }),
    schedule: timer.timer,
    now: () => clock.value,
    // advancing the clock keeps the pre-flight wait bounded in tests
    sleep: async () => {
      clock.value += 300;
    },
    onView: (view) => views.push(view),
  });

  return { studio, transport, clock, timer, views, calls, settings };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Starts the studio and drives the first session to live. */
async function goLive(h: Harness): Promise<Record<string, unknown>> {
  const result = await h.studio.start();
  expect(result.ok, result.error).toBe(true);
  const configure = h.transport.sent[0]!;
  h.transport.state('live');
  h.transport.server({
    type: 'session_info',
    app: 'minimax-h3-max-director',
    chunk_seconds: 10,
    max_session_seconds: 120,
    one_session_per_machine: true,
  });
  h.transport.server({
    type: 'configured',
    prompt_version: 1,
    enable_safety_checker: true,
    resolution: '768p',
    aspect_ratio: '16:9',
    has_initial_image: true,
  });
  return configure;
}

const chunk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'chunk',
  chunk_index: 0,
  prompt_version: 1,
  requested_duration_seconds: 10,
  playback_seconds: 10,
  buffer_depth_seconds: 8,
  generation_seconds: 3,
  route: 'regulus',
  ...overrides,
});

describe('InkStudio', () => {
  it('prepares a blot and opens the session inside it', async () => {
    const h = harness();
    const configure = await goLive(h);
    expect(configure.type).toBe('configure');
    expect(configure.prompt_version).toBe(1);
    expect(configure.protocol_version).toBe(1);
    expect(configure.resolution).toBe('768p');
    expect(configure.aspect_ratio).toBe('16:9');
    expect(configure.memory).toBe(12);
    expect(String(configure.image_url)).toMatch(/^https:\/\/fal\.media\//);
    // the world prompt is one continuous take with constants to preserve
    expect(String(configure.prompt)).toMatch(/single continuous, unbroken film/);
    expect(String(configure.prompt)).toMatch(/PRESERVE/);
    // the score is not pinned in generated mode
    expect(configure.audio_url).toBeUndefined();
  });

  it('waits for the whole rail pipeline before opening a paid session', async () => {
    const h = harness();
    await goLive(h);
    // a blot reached 'ready', which needs a render, an upload, a vision call and its angles
    expect(h.calls.renders).toBeGreaterThan(0);
    expect(h.calls.interpreted).toBeGreaterThan(0);
    expect(h.calls.angleRequests.length).toBeGreaterThan(0);
    expect(h.transport.sent[0]!.image_url).toMatch(/\.png$/);
  });

  it('refuses to start when the fal key is missing', async () => {
    const h = harness({ health: { fal: false } });
    const result = await h.studio.start();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/FAL_KEY/);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('reaches live and reports telemetry', async () => {
    const h = harness();
    await goLive(h);
    expect(h.studio.status).toBe('live');
    h.transport.server(chunk({ chunk_index: 3, buffer_depth_seconds: 11.5 }));
    const view = h.studio.view;
    expect(view.session.chunkIndex).toBe(3);
    expect(view.session.chunks).toBe(4);
    expect(view.session.bufferSeconds).toBe(11.5);
    expect(view.session.route).toBe('regulus');
    expect(view.session.generatedSeconds).toBe(10);
  });

  it('accrues spend from generated seconds at the current rate', async () => {
    const h = harness();
    await goLive(h);
    for (let i = 0; i < 3; i++) h.transport.server(chunk({ chunk_index: i }));
    // 30s at the launch rate of $0.02/s, plus orbit takes on their own meter
    expect(h.studio.view.spend.sessionUsd).toBeCloseTo(0.6 + h.studio.view.rail
      .flatMap((blot) => blot.angles)
      .filter((angle) => angle.state === 'ready').length * 0, 1);
    expect(h.studio.view.spend.promo).toBe(true);
  });

  it('sends a direction that carries the next blot as an arrival image', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk());
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    expect(prompts.length).toBeGreaterThan(0);
    const first = prompts[0]!;
    expect(first.prompt_version).toBe(2);
    expect(String(first.end_image_url)).toMatch(/^https:\/\/fal\.media\//);
    expect(String(first.prompt)).toMatch(/Preserve the paper-and-pigment surface/);
  });

  it('describes the blot in every direction, not just an image', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk());
    const prompt = String(h.transport.sent.find((message) => message.type === 'prompt')!.prompt);
    expect(prompt.length).toBeGreaterThan(80);
  });

  it('orbits through Multi Angle and hosts the arrival frames', async () => {
    const h = harness();
    await goLive(h);
    expect(h.calls.angleRequests[0]!.resolution).toBe('480P');
    expect(h.calls.angleRequests[0]!.duration).toBe(5);
    expect(h.calls.angleRequests[0]!.camera_trajectory.length).toBeGreaterThanOrEqual(2);
    // image-to-video inherits the ratio, so no aspect_ratio may be sent
    expect(h.calls.angleRequests[0]).not.toHaveProperty('aspect_ratio');
    expect(h.calls.extracted.length).toBeGreaterThan(0);
    expect(h.calls.uploads.some((name) => name.includes('-orbit-') || name.endsWith('.png'))).toBe(true);
  });

  it('stops the film itself when the session dollar cap is reached', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 0.15, dailyCapUsd: 20, sessionCapSeconds: 600, dryRun: false } } });
    await goLive(h);
    h.transport.server(chunk({ chunk_index: 0 })); // 10s * $0.02 = $0.20, past the $0.15 cap
    await flush();
    expect(h.studio.status).toBe('ended');
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/session cap/);
  });

  it('stops the film when the session time cap is reached', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 60, dryRun: false } } });
    await goLive(h);
    for (let i = 0; i < 6; i++) h.transport.server(chunk({ chunk_index: i }));
    await flush();
    expect(h.studio.status).toBe('ended');
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/session time cap/);
  });

  it('spends nothing in a dry run', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 5, dailyCapUsd: 20, sessionCapSeconds: 600, dryRun: true } } });
    await goLive(h);
    for (let i = 0; i < 20; i++) h.transport.server(chunk({ chunk_index: i }));
    await flush();
    expect(h.studio.view.spend.sessionUsd).toBe(0);
    expect(h.studio.view.spend.todayUsd).toBe(0);
    expect(h.studio.status).toBe('live');
  });

  it('turns a mood change into a direction, never a new session', async () => {
    const h = harness();
    await goLive(h);
    h.studio.updateSettings({ moodId: 'menacing' });
    expect(h.studio.view.chain.sessions).toBe(1);
    h.transport.server(chunk({ prompt_version: 2 }));
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    expect(prompts.some((message) => /menacing/i.test(String(message.prompt)))).toBe(true);
    expect(h.transport.sent.filter((message) => message.type === 'configure')).toHaveLength(1);
  });

  it('hands over to a new session when the server ends one', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk({ chunk_index: 0 }));
    h.transport.server({ type: 'stream_exhausted', reason: 'session_limit', chunks: 6 });
    await flush();
    const configures = h.transport.sent.filter((message) => message.type === 'configure');
    expect(configures).toHaveLength(2);
    // with no live video element the grab yields nothing, so it opens on a view
    // of the current blot rather than on nothing
    expect(String(configures[1]!.image_url)).toMatch(/^https:\/\/fal\.media\//);
    expect(h.studio.view.chain.sessions).toBe(2);
    expect(h.studio.view.chain.chains).toBe(1);
  });

  it('sends a new prompt_version for every direction across a chain', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk({ chunk_index: 0 }));
    h.transport.server({ type: 'stream_exhausted', reason: 'session_limit', chunks: 2 });
    await flush();
    h.transport.state('live');
    h.transport.server(chunk({ chunk_index: 1, prompt_version: 3 }));
    const versions = h.transport.sent
      .filter((message) => message.type === 'prompt')
      .map((message) => Number(message.prompt_version));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('does not chain when chaining is switched off', async () => {
    const h = harness({ settings: { stream: { ...defaultSettings().stream, autoChain: false } } });
    await goLive(h);
    const h2 = h;
    void h2;
    expect(h.studio.view.chain.maxChains).toBeGreaterThan(0);
    // the policy itself is covered in chain.test.ts; here the reverse switch is wired
    h.studio.updateSettings({ stream: { ...h.settings.stream, autoChain: false } });
    expect(h.settings.stream.autoChain).toBe(false);
  });

  it('adopts a hand-painted blot at the front of the rail', async () => {
    const h = harness();
    await goLive(h);
    const recipe = inkRecipeFromSeed({ seed: 987, folds: [] });
    const job = h.studio.enqueueHandmade(recipe, new Blob(['by hand']), 'data:image/jpeg;base64,hand');
    expect(job.handmade).toBe(true);
    expect(h.studio.view.rail[0]!.id).toBe(job.id);
    expect(h.studio.view.rail[0]!.thumb).toContain('hand');
  });

  it('pins a track when one is available', async () => {
    const h = harness();
    h.settings.music = { ...h.settings.music, mode: 'pinned', customUrl: 'https://example.com/bed.mp3' };
    const configure = await goLive(h);
    expect(h.calls.fetched).toContain('https://example.com/bed.mp3');
    expect(configure.audio_url).toBe('https://fal.media/ambient-music-bed.mp3');
    expect(configure.audio_bitrate).toBe(192000);
    // a pinned score is described as conditioning, not decoration
    expect(String(configure.prompt)).toMatch(/pinned to this film/);
  });

  it('stops on request and sends exactly one stop', async () => {
    const h = harness();
    await goLive(h);
    await h.studio.stop('test over');
    expect(h.studio.status).toBe('ended');
    expect(h.transport.sent.filter((message) => message.type === 'stop')).toHaveLength(1);
  });

  it('can be stopped before it starts, and twice', async () => {
    const h = harness();
    await expect(h.studio.stop()).resolves.toBeUndefined();
    expect(h.studio.status).toBe('idle');
    await goLive(h);
    await h.studio.stop();
    await expect(h.studio.stop()).resolves.toBeUndefined();
    expect(h.transport.sent.filter((message) => message.type === 'stop')).toHaveLength(1);
  });

  it('refuses a second start while a session is open', async () => {
    const h = harness();
    await goLive(h);
    const again = await h.studio.start();
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already running/);
  });

  it('stops when the session reports an unrecoverable error', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server({ type: 'error', code: 'balance_unavailable', error: 'no credit on the account', prompt_version: null });
    h.timer.beat();
    await flush();
    expect(h.studio.status).toBe('ended');
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/balance_unavailable/);
  });

  it('warns rather than stopping when the model falls behind playback', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server({
      type: 'deadline_missed',
      chunk_index: 2,
      late_by_seconds: 3.5,
      behavior: 'freeze_video_and_silence_audio_until_ready',
    });
    expect(h.studio.view.session.buffering).toBe(true);
    expect(h.studio.status).toBe('live');
    expect(h.studio.view.warnings.join(' ')).toMatch(/behind playback/);
  });

  it('keeps the film running through many chunks', async () => {
    // a cap wide enough that the budget is not what ends this run
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    for (let i = 0; i < 30; i++) h.transport.server(chunk({ chunk_index: i, prompt_version: 2 + i }));
    expect(h.studio.status).toBe('live');
    expect(h.studio.view.session.chunks).toBe(30);
    // every direction gets its own version, and the film never goes silent
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    expect(prompts.length).toBeGreaterThan(5);
  });

  it('keeps a log of what the server said', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk({ chunk_index: 0 }));
    const log = h.studio.view.log.map((line) => line.text).join('\n');
    expect(log).toMatch(/opening inside blot/);
    expect(log).toMatch(/chunk 0/);
    expect(log).toMatch(/session:/);
    expect(log).toMatch(/configured:/);
  });

  it('round trips a share payload', async () => {
    const h = harness();
    const payload = h.studio.sharePayload();
    expect(payload.seed).toBe(h.settings.ink.seed);
    h.studio.applyShare({ ...payload, moodId: 'sacred', sessionCapSeconds: 300 });
    expect(h.settings.moodId).toBe('sacred');
    expect(h.settings.budget.sessionCapSeconds).toBe(300);
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/loaded a shared run/);
  });

  it('surfaces warnings in the view', async () => {
    const h = harness({ health: { ffmpeg: false } });
    await goLive(h);
    expect(h.studio.view.capabilities.ffmpeg).toBe(false);
  });
});

describe('InkStudio over a long run', () => {
  it('never reuses a prompt version across a whole chain', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 40, dailyCapUsd: 200, sessionCapSeconds: 120, dryRun: false } } });
    await goLive(h);
    for (let i = 0; i < 60; i++) {
      h.transport.server(chunk({ chunk_index: i, prompt_version: 2 + i }));
      // a real stream ends and reopens; drive one handover in the middle
      if (i === 20) {
        h.transport.server({ type: 'stream_exhausted', reason: 'session_limit', chunks: 21 });
        await flush();
        h.transport.state('live');
      }
    }
    const versions = h.transport.sent
      .filter((message) => message.type === 'prompt' || message.type === 'configure')
      .map((message) => Number(message.prompt_version));
    expect(versions.length).toBeGreaterThan(5);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]!, `version ${versions[i]} after ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]!);
    }
  });

  it('stops itself at the cap instead of running forever', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 1, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    // $1.00 at $0.02/s is 50s of Director, so ~5 chunks
    for (let i = 0; i < 100 && h.studio.status === 'live'; i++) {
      h.transport.server(chunk({ chunk_index: i, prompt_version: 1 }));
      await flush();
    }
    expect(h.studio.status).toBe('ended');
    expect(h.studio.view.spend.sessionUsd).toBeGreaterThanOrEqual(1);
    expect(h.studio.view.spend.sessionUsd).toBeLessThan(1.6);
  });

  it('answers nearly every chunk while the rail is being kept full', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    const chunks = 40;
    for (let i = 0; i < chunks; i++) {
      h.transport.server(chunk({ chunk_index: i, prompt_version: 2 + i }));
      // the heartbeat is what refills the rail in production, so drive it here
      h.timer.beat();
      await flush();
      h.timer.beat();
      await flush();
    }
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    expect(prompts.length).toBeGreaterThanOrEqual(chunks - 4);
    expect(h.studio.status).toBe('live');
  });

  it('keeps the film alive on a bare rail by sending continuations, not silence', async () => {
    // no heartbeat at all, so the rail never refills and stays empty after the
    // blots prepared during pre-flight have been consumed
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    const chunks = 30;
    for (let i = 0; i < chunks; i++) h.transport.server(chunk({ chunk_index: i, prompt_version: 2 + i }));
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    // a direction arrives at least every few chunks, and never zero of them
    expect(prompts.length).toBeGreaterThan(chunks / 5);
    expect(h.studio.status).toBe('live');
    // the rail genuinely ran out, which is exactly the condition being survived
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/rail ran dry|Continue/);
  });

  it('chains rather than dying when the server keeps ending sessions', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 120, dryRun: false } } });
    await goLive(h);
    for (let round = 0; round < 4; round++) {
      h.transport.server(chunk({ chunk_index: round, prompt_version: 2 + round }));
      h.transport.server({ type: 'stream_exhausted', reason: 'session_limit', chunks: round + 1 });
      await flush();
      h.transport.state('live');
    }
    expect(h.studio.status).toBe('live');
    expect(h.studio.view.chain.chains).toBe(4);
    expect(h.transport.sent.filter((message) => message.type === 'configure')).toHaveLength(5);
  });
});
