import { describe, it, expect, beforeEach } from 'vitest';
import { BlotRail, DEFAULT_RAIL_OPTIONS, type RailPorts } from './queue';
import { fallbackReading, type BlotReading } from './reading';
import { inkRecipeFromSeed } from '../ink/recipe';
import { defaultCameraConfig, CAMERA_MOVES, type CameraMoveId } from '../presets/camera';
import { MOODS } from '../presets/moods';
import { MUSIC_PRESETS } from '../presets/music';

interface Harness {
  ports: RailPorts;
  calls: {
    render: number;
    upload: string[];
    interpret: string[];
    angles: Array<{ blotId: string; move: CameraMoveId }>;
    extracted: string[];
  };
  failUpload: Set<string>;
  failAngle: Set<CameraMoveId>;
  failInterpret: boolean;
  recipeFor: (seed: number) => ReturnType<typeof inkRecipeFromSeed>;
  cameraAngles: number;
  cameraEnabled: boolean;
}

function harness(overrides: Partial<RailPorts> = {}): Harness {
  let idCounter = 0;
  let seedCounter = 100;
  const calls: Harness['calls'] = { render: 0, upload: [], interpret: [], angles: [], extracted: [] };
  const failUpload = new Set<string>();
  const failAngle = new Set<CameraMoveId>();
  const state = { failInterpret: false, cameraAngles: 2, cameraEnabled: true };

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
    generateAngle: async ({ blot, move }) => {
      if (failAngle.has(move)) throw new Error('angle exploded');
      calls.angles.push({ blotId: blot.id, move });
      return { videoUrl: `https://fal.media/${blot.recipe.seed}-${move}.mp4` };
    },
    extractArrivalFrame: async (videoUrl) => {
      calls.extracted.push(videoUrl);
      return new Blob([videoUrl], { type: 'image/png' });
    },
    readEpisode: () => ({
      mood: MOODS.dreamlike,
      music: MUSIC_PRESETS.ambient,
      camera: { ...defaultCameraConfig(), enabled: state.cameraEnabled, anglesPerBlot: state.cameraAngles },
      moodStrength: 0.6,
      palette: MOODS.dreamlike.palette,
    }),
    now: () => 1_700_000_000_000,
    nextId: (prefix) => `${prefix}-${++idCounter}`,
    nextSeed: () => ++seedCounter,
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
    recipeFor: (seed: number) => inkRecipeFromSeed({ seed, folds: 'auto' }),
    get cameraAngles() { return state.cameraAngles; },
    set cameraAngles(value: number) { state.cameraAngles = value; },
    get cameraEnabled() { return state.cameraEnabled; },
    set cameraEnabled(value: boolean) { state.cameraEnabled = value; },
  };
}

/** Pumps until nothing changes, so tests never depend on a tick count. */
async function settle(rail: BlotRail, maxRounds = 12): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const before = rail.all.map((job) => `${job.state}:${job.attempts}:${job.angles.length}`).join('|');
    await rail.pump();
    const after = rail.all.map((job) => `${job.state}:${job.attempts}:${job.angles.length}`).join('|');
    if (before === after) return;
  }
}

describe('BlotRail', () => {
  let h: Harness;
  let rail: BlotRail;

  beforeEach(() => {
    h = harness();
    rail = new BlotRail(h.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 2 });
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
    expect(job.angles).toHaveLength(2);
    expect(job.angles.every((take) => take.state === 'ready')).toBe(true);
    expect(job.angles.every((take) => take.arrivalFrameUrl?.startsWith('https://fal.media/'))).toBe(true);
  });

  it('renders each blot exactly once', async () => {
    await settle(rail);
    expect(h.calls.render).toBe(rail.all.length);
  });

  it('shares one in-flight reading between blots of the same recipe', async () => {
    const repeated = harness({ invent: () => inkRecipeFromSeed({ seed: 5, folds: 'auto' }) });
    const repeatedRail = new BlotRail(repeated.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 2 });
    await settle(repeatedRail);
    expect(repeatedRail.all).toHaveLength(2);
    expect(repeated.calls.interpret).toHaveLength(1);
    expect(repeatedRail.all[0]!.reading).toEqual(repeatedRail.all[1]!.reading);
  });

  it('builds the configured number of camera angles per blot', async () => {
    h.cameraAngles = 3;
    await settle(rail);
    for (const job of rail.ready) expect(job.angles).toHaveLength(3);
  });

  it('cycles through the selected moves', async () => {
    h.cameraAngles = 3;
    await settle(rail);
    const moves = rail.ready[0]!.angles.map((take) => take.move);
    expect(new Set(moves).size).toBe(3);
    expect(moves.every((move) => move in CAMERA_MOVES)).toBe(true);
  });

  it('skips angle takes entirely when the camera is disabled', async () => {
    h.cameraEnabled = false;
    await settle(rail);
    expect(rail.ready).toHaveLength(2);
    expect(rail.ready[0]!.angles).toHaveLength(0);
    expect(h.calls.angles).toHaveLength(0);
  });

  it('honours anglesPerBlot of zero', async () => {
    h.cameraAngles = 0;
    await settle(rail);
    expect(rail.ready[0]!.angles).toHaveLength(0);
    expect(rail.ready[0]!.state).toBe('ready');
  });

  it('still delivers the blot when every angle take fails', async () => {
    h.cameraAngles = 2;
    h.failAngle.add('orbit-right');
    h.failAngle.add('push-in');
    await settle(rail);
    expect(rail.ready.length).toBeGreaterThan(0);
    expect(rail.ready[0]!.angles).toHaveLength(0);
    expect(rail.ready[0]!.url).toBeDefined();
  });

  it('reports what the pre-flight is waiting on at every stage', async () => {
    // a fresh rail is about to invent and paint
    expect(rail.progress).toMatchObject({ target: 2, ready: 0, working: 0, failed: 0, stage: 'painting' });

    // pump() advances every job one stage, so the label names the stage in flight
    await rail.pump();
    expect(rail.progress).toMatchObject({ working: 2, stage: 'hosting' });
    await rail.pump();
    expect(rail.progress).toMatchObject({ working: 2, stage: 'imagining' });
    await rail.pump();
    expect(rail.progress).toMatchObject({ working: 2, stage: 'shooting', anglesReady: 0, anglesWanted: 4 });

    await settle(rail);
    expect(rail.progress).toMatchObject({ ready: 2, working: 0, stage: 'ready', anglesReady: 4, anglesWanted: 4 });
  });

  it('counts no camera views when the camera is switched off', async () => {
    h.cameraEnabled = false;
    await settle(rail);
    expect(rail.progress).toMatchObject({ anglesReady: 0, anglesWanted: 0, ready: 2, stage: 'ready' });
  });

  it('calls a rail that dropped everything stalled', async () => {
    const failing = harness({ upload: async () => { throw new Error('storage down'); } });
    const failingRail = new BlotRail(failing.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 1 });
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
    const failingRail = new BlotRail(failing.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 1 });
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
    const flakyRail = new BlotRail(flaky.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 1 });
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
    const flakyRail = new BlotRail(flaky.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 1 });
    await settle(flakyRail);
    expect(attempts).toBeGreaterThan(1);
    expect(flakyRail.ready).toHaveLength(1);
  });

  it('gives the vision model the running history of the film', async () => {
    const seen: number[] = [];
    const historyRail = new BlotRail(
      {
        ...h.ports,
        interpret: async ({ previousPrompts, beatIndex }) => {
          seen.push(previousPrompts.length);
          return { ...fallbackReading(beatIndex), prompt: `beat ${beatIndex}` };
        },
      },
      { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 2 },
    );
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
    const repeatedRail = new BlotRail(repeated.ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 2 });
    await settle(repeatedRail);
    const before = repeated.calls.interpret.length;
    repeatedRail.forgetReadings();
    repeatedRail.reset();
    await settle(repeatedRail);
    expect(repeated.calls.interpret.length).toBeGreaterThan(before);
  });
});
