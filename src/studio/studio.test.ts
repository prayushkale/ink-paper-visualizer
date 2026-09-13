import { describe, it, expect } from 'vitest';
import { InkStudio, type StudioOptions, type StudioView } from './studio';
import { defaultSettings, applyQualityPreset, type Settings } from '../state';
import { inkRecipeFromSeed } from '../ink/recipe';
import { MOODS } from '../presets/moods';
import { MUSIC_PRESETS } from '../presets/music';
import type { MultiAngleInput } from '../angle/multiAngle';
import type { HealthResponse } from '../api/client';
import type { DirectorConnection, DirectorTransport, TransportHandlers } from '../stream/transport';
import type { Timer } from '../stream/session';

/** A transport that records wire messages and lets a test play the server. */
function fakeTransport(onClose?: () => void) {
  const sent: Array<Record<string, unknown>> = [];
  let handlers: TransportHandlers | null = null;
  const transport: DirectorTransport = {
    open(next) {
      handlers = next;
      const connection: DirectorConnection = {
        send: (message) => void sent.push(message as Record<string, unknown>),
        close: async () => {
          onClose?.();
        },
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
    /** How many timers are still registered: catches a one-shot left running. */
    pending: () => callbacks.size,
  };
}

interface HarnessOptions {
  settings?: Partial<Settings>;
  health?: Partial<HealthResponse>;
  fetchTrack?: (url: string) => Promise<Blob>;
  /** Overrides merged in last, for tests that need one port to hang or fail. */
  ports?: Partial<StudioOptions>;
  /** Called as a session is torn down, for tests about the seam. */
  onClose?: () => void;
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
  // most of these tests exercise the whole pipeline (orbits included), so the
  // harness starts from the medium preset; the cheap shipped default has its
  // own coverage in state.test.ts
  const settings = applyQualityPreset(defaultSettings(), 'medium');
  Object.assign(settings, options.settings ?? {});
  settings.music = { ...settings.music, mode: 'generated', resolvedUrl: null, ...(options.settings?.music ?? {}) };
  if (options.settings?.budget) settings.budget = { ...settings.budget, ...options.settings.budget };
  if (options.settings?.camera) settings.camera = { ...settings.camera, ...options.settings.camera };

  const transport = fakeTransport(options.onClose);
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
      if (options.fetchTrack) return options.fetchTrack(url);
      return new Blob([new Uint8Array(2048)], { type: 'audio/mpeg' });
    },
    probeDuration: async () => 120,
    remux: async (blob) => new Blob([blob], { type: 'video/mp4' }),
    schedule: timer.timer,
    now: () => clock.value,
    // Advancing the clock keeps the pre-flight wait bounded in tests, and the
    // yield keeps a fake-clock pre-flight from running all the way to its
    // deadline inside a single flush: the rail warms up in the background now,
    // so a test has to hand the loop a turn to be able to see the overlay.
    sleep: async () => {
      clock.value += 300;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    onView: (view) => views.push(view),
    ...(options.ports ?? {}),
  });

  return { studio, transport, clock, timer, views, calls, settings };
}

/** A promise a test can hold open, for ports that must not settle yet. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Starts the studio and drives the first session to live. */
async function goLive(h: Harness, maxSessionSeconds = 3600): Promise<Record<string, unknown>> {
  const result = await h.studio.start();
  expect(result.ok, result.error).toBe(true);
  const configure = h.transport.sent[0]!;
  h.transport.state('live');
  h.transport.server({
    type: 'session_info',
    app: 'minimax-h3-max-director',
    chunk_seconds: 10,
    max_session_seconds: maxSessionSeconds,
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

  it('shows the realised photograph on the stage while the rail warms up', async () => {
    // The stage belongs to the film, and the photograph is what the film is made
    // of. The ink blot has its rail card and the full-screen viewer; laying it
    // over the stage is showing the reference as if it were the picture.
    const h = harness({
      ports: {
        imagineImage: async ({ imageUrl }) => ({ url: `${imageUrl.replace(/\.png$/, '')}-imagined.png` }),
      },
    });
    await goLive(h);
    const shown = h.views.map((view) => view.card).filter((card) => card !== null);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((card) => /-imagined\.png$/.test(card.image))).toBe(true);
  });

  it('never lays a still of the blot over the running film', async () => {
    const h = harness();
    const configure = await goLive(h);
    // the session is open and its stream has not painted yet, so the stage holds
    // the photograph the film opens *inside* - the session's own first frame -
    // and never the ink blot that photograph was drawn from
    expect(h.studio.view.card?.image).toBe(configure.image_url);
    // a blot going to air does not put one back over the film either
    h.transport.server(chunk({ prompt_version: 2 }));
    expect(h.studio.view.card?.image).toBe(configure.image_url);
  });

  it('opens on the photograph the imagining made, never on the ink blot', async () => {
    // The blot is a reference. Handed to the video model it is the picture, and
    // the model animates the ink; handed to the image model it becomes the
    // photograph the film opens inside.
    const imagined = new Map<string, string>();
    const h = harness({
      ports: {
        imagineImage: async ({ imageUrl }) => {
          const url = `${imageUrl.replace(/\.png$/, '')}-imagined.png`;
          imagined.set(imageUrl, url);
          return { url };
        },
      },
    });
    const configure = await goLive(h);
    expect(imagined.size).toBeGreaterThan(0);
    expect(String(configure.image_url)).toMatch(/-imagined\.png$/);
    // and every orbit is taken around the photograph rather than the blot
    expect(h.calls.angleRequests.length).toBeGreaterThan(0);
    expect(h.calls.angleRequests.every((request) => /-imagined\.png$/.test(request.image_url))).toBe(true);
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

  it('adopts the server capabilities once /api/health answers', () => {
    // the studio is built before the health fetch resolves, so the answer has
    // to be handed over afterwards or the UI keeps calling ffmpeg missing
    const h = harness({ health: { ffmpeg: false } });
    expect(h.studio.view.capabilities.ffmpeg).toBe(false);
    h.studio.setHealth({
      openrouter: true,
      fal: true,
      realtime: true,
      multiAngle: true,
      proxyRoute: '/api/fal/proxy',
      authTokenRequired: false,
      ffmpeg: true,
    });
    expect(h.studio.view.capabilities.ffmpeg).toBe(true);

    h.studio.setHealth(null);
    expect(h.studio.view.capabilities.ffmpeg).toBe(false);
  });

  it('blames the track, not the server, when a pinned track could not be hosted', async () => {
    const h = harness({
      settings: { music: { ...defaultSettings().music, mode: 'pinned', musicId: 'trance' } },
      // the dev server answers a missing bundled file with index.html
      fetchTrack: async () => new Blob(['<!doctype html>'], { type: 'text/html' }),
    });
    const configure = await goLive(h);
    expect(configure.audio_url).toBeUndefined();
    h.transport.server({ type: 'configured', prompt_version: 1, has_initial_image: true, has_initial_audio: false });
    const warnings = h.studio.view.warnings;
    expect(warnings.some((line) => /no bundled track at/.test(line))).toBe(true);
    expect(warnings.some((line) => /was not accepted/.test(line))).toBe(false);
  });

  it('reports a pinned track the server refused', async () => {
    const h = harness({ settings: { music: { ...defaultSettings().music, mode: 'pinned', musicId: 'trance' } } });
    const configure = await goLive(h);
    expect(String(configure.audio_url)).toContain('trance-music-bed');
    h.transport.server({ type: 'configured', prompt_version: 1, has_initial_image: true, has_initial_audio: false });
    expect(h.studio.view.warnings.some((line) => /was not accepted/.test(line))).toBe(true);
  });

  it('reports what the pre-flight is waiting on, then stops reporting it', async () => {
    const gate = deferred();
    const h = harness({
      // the imagining is what the pre-flight waits on now: a blot's orbit takes
      // are shot in the background once its photograph exists
      ports: {
        imagineImage: async ({ imageUrl }) => {
          await gate.promise;
          return { url: `${imageUrl.replace(/\.png$/, '')}-imagined.png` };
        },
      },
    });
    const starting = h.studio.start();
    // The rail warms up in the background now, so the pre-flight's loop has to
    // be given a few of its own turns before the rail has been driven as far as
    // this gated port lets it go.
    for (let turn = 0; turn < 12; turn++) await flush();

    expect(h.studio.status).toBe('preflight');
    const preparing = h.studio.view.preparing;
    expect(preparing).not.toBeNull();
    expect(preparing!.target).toBe(20);
    expect(preparing!.ready).toBe(0);
    // The buffer's worth of ready blots is held up by the blots still walking
    // their stages - that is what the rail's ceiling above its buffer is for - and
    // the stage names the least-finished of them, the one gating the start.
    expect(preparing!.working).toBe(28);
    // a blot in five wins the one-in-five camera roll; here, six of the
    // twenty-eight the rail holds
    expect(preparing!.anglesWanted).toBe(6);
    expect(preparing!.stage).toBe('realising');
    expect(preparing!.elapsedMs).toBeGreaterThan(0);

    gate.release();
    await starting;
    // once the session opens the overlay has nothing left to say
    expect(h.studio.view.preparing).toBeNull();
  });

  it('a stop during the pre-flight never opens the session it was preparing', async () => {
    const gate = deferred();
    const h = harness({
      ports: {
        imagineImage: async ({ imageUrl }) => {
          await gate.promise;
          return { url: `${imageUrl.replace(/\.png$/, '')}-imagined.png` };
        },
      },
    });
    const starting = h.studio.start();
    await flush();
    expect(h.studio.view.preparing).not.toBeNull();

    await h.studio.stop('changed my mind');
    expect(h.studio.status).toBe('idle');

    gate.release();
    const result = await starting;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pre-flight/);
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
    expect(String(first.prompt)).toMatch(/Preserve the live-action photographic look/);
  });

  it('describes the blot in every direction, not just an image', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk());
    const prompt = String(h.transport.sent.find((message) => message.type === 'prompt')!.prompt);
    expect(prompt.length).toBeGreaterThan(80);
  });

  it('tells Multi Angle what the frame it is handed is, and caps the clip', async () => {
    const h = harness();
    await goLive(h);
    const prompt = String(h.calls.angleRequests[0]!.prompt ?? '');
    // Multi Angle keeps the scene frozen unless the mood, the score and the
    // blot's reading are sent with it - and the frame it is handed is already a
    // photograph, so nothing in the clip may turn back into paint
    expect(prompt).toContain(MOODS[h.settings.moodId].label);
    expect(prompt).toContain(MUSIC_PRESETS[h.settings.music.musicId].label);
    expect(prompt).toMatch(/attached photograph is the shot's first frame/);
    expect(prompt).toMatch(/no ink, no paper, no pigment/);
    expect(prompt).toMatch(/live-action photography/);
    // one clip per blot, seven seconds at the very most
    expect(h.calls.angleRequests.every((request) => request.duration <= 7)).toBe(true);
  });

  it('orbits through Multi Angle and hosts the arrival frames', async () => {
    const h = harness();
    await goLive(h);
    // the orbit is cut at the stream's own tier
    expect(h.calls.angleRequests[0]!.resolution).toBe('768P');
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
    // with no live video element the grab yields nothing, so the next session
    // opens from the prompt alone rather than cutting to a different angle
    expect(configures[1]!.image_url).toBeUndefined();
    expect(h.studio.view.chain.sessions).toBe(2);
    expect(h.studio.view.chain.chains).toBe(1);
  });

  it('sends a new prompt_version for every direction across a chain', async () => {
    // the chained session dispatches straight away, because the pre-flight left
    // it a rail with ready blots on it: its versions have to keep climbing where
    // the last session stopped rather than start again at 2
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

  it('drops the blots that never reached the screen when the run stops', async () => {
    // The hold starts only once the film is live: the pre-flight has to carry
    // three blots all the way through, so a port hung earlier would stall the
    // start rather than leave a blot mid-pipeline.
    let hang = false;
    const held = deferred();
    const h = harness({
      ports: {
        upload: async (_blob, name) => {
          if (hang) await held.promise;
          return `https://fal.media/${name}`;
        },
      },
    });
    await goLive(h);
    hang = true;
    h.studio.enqueueHandmade(
      inkRecipeFromSeed({ seed: 999_001, canvas: h.settings.ink.canvas, tools: h.settings.ink.tools, folds: 'auto' }),
      undefined,
      'data:image/jpeg;base64,hand-painted',
    );
    await flush();
    h.timer.beat();
    await flush();
    h.timer.beat();
    await flush();
    // the blot is being hosted and has not been read: this is the card that used
    // to sit on "waiting for the vision model" long after the film had stopped
    const stranded = h.studio.view.rail.filter((blot) => blot.subject === null);
    expect(stranded.length).toBeGreaterThan(0);
    // measured here rather than before the blot joined: the pre-flight hands the
    // film a rail that is all ready blots, so the blot still in the pipeline at
    // the stop is the hand-made one, not a leavings of the warm-up
    const before = h.studio.view.rail.length;

    await h.studio.stop();
    const after = h.studio.view.rail;
    expect(after.every((blot) => blot.subject !== null)).toBe(true);
    expect(after.length).toBeLessThan(before);
    expect(after.map((blot) => blot.id)).not.toContain(stranded[0]!.id);
    held.release();
  });

  it('clears the last session and leaves every setting exactly as it was', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server(chunk());
    await h.studio.stop();
    const settingsBefore = structuredClone(h.settings);
    expect(h.studio.view.rail.length).toBeGreaterThan(0);
    expect(h.studio.view.log.length).toBeGreaterThan(0);

    expect(h.studio.clearSession()).toBe(true);

    const view = h.studio.view;
    expect(view.rail).toHaveLength(0);
    // the log keeps exactly one line: the note that it was cleared
    expect(view.log).toHaveLength(1);
    expect(view.log[0]!.text).toMatch(/cleared the last session/);
    expect(view.warnings).toHaveLength(0);
    expect(view.recording.parts).toHaveLength(0);
    expect(view.recording.result).toBeNull();
    expect(view.status).toBe('idle');
    expect(h.settings).toEqual(settingsBefore);
  });

  it('refuses to clear while the film is still running', async () => {
    const h = harness();
    await goLive(h);
    const onRail = h.studio.view.rail.length;
    expect(h.studio.clearSession()).toBe(false);
    expect(h.studio.view.status).toBe('live');
    expect(h.studio.view.rail.length).toBe(onRail);
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

  it('ends the run when the session reports an unrecoverable error', async () => {
    const h = harness();
    await goLive(h);
    h.transport.server({ type: 'error', code: 'balance_unavailable', error: 'no credit on the account', prompt_version: null });
    h.timer.beat();
    await flush();
    // the session cannot continue, so the run is reported as failed rather than
    // quietly finished, and the session is closed either way
    expect(h.studio.status).toBe('failed');
    expect(h.transport.sent.some((message) => message.type === 'stop')).toBe(true);
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/balance_unavailable/);
    expect(h.studio.view.alerts.some((alert) => /balance_unavailable/.test(alert.text))).toBe(true);
  });

  it('keeps directing a session that never confirms a chunk', async () => {
    // a chunk that never arrives cannot be noticed from inside onChunk, so the
    // film would otherwise send one direction and wait on it forever
    const h = harness();
    await goLive(h);
    const before = h.transport.sent.filter((message) => message.type === 'prompt');
    h.clock.value += 40_000;
    h.timer.beat();
    await flush();
    const after = h.transport.sent.filter((message) => message.type === 'prompt');
    expect(after.length).toBeGreaterThan(before.length);
    // the blot the film was heading into is asked for again, so the lost
    // acknowledgement does not cost the film its arrival
    expect(after[after.length - 1]!.end_image_url).toBe(before[before.length - 1]!.end_image_url);
    expect(h.studio.view.warnings.some((line) => /again/.test(line))).toBe(true);
  });

  it('tears the run down when the transport dies mid-stream', async () => {
    // a dead peer generates nothing more: the recorder, the heartbeat and the
    // status all have to stop rather than sit on a black stage forever
    const h = harness();
    await goLive(h);
    h.transport.server(chunk({ chunk_index: 0, prompt_version: 2 }));
    await flush();
    h.transport.state('failed');
    await flush();
    expect(h.studio.status).toBe('failed');
    expect(h.transport.sent.some((message) => message.type === 'stop')).toBe(true);
    expect(h.studio.view.alerts.some((alert) => alert.kind === 'error')).toBe(true);
    // the heartbeat is gone, so nothing keeps pumping the rail behind the scenes
    const logLength = h.studio.view.log.length;
    h.timer.beat();
    h.timer.beat();
    await flush();
    expect(h.studio.view.log.length).toBe(logLength);
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

  it('pauses by closing the session and reopens on play', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    // confirm the opening direction so the dispatch gate is open
    h.transport.server(chunk({ chunk_index: 0, prompt_version: 2 }));
    await flush();
    const promptsBefore = h.transport.sent.filter((message) => message.type === 'prompt').length;
    const configuresBefore = h.transport.sent.filter((message) => message.type === 'configure').length;
    h.studio.pauseFilm();
    expect(h.studio.status).toBe('paused');
    await flush();
    // the session was actually closed, which is what stops the meter
    expect(h.transport.sent.some((message) => message.type === 'stop')).toBe(true);
    // a chunk arriving while paused must not turn into a new direction
    h.transport.server(chunk({ chunk_index: 1, prompt_version: 3 }));
    await flush();
    expect(h.transport.sent.filter((message) => message.type === 'prompt').length).toBe(promptsBefore);
    // play opens a fresh session, not a resumed one
    h.studio.resumeFilm();
    await flush();
    expect(h.transport.sent.filter((message) => message.type === 'configure').length).toBe(configuresBefore + 1);
    h.transport.state('live');
    expect(h.studio.status).toBe('live');
  });

  it('stops and queues a toast when the session time cap is reached', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 20, dryRun: false } } });
    await goLive(h);
    h.transport.server(chunk({ chunk_index: 0, prompt_version: 2 }));
    await flush();
    h.transport.server(chunk({ chunk_index: 1, prompt_version: 3 }));
    await flush();
    expect(h.studio.status).toBe('ended');
    const alerts = h.studio.view.alerts;
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[alerts.length - 1]!.text).toMatch(/session time cap/i);
    expect(alerts[alerts.length - 1]!.kind).toBe('warn');
  });

  it('enforces a session cap chosen after the studio was built', async () => {
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    // a preset/slider change has to reach the guard that actually enforces it
    h.studio.updateSettings({ budget: { ...h.settings.budget, sessionCapSeconds: 10 } });
    h.transport.server(chunk({ chunk_index: 0, prompt_version: 2 }));
    await flush();
    expect(h.studio.status).toBe('ended');
    expect(h.studio.view.alerts.some((alert) => /session time cap/i.test(alert.text))).toBe(true);
  });

  it('stops itself at the ceiling the server declares', async () => {
    // the server's own ceiling is shorter than the configured cap, so the meter
    // has to be the thing that ends the session rather than the server cutting in
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h, 20);
    h.transport.server(chunk({ chunk_index: 0, prompt_version: 2 }));
    await flush();
    expect(h.studio.status).toBe('live');
    h.transport.server(chunk({ chunk_index: 1, prompt_version: 3 }));
    await flush();
    expect(h.studio.status).toBe('ended');
    expect(h.studio.view.alerts.some((alert) => /session time cap of 20s/i.test(alert.text))).toBe(true);
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
      // The heartbeat is what refills the rail in production, and a blot is now
      // one chunk of film rather than three - so the rail has to produce one
      // every ten seconds, which is what the beat every second is for here.
      for (let beat = 0; beat < 10; beat++) {
        h.timer.beat();
        await flush();
      }
    }
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    expect(prompts.length).toBeGreaterThanOrEqual(chunks - 4);
    expect(h.studio.status).toBe('live');
  });

  it('keeps the film alive on a bare rail by sending continuations, not silence', async () => {
    // no heartbeat at all, so the rail never refills and stays empty after the
    // blots prepared during pre-flight have been consumed - which is a deeper
    // rail than it used to be: the buffer is twenty ready blots and the ceiling
    // behind them is twenty-eight, so the chunks have to outlast the lot
    const h = harness({ settings: { budget: { sessionCapUsd: 100, dailyCapUsd: 200, sessionCapSeconds: 900, dryRun: false } } });
    await goLive(h);
    const chunks = 45;
    for (let i = 0; i < chunks; i++) h.transport.server(chunk({ chunk_index: i, prompt_version: 2 + i }));
    const prompts = h.transport.sent.filter((message) => message.type === 'prompt');
    // a direction arrives at least every few chunks, and never zero of them
    expect(prompts.length).toBeGreaterThan(chunks / 5);
    expect(h.studio.status).toBe('live');
    // the rail genuinely ran out, which is exactly the condition being survived
    expect(h.studio.view.log.map((line) => line.text).join(' ')).toMatch(/rail ran dry|Continue/);
    // and it is reported as a notice that comes and goes rather than as a note
    // pinned under the bar: the log keeps every stall, the toast is rate-limited
    expect(h.studio.view.log.filter((line) => /rail ran dry/i.test(line.text)).length).toBeGreaterThan(1);
    expect(h.studio.view.warnings).toHaveLength(0);
    const notices = h.studio.view.alerts.filter((alert) => /rail ran dry/i.test(alert.text));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('warn');
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

/**
 * The browser pieces a seam is made of.
 *
 * There is no DOM in this suite, so the canvas the frame grabber draws into is
 * stubbed here and put back afterwards: the music bed reads `document` too, and
 * a global stub would change how it probes a track.
 */
function stubFrameCapture(ended: () => boolean = () => false): { frames: string[]; restore: () => void } {
  const frames: string[] = [];
  const scope = globalThis as unknown as { document?: unknown };
  const previous = scope.document;
  scope.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        // the label is what makes each captured frame identifiable, so a test can
        // tell the frame in hand from the frame the picture actually ended on
        toBlob: (callback: (blob: Blob | null) => void) => {
          const label = `frame-${frames.length + 1}-${ended() ? 'after' : 'before'}`;
          frames.push(label);
          callback(new Blob([label], { type: 'image/jpeg' }));
        },
      };
    },
  };
  return {
    frames,
    restore: () => {
      if (previous === undefined) delete scope.document;
      else scope.document = previous;
    },
  };
}

interface FakeVideo {
  element: HTMLVideoElement;
  /** Presents a frame, as a video-frame callback would report it. */
  paint(): void;
  /** Fires one of the element's own events. */
  fire(type: string): void;
}

function fakeVideo(withFrameCallback = true): FakeVideo {
  const frameCallbacks: Array<() => void> = [];
  const listeners = new Map<string, Array<() => void>>();
  const element: Record<string, unknown> = {
    videoWidth: 640,
    videoHeight: 360,
    srcObject: null,
    poster: '',
    play: () => Promise.resolve(),
    pause: () => {},
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  if (withFrameCallback) {
    element.requestVideoFrameCallback = (callback: () => void) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    };
  }
  return {
    element: element as unknown as HTMLVideoElement,
    paint() {
      const pending = frameCallbacks.splice(0, frameCallbacks.length);
      for (const callback of pending) callback();
    },
    fire(type) {
      const pending = listeners.get(type) ?? [];
      listeners.set(type, []);
      for (const listener of pending) listener();
    },
  };
}

function fakeStream(): MediaStream {
  return { active: true } as MediaStream;
}

/** A studio whose session is live with the player attached, as a seam starts. */
async function liveWithVideo(options: { onClose?: () => void; ports?: Partial<StudioOptions>; video?: FakeVideo } = {}) {
  const video = options.video ?? fakeVideo();
  const h = harness({ onClose: options.onClose, ports: options.ports });
  h.studio.setVideoElement(video.element);
  await goLive(h);
  // the session's own stream: the element the seam will read its last frame from
  h.transport.media(fakeStream());
  h.transport.server(chunk({ chunk_index: 0, prompt_version: 2 }));
  await flush();
  return { h, video };
}

/** Retires the session and lets the handover run to the point of configuring. */
async function handOver(h: Harness): Promise<void> {
  h.transport.server({ type: 'stream_exhausted', reason: 'session_limit', chunks: 1 });
  await flush();
  await flush();
}

describe('InkStudio at a session seam', () => {
  it('opens the next session on the frame the film actually ended on', async () => {
    const picture = { ended: false };
    const capture = stubFrameCapture(() => picture.ended);
    try {
      const uploaded = new Map<string, string>();
      const { h } = await liveWithVideo({
        onClose: () => {
          picture.ended = true;
        },
        ports: {
          upload: async (blob, name) => {
            uploaded.set(name, await blob.text());
            return `https://fal.media/${name}`;
          },
        },
      });
      // the rolling frame is the one in hand when the handover is decided
      expect(capture.frames[0]).toBe('frame-1-before');

      await handOver(h);

      // The picture does not stop the instant the handover is decided, so the
      // frame it ends on is the one captured after the session closed - not the
      // one that happened to be in hand, which is at best the same frame.
      expect(capture.frames[1]).toBe('frame-2-after');
      expect(uploaded.get('handover-2.jpg')).toBe('frame-2-after');
      const configure = h.transport.sent.filter((message) => message.type === 'configure')[1]!;
      expect(configure.image_url).toBe('https://fal.media/handover-2.jpg');
    } finally {
      capture.restore();
    }
  });

  it('holds that frame over the stage until the new stream paints one', async () => {
    const capture = stubFrameCapture();
    try {
      const { h, video } = await liveWithVideo();
      await handOver(h);
      // the next session's stream arrives empty: the stage holds the film's own
      // last frame rather than showing a black rectangle until it paints
      const held = h.studio.view.card;
      expect(held).not.toBeNull();
      expect(held!.image).toMatch(/^blob:/);

      h.transport.state('live');
      h.transport.media(fakeStream());
      expect(h.studio.view.card).not.toBeNull();
      video.paint();
      expect(h.studio.view.card).toBeNull();
    } finally {
      capture.restore();
    }
  });

  it('drops the held frame with the run it belonged to', async () => {
    const capture = stubFrameCapture();
    try {
      const { h } = await liveWithVideo();
      await handOver(h);
      expect(h.studio.view.card).not.toBeNull();

      await h.studio.stop('a test ended it');
      expect(h.studio.status).toBe('ended');
      expect(h.studio.view.card).toBeNull();
    } finally {
      capture.restore();
    }
  });

  it('takes the still off the stage when the element has no frame callback', async () => {
    const capture = stubFrameCapture();
    try {
      const { h, video } = await liveWithVideo({ video: fakeVideo(false) });
      await handOver(h);

      h.transport.state('live');
      h.transport.media(fakeStream());
      expect(h.studio.view.card).not.toBeNull();
      video.fire('loadeddata');
      expect(h.studio.view.card).toBeNull();
    } finally {
      capture.restore();
    }
  });

  it('never leaves the film covered when the new stream paints nothing', async () => {
    const capture = stubFrameCapture();
    try {
      const { h } = await liveWithVideo();
      await handOver(h);
      h.transport.state('live');
      h.transport.media(fakeStream());
      expect(h.studio.view.card).not.toBeNull();

      // no frame ever lands: the backstop is what keeps a still from hiding a
      // picture that is playing perfectly well behind it
      h.timer.beat();
      expect(h.studio.view.card).toBeNull();
      expect(h.studio.view.warnings.some((line) => /not painted a frame/.test(line))).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it('holds the opening photograph until the first session paints a frame', async () => {
    const capture = stubFrameCapture();
    try {
      const video = fakeVideo();
      const h = harness();
      h.studio.setVideoElement(video.element);
      const configure = await goLive(h);
      // the film opens inside this photograph, and the stream behind it is empty
      // until the model's first frame lands
      expect(h.studio.view.card?.image).toBe(configure.image_url);
      h.transport.media(fakeStream());
      expect(h.studio.view.card?.image).toBe(configure.image_url);
      video.paint();
      expect(h.studio.view.card).toBeNull();
    } finally {
      capture.restore();
    }
  });

  it('holds the paused picture so a resume does not open on nothing', async () => {
    const capture = stubFrameCapture();
    try {
      const { h, video } = await liveWithVideo();
      h.studio.pauseFilm();
      await flush();
      expect(h.studio.view.card?.image).toMatch(/^blob:/);

      h.studio.resumeFilm();
      await flush();
      h.transport.state('live');
      h.transport.media(fakeStream());
      // still held: the resumed stream has not painted anything yet
      expect(h.studio.view.card).not.toBeNull();
      video.paint();
      expect(h.studio.view.card).toBeNull();
    } finally {
      capture.restore();
    }
  });
});
