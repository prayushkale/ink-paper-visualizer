import { describe, it, expect, beforeEach } from 'vitest';
import { BlotRail, BLOT_HOLD_MS, DEFAULT_RAIL_OPTIONS, type RailPorts } from './queue';
import { fallbackReading, type BlotReading } from './reading';
import { inkRecipeFromSeed } from '../ink/recipe';
import { CAMERA_MOVE_IDS, defaultCameraConfig, type CameraMoveId } from '../presets/camera';
import { MOODS } from '../presets/moods';
import { MUSIC_PRESETS } from '../presets/music';

interface Harness {
  ports: RailPorts;
  calls: {
    render: number;
    upload: string[];
    interpret: string[];
    imagine: string[];
    angles: Array<{ blotId: string; move: CameraMoveId; imageUrl: string }>;
    extracted: string[];
  };
  failUpload: Set<string>;
  failAngle: Set<CameraMoveId>;
  failImagine: boolean;
  failInterpret: boolean;
  recipeFor: (seed: number) => ReturnType<typeof inkRecipeFromSeed>;
  /** The blot seed the next invention will use, so a test can aim at a roll. */
  seedBase: number;
  cameraEnabled: boolean;
}

function harness(overrides: Partial<RailPorts> = {}): Harness {
  let idCounter = 0;
  const calls: Harness['calls'] = { render: 0, upload: [], interpret: [], imagine: [], angles: [], extracted: [] };
  const failUpload = new Set<string>();
  const failAngle = new Set<CameraMoveId>();
  const state = { failInterpret: false, failImagine: false, seedBase: 100, cameraEnabled: true };

  const ports: RailPorts = {
    invent: (seed) => inkRecipeFromSeed({ seed, folds: 'auto' }),
    render: async (recipe) => {
      calls.render++;
      return {
        blob: new Blob([String(recipe.seed)], { type: 'image/png' }),
        thumbDataUri: `data:image/png;base64,thumb-${recipe.seed}`,
        visionDataUri: `data:image/png;base64,vision-${recipe.seed}`,
      };
    },
    upload: async (blob, name) => {
      if (failUpload.has(name)) throw new Error('upload exploded');
      calls.upload.push(name);
      const seed = await blob.text();
      return `https://fal.media/${seed}-${name}`;
    },
    interpret: async ({ blot, previousPrompts, beatIndex }) => {
      if (state.failInterpret) throw new Error('vision exploded');
      calls.interpret.push(blot.id);
      const reading: BlotReading = {
        ...fallbackReading(blot.recipe.seed),
        subject: `blot ${blot.recipe.seed}`,
        prompt: `beat ${beatIndex} from ${previousPrompts.length} prior`,
      };
      return reading;
    },
    imagine: async ({ blot }) => {
      if (state.failImagine) throw new Error('the image model exploded');
      calls.imagine.push(blot.id);
      return { url: `https://fal.media/${blot.recipe.seed}-imagined.png` };
    },
    generateAngle: async ({ blot, move, imageUrl }) => {
      if (failAngle.has(move)) throw new Error('angle exploded');
      calls.angles.push({ blotId: blot.id, move, imageUrl });
      return { videoUrl: `https://fal.media/${blot.recipe.seed}-${move}.mp4` };
    },
    extractArrivalFrame: async (videoUrl) => {
      calls.extracted.push(videoUrl);
      return new Blob([videoUrl], { type: 'image/png' });
    },
    readEpisode: () => ({
      mood: MOODS.dreamlike,
      music: MUSIC_PRESETS.ambient,
      camera: { ...defaultCameraConfig(), enabled: state.cameraEnabled },
      moodStrength: 0.6,
      palette: MOODS.dreamlike.palette,
    }),
    now: () => 1_700_000_000_000,
    nextId: (prefix) => `${prefix}-${++idCounter}`,
    nextSeed: () => ++state.seedBase,
    angleCostUsd: () => 0.0625,
    ...overrides,
  };

  return {
    ports,
    calls,
    failUpload,
    failAngle,
    get failInterpret() { return state.failInterpret; },
    set failInterpret(value: boolean) { state.failInterpret = value; },
    get failImagine() { return state.failImagine; },
    set failImagine(value: boolean) { state.failImagine = value; },
    recipeFor: (seed: number) => inkRecipeFromSeed({ seed, folds: 'auto' }),
    get seedBase() { return state.seedBase; },
    set seedBase(value: number) { state.seedBase = value; },
    get cameraEnabled() { return state.cameraEnabled; },
    set cameraEnabled(value: boolean) { state.cameraEnabled = value; },
  };
}

/** A promise a test can hold open, for a port that must not settle yet. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Waits for the microtask and task queues to drain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A rail with a buffer of `size` blots and a ceiling to match.
 *
 * The rail's own ceiling sits above its buffer, because a blot is only ready at
 * the end of five stages: the real buffer is held up by the blots still walking
 * them. A test rail has no supply line to keep fed, so the two numbers are the
 * same and the rail holds exactly what it was asked for.
 */
function smallRail(ports: RailPorts, size: number): BlotRail {
  return new BlotRail(ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: size, maxJobs: size });
}

/** Pumps until nothing changes, so tests never depend on a tick count. */
async function settle(rail: BlotRail, maxRounds = 12): Promise<void> {
  // the takes are shot in the background once a blot is ready, so a blot settling
  // is not the rail settling: the take states are part of the snapshot
  const snapshot = (): string => rail.all
    .map((job) => `${job.state}:${job.attempts}:${job.angles.map((take) => take.state).join('+')}`)
    .join('|');
  for (let round = 0; round < maxRounds; round++) {
    const before = snapshot();
    await rail.pump();
    if (before === snapshot()) return;
  }
}

describe('BlotRail', () => {
  let h: Harness;
  let rail: BlotRail;

  beforeEach(() => {
    h = harness();
    rail = smallRail(h.ports, 2);
  });

  it('fills to the prepared target and stops there', async () => {
    await settle(rail);
    expect(rail.ready).toHaveLength(2);
    expect(rail.all.length).toBe(2);
  });

  it('drives a blot all the way through every stage', async () => {
    await settle(rail);
    const job = rail.ready[0]!;
    expect(job.state).toBe('ready');
    expect(job.url).toMatch(/^https:\/\/fal\.media\//);
    expect(job.reading).toBeDefined();
    expect(job.thumbDataUri).toMatch(/^data:image\/png/);
    // these seeds did not roll a camera move, so the blot is handed over plain
    expect(job.cameraMove).toBeUndefined();
    expect(job.angles).toHaveLength(0);
  });

  it('renders each blot exactly once', async () => {
    await settle(rail);
    expect(h.calls.render).toBe(rail.all.length);
  });

  it('shares one in-flight reading between blots of the same recipe', async () => {
    const repeated = harness({ invent: () => inkRecipeFromSeed({ seed: 5, folds: 'auto' }) });
    const repeatedRail = smallRail(repeated.ports, 2);
    await settle(repeatedRail);
    expect(repeatedRail.all).toHaveLength(2);
    expect(repeated.calls.interpret).toHaveLength(1);
    expect(repeatedRail.all[0]!.reading).toEqual(repeatedRail.all[1]!.reading);
  });

  it('shoots one take, around the photograph, for the blot that rolled a move', async () => {
    // the next blot's seed is 114, which wins the one-in-five roll
    h.seedBase = 113;
    await settle(rail);
    const chosen = rail.ready.find((job) => job.cameraMove !== undefined);
    expect(chosen).toBeDefined();
    expect(chosen!.angles).toHaveLength(1);
    expect(chosen!.angles[0]!.move).toBe(chosen!.cameraMove);
    expect(chosen!.angles[0]!.state).toBe('ready');
    expect(chosen!.angles[0]!.arrivalFrameUrl).toMatch(/^https:\/\/fal\.media\//);
    const takes = h.calls.angles.filter((take) => take.blotId === chosen!.id);
    expect(takes).toHaveLength(1);
    expect(takes[0]!.imageUrl).toBe(chosen!.imaginedUrl);
    // and the other blot, which missed the roll, carries no camera work at all
    const plain = rail.ready.find((job) => job.cameraMove === undefined);
    expect(plain!.angles).toHaveLength(0);
  });

  it('skips angle takes entirely when the camera is disabled', async () => {
    h.seedBase = 113; // a blot that would otherwise have won the roll
    h.cameraEnabled = false;
    await settle(rail);
    expect(rail.ready).toHaveLength(2);
    expect(rail.ready[0]!.cameraMove).toBeUndefined();
    expect(rail.ready[0]!.angles).toHaveLength(0);
    expect(h.calls.angles).toHaveLength(0);
  });

  it('hands a blot over without waiting for its camera take', async () => {
    // The film only ever needs a blot's photograph, and a blot is one chunk of
    // film: a rail that waited for its orbit before handing one over could not
    // produce a blot every ten seconds, and the film would run dry.
    h.seedBase = 113;
    const gated = smallRail({ ...h.ports, generateAngle: () => new Promise<{ videoUrl: string }>(() => {}) }, 2);
    await settle(gated);
    expect(gated.ready.length).toBeGreaterThan(0);
    const blot = gated.ready.find((job) => job.cameraMove !== undefined)!;
    expect(blot.imaginedUrl).toBeDefined();
    // its take is still being shot, and the blot is the film's anyway
    expect(blot.angles.length).toBeGreaterThan(0);
    expect(blot.angles.every((take) => take.state === 'ready')).toBe(false);
  });

  it('still delivers the blot when its angle take fails', async () => {
    h.seedBase = 113;
    for (const move of CAMERA_MOVE_IDS) h.failAngle.add(move);
    await settle(rail);
    expect(rail.ready.length).toBeGreaterThan(0);
    const chosen = rail.ready.find((job) => job.cameraMove !== undefined)!;
    expect(chosen.angles).toHaveLength(0);
    expect(chosen.url).toBeDefined();
  });

  it('realises every blot as a photograph before handing it over', async () => {
    await settle(rail);
    for (const job of rail.ready) {
      expect(job.imaginedUrl).toMatch(/-imagined\.png$/);
      expect(h.calls.imagine).toContain(job.id);
    }
  });

  it('orbits the photograph, not the blot', async () => {
    h.seedBase = 113;
    await settle(rail);
    const chosen = rail.ready.find((job) => job.cameraMove !== undefined)!;
    const takes = h.calls.angles.filter((take) => take.blotId === chosen.id);
    expect(takes.length).toBeGreaterThan(0);
    expect(takes.every((take) => take.imageUrl === chosen.imaginedUrl)).toBe(true);
  });

  it('holds the blot itself on the card before the photograph lands', async () => {
    const clock = { value: 1_700_000_000_000 };
    const h2 = harness({ now: () => clock.value });
    const one = smallRail(h2.ports, 1);
    await one.pump();
    const job = one.all[0]!;
    expect(job.inkUntil).toBe(clock.value + BLOT_HOLD_MS);
  });

  it('drops a blot the image model cannot realise', async () => {
    const failing = harness({ imagine: async () => { throw new Error('the image model exploded'); } });
    const failingRail = smallRail(failing.ports, 1);
    await settle(failingRail);
    expect(failingRail.ready).toHaveLength(0);
    expect(failingRail.progress.failed).toBeGreaterThan(0);
  });

  it('skips the imagining entirely when no image model is wired up', async () => {
    const bare = harness({ imagine: undefined });
    const bareRail = smallRail(bare.ports, 1);
    await settle(bareRail);
    expect(bareRail.ready).toHaveLength(1);
    expect(bareRail.ready[0]!.imaginedUrl).toBeUndefined();
    expect(bareRail.ready[0]!.url).toMatch(/^https:\/\/fal\.media\//);
    expect(bare.calls.imagine).toHaveLength(0);
  });

  it('reports what the pre-flight is waiting on at every stage', async () => {
    // a fresh rail is about to invent and paint
    expect(rail.progress).toMatchObject({ target: 2, ready: 0, working: 0, failed: 0, stage: 'painting' });

    // The label names the stage the least-finished blot is in, and a blot now
    // walks its stages back to back - there is no shared step left for a stage
    // to be observed between - so each one is read while it is genuinely open,
    // by a port that answers only when the test says so.
    const watching = (ports: RailPorts, port: (gate: Promise<void>) => Partial<RailPorts>) => {
      const gate = deferred();
      const watched = smallRail({ ...ports, ...port(gate.promise) }, 1);
      return { watched, pumping: watched.pump(), release: gate.release };
    };

    const hosting = watching(h.ports, (gate) => ({
      upload: async (blob, name) => { await gate; return h.ports.upload(blob, name); },
    }));
    await flush();
    expect(hosting.watched.progress).toMatchObject({ working: 1, stage: 'hosting' });
    hosting.release();

    const imagining = watching(h.ports, (gate) => ({
      interpret: async (args) => { await gate; return h.ports.interpret(args); },
    }));
    await flush();
    expect(imagining.watched.progress).toMatchObject({ working: 1, stage: 'imagining' });
    imagining.release();

    const realising = watching(h.ports, (gate) => ({
      imagine: async (args) => { await gate; return h.ports.imagine!(args); },
    }));
    await flush();
    expect(realising.watched.progress).toMatchObject({ working: 1, stage: 'realising' });
    realising.release();

    // the shot is being taken: the blot is the film's either way - the picture
    // is what the film arrives at - so the camera work is the one thing the rail
    // can still be busy with behind a buffer that is otherwise ready
    const shot = harness();
    shot.seedBase = 113; // the next seed, 114, wins the one-in-five camera roll
    const shooting = watching(shot.ports, (gate) => ({
      generateAngle: async (args) => { await gate; return h.ports.generateAngle(args); },
    }));
    await flush();
    expect(shooting.watched.ready).toHaveLength(1);
    expect(shooting.watched.progress).toMatchObject({ stage: 'shooting', anglesWanted: 1, anglesReady: 0 });
    shooting.release();

    await Promise.all([hosting.pumping, imagining.pumping, realising.pumping, shooting.pumping]);
    expect(hosting.watched.progress).toMatchObject({ ready: 1, working: 0, stage: 'ready' });

    await settle(rail);
    expect(rail.progress).toMatchObject({ ready: 2, working: 0, stage: 'ready', anglesReady: 0, anglesWanted: 0 });
  });

  it('counts a camera take only for the blots that rolled a move', async () => {
    h.seedBase = 113;
    await settle(rail);
    expect(rail.progress).toMatchObject({ anglesWanted: 1, anglesReady: 1, stage: 'ready' });
  });

  it('counts no camera views when the camera is switched off', async () => {
    h.cameraEnabled = false;
    await settle(rail);
    expect(rail.progress).toMatchObject({ anglesReady: 0, anglesWanted: 0, ready: 2, stage: 'ready' });
  });

  it('calls a rail that dropped everything stalled', async () => {
    const failing = harness({ upload: async () => { throw new Error('storage down'); } });
    const failingRail = smallRail(failing.ports, 1);
    await settle(failingRail);
    expect(failingRail.progress.stage).toBe('stalled');
    expect(failingRail.progress.failed).toBeGreaterThan(0);
    expect(failingRail.progress.working).toBe(0);
  });

  it('drops a blot whose upload keeps failing and invents a replacement', async () => {
    let invented = 0;
    const failing = harness({
      invent: () => inkRecipeFromSeed({ seed: 900 + invented++, folds: [] }),
      upload: async () => { throw new Error('storage down'); },
    });
    const failingRail = smallRail(failing.ports, 1);
    await settle(failingRail);
    expect(failingRail.ready).toHaveLength(0);
    expect(failingRail.failedCount).toBeGreaterThan(0);
    // it never stops trying: the film must always have something coming
    expect(invented).toBeGreaterThan(1);
  });

  it('retries a reading that failed instead of caching the failure', async () => {
    let attempts = 0;
    const flaky = harness({
      interpret: async () => {
        attempts++;
        if (attempts === 1) throw new Error('vision exploded');
        return fallbackReading(1);
      },
    });
    const flakyRail = smallRail(flaky.ports, 1);
    await settle(flakyRail);
    expect(attempts).toBe(2);
    expect(flakyRail.ready).toHaveLength(1);
  });

  it('recovers when a stage fails once and then succeeds', async () => {
    let attempts = 0;
    const flaky = harness({
      interpret: async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return fallbackReading(1);
      },
    });
    const flakyRail = smallRail(flaky.ports, 1);
    await settle(flakyRail);
    expect(attempts).toBeGreaterThan(1);
    expect(flakyRail.ready).toHaveLength(1);
  });

  it('gives the vision model the running history of the film', async () => {
    const seen: number[] = [];
    const historyRail = smallRail({
      ...h.ports,
      interpret: async ({ previousPrompts, beatIndex }) => {
        seen.push(previousPrompts.length);
        return { ...fallbackReading(beatIndex), prompt: `beat ${beatIndex}` };
      },
    }, 2);
    await settle(historyRail);
    // only the first beat has no history; later ones see what came before
    expect(seen[0]).toBe(0);
    historyRail.ready.forEach((job, index) => rail.markLive(job.id));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('hands out ready blots in creation order', async () => {
    await settle(rail);
    const first = rail.next();
    expect(first).toBe(rail.ready[0]);
  });

  it('returns nothing to dispatch when the rail is empty', () => {
    expect(rail.next()).toBeUndefined();
  });

  it('tracks a blot through dispatch to air', async () => {
    await settle(rail);
    const job = rail.next()!;
    rail.markScheduled(job.id, 3);
    expect(rail.find(job.id)!.state).toBe('scheduled');
    expect(rail.find(job.id)!.dispatchedAtChunk).toBe(3);
    expect(rail.takeDispatched(4)).toHaveLength(1);
    rail.markLive(job.id);
    expect(rail.find(job.id)!.state).toBe('live');
    rail.markPassed(job.id);
    expect(rail.find(job.id)!.state).toBe('passed');
    expect(rail.takeDispatched(4)).toHaveLength(0);
  });

  it('refills the rail after a blot goes to air', async () => {
    await settle(rail);
    const job = rail.next()!;
    rail.markScheduled(job.id, 0);
    rail.markPassed(job.id);
    await settle(rail);
    expect(rail.ready.length).toBeGreaterThanOrEqual(2);
  });

  it('reports the film memory as dispatched prompts, oldest first', async () => {
    await settle(rail);
    expect(rail.history(5)).toEqual([]);
    const first = rail.next()!;
    rail.markScheduled(first.id, 0);
    rail.markPassed(first.id);
    await settle(rail);
    const second = rail.next()!;
    rail.markScheduled(second.id, 1);
    const memory = rail.history(5);
    expect(memory).toHaveLength(2);
    expect(memory[0]).toMatch(/beat/);
  });

  it('lets a hand-painted blot jump the queue', async () => {
    await settle(rail);
    const handmade = rail.adopt(h.recipeFor(777), 'data:image/png;base64,hand');
    // ordered first immediately, even before it is ready
    expect(rail.all[0]!.id).toBe(handmade.id);
    await settle(rail);
    expect(rail.find(handmade.id)!.state).toBe('ready');
    expect(rail.find(handmade.id)!.handmade).toBe(true);
    // and it is the next blot the film is given
    expect(rail.next()!.id).toBe(handmade.id);
  });

  it('accepts a pre-rendered hand-painted blot without re-rendering it', async () => {
    const rendersBefore = h.calls.render;
    const recipe = h.recipeFor(321);
    const job = rail.adopt(recipe, 'data:image/png;base64,hand', new Blob(['x']));
    await settle(rail);
    expect(rail.find(job.id)!.state).toBe('ready');
    expect(h.calls.render).toBe(rendersBefore + 1); // only the auto-filled blot
  });

  it('carries the vision image a hand-painted blot was handed over with', async () => {
    // Without it the vision stage has nothing to read and the blot is dropped,
    // which is what happened to every hand-painted blot before this was wired.
    const recipe = h.recipeFor(4242);
    const job = rail.adopt(recipe, 'data:image/png;base64,hand', new Blob(['x']), 'data:image/jpeg;base64,vision');
    expect(job.visionDataUri).toBe('data:image/jpeg;base64,vision');
    await settle(rail);
    expect(h.calls.interpret).toContain(job.id);
    expect(rail.find(job.id)!.reading).toBeDefined();
  });

  it('never exceeds maxJobs', async () => {
    const bounded = new BlotRail(h.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 20, maxJobs: 3 });
    await settle(bounded);
    expect(bounded.all.length).toBeLessThanOrEqual(3);
  });

  it('folds overlapping pumps into one', async () => {
    const [a, b] = [rail.pump(), rail.pump()];
    await Promise.all([a, b]);
    await settle(rail);
    expect(h.calls.render).toBe(rail.all.length);
  });

  it('survives a reset', async () => {
    await settle(rail);
    rail.reset();
    expect(rail.all).toHaveLength(0);
    expect(rail.ready).toHaveLength(0);
    await settle(rail);
    expect(rail.ready.length).toBeGreaterThan(0);
  });

  it('can forget cached readings so a new film asks fresh questions', async () => {
    const repeated = harness({ invent: () => inkRecipeFromSeed({ seed: 5, folds: 'auto' }) });
    const repeatedRail = smallRail(repeated.ports, 2);
    await settle(repeatedRail);
    const before = repeated.calls.interpret.length;
    repeatedRail.forgetReadings();
    repeatedRail.reset();
    await settle(repeatedRail);
    expect(repeated.calls.interpret.length).toBeGreaterThan(before);
  });
});

