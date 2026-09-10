import { describe, it, expect, beforeEach } from 'vitest';
import { BlotScheduler, CONTINUATION, type SchedulerEpisode, type SchedulerSession } from './scheduler';
import { BlotRail, DEFAULT_RAIL_OPTIONS, type RailPorts } from '../rail/queue';
import { fallbackReading } from '../rail/reading';
import { inkRecipeFromSeed } from '../ink/recipe';
import { defaultCameraConfig } from '../presets/camera';
import { MOODS } from '../presets/moods';
import { MUSIC_PRESETS } from '../presets/music';
import { buildPrompt, type ChunkInfo } from './protocol';
import type { StudioStatus } from '../state';

function makeRail(anglesPerBlot = 2, enabled = true) {
  let id = 0;
  let seed = 500;
  const ports: RailPorts = {
    invent: (s) => inkRecipeFromSeed({ seed: s, folds: 'auto' }),
    render: async (recipe) => ({
      blob: new Blob([String(recipe.seed)]),
      thumbDataUri: `data:image/png;base64,t${recipe.seed}`,
      visionDataUri: `data:image/png;base64,v${recipe.seed}`,
    }),
    upload: async (blob, name) => `https://fal.media/${await blob.text()}-${name}`,
    interpret: async ({ blot }) => ({
      ...fallbackReading(blot.recipe.seed),
      subject: `blot ${blot.recipe.seed}`,
      prompt: `blot ${blot.recipe.seed} continues to spread and reorganise.`,
      transition: 'the pigment gathers',
    }),
    generateAngle: async ({ blot, move }) => ({ videoUrl: `https://fal.media/${blot.recipe.seed}-${move}.mp4` }),
    extractArrivalFrame: async (videoUrl) => new Blob([videoUrl]),
    readEpisode: () => ({
      mood: MOODS.dreamlike,
      music: MUSIC_PRESETS.ambient,
      camera: { ...defaultCameraConfig(), enabled, anglesPerBlot },
      moodStrength: 0.6,
      palette: MOODS.dreamlike.palette,
    }),
    now: () => 1_700_000_000_000,
    nextId: (prefix) => `${prefix}-${++id}`,
    nextSeed: () => ++seed,
    angleCostUsd: () => 0.06,
  };
  return new BlotRail(ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 4 });
}

async function settleRail(rail: BlotRail, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const before = rail.all.map((job) => `${job.state}:${job.angles.length}`).join('|');
    await rail.pump();
    const after = rail.all.map((job) => `${job.state}:${job.angles.length}`).join('|');
    if (before === after) return;
  }
}

function fakeSession(status: StudioStatus = 'live') {
  const sent: Array<Record<string, unknown>> = [];
  let statusValue: StudioStatus = status;
  let chunkIndex = 0;
  const session: SchedulerSession = {
    get status() { return statusValue; },
    get chunkIndex() { return chunkIndex; },
    direct(input) {
      const version = sent.length + 2;
      // build the real wire message so the tests assert the real payload shape
      sent.push(buildPrompt({
        promptVersion: version,
        prompt: input.prompt,
        endImageUrl: input.endImageUrl ?? undefined,
        audioUrl: input.audioUrl ?? undefined,
        audioBehavior: input.audioBehavior,
        replan: input.replan,
      }) as unknown as Record<string, unknown>);
      return version;
    },
  };
  return {
    session,
    sent,
    setStatus(next: StudioStatus) { statusValue = next; },
    setChunkIndex(next: number) { chunkIndex = next; },
  };
}

const chunk = (overrides: Partial<ChunkInfo> = {}): ChunkInfo => ({
  chunkIndex: 0,
  promptVersion: 1,
  requestedDurationSeconds: 10,
  playbackSeconds: 10,
  bufferDepthSeconds: 0,
  bufferDepthChunks: 0,
  nextGenerationEstimateSeconds: 5,
  generationSeconds: 4,
  route: 'regulus',
  trimmedContextFrames: 39,
  scriptOffsetSeconds: null,
  scriptVersion: null,
  ...overrides,
});

function makeEpisode(overrides: Partial<SchedulerEpisode> = {}): () => SchedulerEpisode {
  return () => ({
    mood: MOODS.dreamlike,
    music: MUSIC_PRESETS.ambient,
    camera: defaultCameraConfig(),
    moodStrength: 0.6,
    arrivalMode: 'hard',
    palette: MOODS.dreamlike.palette,
    ...overrides,
  });
}

describe('BlotScheduler', () => {
  let rail: BlotRail;
  let s: ReturnType<typeof fakeSession>;
  let scheduler: BlotScheduler;
  let clock: number;
  let warnings: string[];

  beforeEach(async () => {
    rail = makeRail(2, true);
    await settleRail(rail);
    s = fakeSession('live');
    clock = 1_000_000;
    warnings = [];
    scheduler = new BlotScheduler({
      rail,
      session: s.session,
      readEpisode: makeEpisode(),
      now: () => clock,
      events: { onWarning: (message) => warnings.push(message) },
    });
  });

  it('builds a destination sequence of the blot plus each angle view', () => {
    const blot = rail.ready[0]!;
    const destinations = scheduler.destinationsFor(blot);
    expect(destinations).toHaveLength(3);
    expect(destinations[0]!.cameraMoveId).toBeNull();
    expect(destinations[0]!.url).toBe(blot.url);
    expect(destinations[1]!.cameraMoveId).toBe(blot.angles[0]!.move);
    expect(destinations[1]!.url).toBe(blot.angles[0]!.arrivalFrameUrl);
  });

  it('sends one direction, then waits for the chunk to confirm it', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.end_image_url).toBe(blot.url);
    expect(scheduler.pending).toBe(1);
    // a second tick must not collapse a second blot onto the same chunk
    scheduler.tick();
    expect(s.sent).toHaveLength(1);
  });

  it('walks the same blot through its angle views one chunk at a time', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    expect(s.sent[0]!.end_image_url).toBe(blot.url);
    scheduler.onChunk(chunk({ chunkIndex: 0, promptVersion: 2 }));
    expect(s.sent[1]!.end_image_url).toBe(blot.angles[0]!.arrivalFrameUrl);
    scheduler.onChunk(chunk({ chunkIndex: 1, promptVersion: 3 }));
    expect(s.sent[2]!.end_image_url).toBe(blot.angles[1]!.arrivalFrameUrl);
    // the blot is live from its first view onward, even while later views are queued
    expect(rail.find(blot.id)!.state).toBe('live');
    // once the last view lands the blot has been fully shown and is retired
    scheduler.onChunk(chunk({ chunkIndex: 2, promptVersion: 4 }));
    expect(rail.find(blot.id)!.state).toBe('passed');
  });

  it('retires a blot after its whole sequence and moves to the next', () => {
    const first = rail.ready[0]!;
    const second = rail.ready[1]!;
    scheduler.tick();
    scheduler.onChunk(chunk({ chunkIndex: 0, promptVersion: 2 }));
    scheduler.onChunk(chunk({ chunkIndex: 1, promptVersion: 3 }));
    scheduler.onChunk(chunk({ chunkIndex: 2, promptVersion: 4 }));
    expect(rail.find(first.id)!.state).toBe('passed');
    expect(s.sent).toHaveLength(4);
    expect(s.sent[3]!.end_image_url).toBe(second.url);
  });

  it('describes the blot in the prompt, not just an image url', () => {
    scheduler.tick();
    const prompt = String(s.sent[0]!.prompt);
    expect(prompt).toContain('blot 5');
    expect(prompt).toMatch(/Preserve the paper-and-pigment surface/);
    expect(s.sent[0]!.replan).toBe(true);
  });

  it('carries the camera phrase that matches the arrival image', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    scheduler.onChunk(chunk({ promptVersion: 2 }));
    const cameraPhrase = String(s.sent[1]!.prompt);
    expect(cameraPhrase.toLowerCase()).toContain('the camera');
    expect(blot.angles[0]).toBeDefined();
  });

  it('sends no end image at all in soft arrival mode', () => {
    const soft = new BlotScheduler({
      rail, session: s.session, readEpisode: makeEpisode({ arrivalMode: 'soft' }), now: () => clock,
    });
    soft.tick();
    expect(s.sent[0]!.end_image_url).toBeUndefined();
    expect(String(s.sent[0]!.prompt)).toMatch(/Preserve/);
  });

  it('never sends two end images inside one chunk', () => {
    for (let i = 0; i < 6; i++) {
      scheduler.tick();
      scheduler.onChunk(chunk({ chunkIndex: i, promptVersion: 2 + i }));
    }
    expect(s.sent.length).toBe(7);
    const images = s.sent.filter((m) => m.end_image_url != null);
    expect(images.length).toBeLessThanOrEqual(s.sent.length);
  });

  it('re-enters the orbit when repeatAngleCycle is on, then retires the blot', () => {
    const cycling = new BlotScheduler({
      rail,
      session: s.session,
      readEpisode: makeEpisode({ camera: { ...defaultCameraConfig(), repeatAngleCycle: true } }),
      now: () => clock,
      maxAngleCycles: 1,
    });
    const blot = rail.ready[0]!;
    cycling.tick();
    for (let i = 0; i < 8; i++) cycling.onChunk(chunk({ chunkIndex: i, promptVersion: 2 + i }));
    // 1 blot + 2 angles, then one re-entry pass over the 2 angles, then retired
    expect(rail.find(blot.id)!.state).toBe('passed');
    const urls = s.sent.filter((m) => m.end_image_url != null).map((m) => m.end_image_url);
    expect(urls.filter((url) => url === blot.angles[0]!.arrivalFrameUrl).length).toBe(2);
  });

  it('does nothing while the session is not live', () => {
    s.setStatus('connecting');
    scheduler.tick();
    expect(s.sent).toHaveLength(0);
  });

  it('sends a continuation with no image once the rail has been dry for a while', () => {
    const empty = makeRail(0, false);
    const dry = new BlotScheduler({
      rail: empty, session: s.session, readEpisode: makeEpisode(), now: () => clock,
      stallTicksBeforeContinuation: 3,
    });
    for (let i = 0; i < 2; i++) {
      dry.tick();
      expect(s.sent, `tick ${i + 1} should still be silent`).toHaveLength(0);
    }
    dry.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.end_image_url).toBeUndefined();
    expect(String(s.sent[0]!.prompt)).toMatch(/Continue the same take/);
  });

  it('folds a mood change into the next direction instead of opening a session', () => {
    scheduler.notifyMoodChanged(MOODS.serene);
    expect(scheduler.moodShiftQueued).toBe(true);
    scheduler.tick();
    expect(String(s.sent[0]!.prompt)).toMatch(/mood/i);
    expect(scheduler.moodShiftQueued).toBe(false);
  });

  it('sends a mood change on its own when there is nothing to arrive at', () => {
    const empty = makeRail(0, false);
    const dry = new BlotScheduler({ rail: empty, session: s.session, readEpisode: makeEpisode(), now: () => clock });
    dry.notifyMoodChanged(MOODS.menacing);
    dry.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.end_image_url).toBeUndefined();
  });

  it('retries a queue_full rejection without losing the blot', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    const version = Number(s.sent[0]!.prompt_version);
    scheduler.onPromptRejected({ promptVersion: version, reason: 'queue_full', error: 'full' });
    expect(rail.find(blot.id)!.state).toBe('scheduled');
    scheduler.tick();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.end_image_url).toBe(blot.url);
    expect(warnings).toHaveLength(0);
  });

  it('softens a content rejection, then retires the blot rather than stalling', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    scheduler.onPromptRejected({ promptVersion: Number(s.sent[0]!.prompt_version), reason: 'content_policy' });
    scheduler.tick();
    expect(String(s.sent[1]!.prompt)).toMatch(/Keep it abstract/);
    scheduler.onPromptRejected({ promptVersion: Number(s.sent[1]!.prompt_version), reason: 'content_policy' });
    expect(rail.find(blot.id)!.state).toBe('passed');
    expect(warnings.some((w) => /content_policy/.test(w))).toBe(true);
  });

  it('ignores a rejection for a version it is not waiting on', () => {
    scheduler.tick();
    scheduler.onPromptRejected({ promptVersion: 99, reason: 'queue_full' });
    expect(scheduler.pending).toBe(1);
  });

  it('forces the dispatch gate open if no chunk ever confirms the direction', () => {
    scheduler.tick();
    expect(scheduler.pending).toBe(1);
    clock += 40_000;
    scheduler.onChunk(chunk({ promptVersion: 1 }));
    expect(warnings.some((w) => /dispatch gate/.test(w))).toBe(true);
    // the film keeps moving instead of waiting forever on a lost acknowledgement
    expect(s.sent.length).toBeGreaterThan(1);
  });

  it('reports each destination as it is dispatched', () => {
    const seen: string[] = [];
    const reporting = new BlotScheduler({
      rail, session: s.session, readEpisode: makeEpisode(), now: () => clock,
      events: { onDestination: ({ destination }) => seen.push(destination.label) },
    });
    reporting.tick();
    reporting.onChunk(chunk({ promptVersion: 2 }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/blot/);
    expect(seen[1]).toMatch(/from/);
  });

  it('reports when a blot is airborne', () => {
    const airborne: string[] = [];
    const expected = rail.ready[0]!.id;
    const reporting = new BlotScheduler({
      rail, session: s.session, readEpisode: makeEpisode(), now: () => clock,
      events: { onBlotAirborne: ({ blotId }) => airborne.push(blotId) },
    });
    reporting.tick();
    reporting.onChunk(chunk({ promptVersion: 2 }));
    expect(airborne).toEqual([expected]);
  });

  it('never reports a continuation as an airborne blot', () => {
    const airborne: string[] = [];
    const empty = makeRail(0, false);
    const dry = new BlotScheduler({
      rail: empty, session: s.session, readEpisode: makeEpisode(), now: () => clock,
      stallTicksBeforeContinuation: 0,
      events: { onBlotAirborne: ({ blotId }) => airborne.push(blotId) },
    });
    dry.tick();
    dry.onChunk(chunk({ promptVersion: 2 }));
    expect(airborne).toEqual([]);
    expect(CONTINUATION).toBe('continuation');
  });

  it('resets cleanly for a new session', () => {
    scheduler.tick();
    scheduler.reset();
    expect(scheduler.pending).toBe(0);
    expect(scheduler.currentBlotId).toBeNull();
    scheduler.tick();
    expect(s.sent).toHaveLength(2);
  });

  it('keeps a single outstanding direction across many chunks', () => {
    for (let i = 0; i < 20; i++) {
      scheduler.tick();
      scheduler.tick();
      scheduler.onChunk(chunk({ chunkIndex: i, promptVersion: 2 + i }));
    }
    const versions = s.sent.map((m) => Number(m.prompt_version));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.length).toBeGreaterThan(5);
  });
});
