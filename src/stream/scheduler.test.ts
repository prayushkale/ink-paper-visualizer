import { describe, it, expect, beforeEach } from 'vitest';
import { BlotScheduler, CONTINUATION, type SchedulerEpisode, type SchedulerSession } from './scheduler';
import { BlotRail, DEFAULT_RAIL_OPTIONS, type RailPorts } from '../rail/queue';
import { fallbackReading } from '../rail/reading';
import { inkRecipeFromSeed } from '../ink/recipe';
import { CAMERA_MOVES, defaultCameraConfig } from '../presets/camera';
import { MOODS } from '../presets/moods';
import { MUSIC_PRESETS } from '../presets/music';
import { buildPrompt, type ChunkInfo } from './protocol';
import type { StudioStatus } from '../state';

function makeRail(enabled = true) {
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
      camera: { ...defaultCameraConfig(), enabled },
      moodStrength: 0.6,
      palette: MOODS.dreamlike.palette,
    }),
    now: () => 1_700_000_000_000,
    nextId: (prefix) => `${prefix}-${++id}`,
    nextSeed: () => ++seed,
    angleCostUsd: () => 0.06,
  };
  return new BlotRail(ports, { ...DEFAULT_RAIL_OPTIONS, preparedTarget: 4, maxJobs: 4 });
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
    rail = makeRail(true);
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

  it('gives a blot one destination: the photograph the imagining made', () => {
    const blot = rail.ready[0]!;
    const destinations = scheduler.destinationsFor(blot);
    expect(destinations).toHaveLength(1);
    expect(destinations[0]!.url).toBe(blot.url);
    // the shot is given the move rolled for this blot, so the film's shots walk
    // the enabled moves instead of all using the first one
    expect(destinations[0]!.cameraMoveId).toBe(blot.cameraMove);
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

  it('holds a blot for one chunk and then moves to the next', () => {
    const first = rail.ready[0]!;
    const second = rail.ready[1]!;
    scheduler.tick();
    expect(s.sent[0]!.end_image_url).toBe(first.url);
    scheduler.onChunk(chunk({ chunkIndex: 0, promptVersion: 2 }));
    // one blot, one chunk: the next direction is the next blot's photograph
    expect(s.sent[1]!.end_image_url).toBe(second.url);
    expect(rail.find(first.id)!.state).toBe('passed');
    // and the blot whose photograph the film is arriving at is the live one
    expect(rail.find(second.id)!.state).toBe('scheduled');
  });

  it('describes the blot in the prompt, not just an image url', () => {
    scheduler.tick();
    const prompt = String(s.sent[0]!.prompt);
    expect(prompt).toContain('blot 5');
    expect(prompt).toMatch(/Preserve the live-action photographic look/);
    expect(s.sent[0]!.replan).toBe(true);
  });

  it('carries the camera phrase for the move rolled for the blot', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    expect(blot.cameraMove).toBeDefined();
    // the shot is described with the same move the blot's take was shot for
    expect(String(s.sent[0]!.prompt).toLowerCase()).toContain(CAMERA_MOVES[blot.cameraMove!].phrase.toLowerCase());
  });

  it('sends no end image at all in soft arrival mode', () => {
    const soft = new BlotScheduler({
      rail, session: s.session, readEpisode: makeEpisode({ arrivalMode: 'soft' }), now: () => clock,
    });
    soft.tick();
    expect(s.sent[0]!.end_image_url).toBeUndefined();
    expect(String(s.sent[0]!.prompt)).toMatch(/Preserve/);
  });

  it('airs each blot exactly once', () => {
    // one destination per blot: a blot's photograph is never handed over twice,
    // and no blot can be skipped by a burst of directions
    for (let i = 0; i < 8; i++) {
      scheduler.tick();
      scheduler.onChunk(chunk({ chunkIndex: i, promptVersion: 2 + i }));
    }
    const urls = s.sent.filter((m) => m.end_image_url != null).map((m) => m.end_image_url);
    expect(urls.length).toBeGreaterThan(2);
    expect(new Set(urls).size).toBe(urls.length);
    // and every direction carries at most one arrival image
    expect(urls.length).toBeLessThanOrEqual(s.sent.length);
  });

  it('does nothing while the session is not live', () => {
    s.setStatus('connecting');
    scheduler.tick();
    expect(s.sent).toHaveLength(0);
  });

  it('sends a continuation with no image once the rail has been dry for a while', () => {
    const empty = makeRail(false);
    const stalls: number[] = [];
    const dry = new BlotScheduler({
      rail: empty, session: s.session, readEpisode: makeEpisode(), now: () => clock,
      stallTicksBeforeContinuation: 3,
      events: { onStall: (info) => stalls.push(info.emptyTicks) },
    });
    for (let i = 0; i < 2; i++) {
      dry.tick();
      expect(s.sent, `tick ${i + 1} should still be silent`).toHaveLength(0);
      expect(stalls, `tick ${i + 1} is not a stall yet`).toHaveLength(0);
    }
    dry.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.end_image_url).toBeUndefined();
    expect(String(s.sent[0]!.prompt)).toMatch(/Continue the same take/);
    // three ticks with nothing to send is the condition worth reporting
    expect(stalls).toEqual([3]);
  });

  it('does not report a mood change as a dry rail', () => {
    // A continuation also carries a mood change, and one of those is sent on the
    // first tick - long before the rail has been given a chance to produce a
    // blot. Saying the rail ran dry there told people the film was short of
    // blots when the direction was their own mood change riding along.
    const empty = makeRail(false);
    const stalls: number[] = [];
    const moody = new BlotScheduler({
      rail: empty, session: s.session, readEpisode: makeEpisode(), now: () => clock,
      stallTicksBeforeContinuation: 3,
      events: { onStall: (info) => stalls.push(info.emptyTicks) },
    });
    moody.notifyMoodChanged(MOODS.menacing);
    moody.tick();
    expect(s.sent).toHaveLength(1);
    expect(String(s.sent[0]!.prompt)).toMatch(/mood/i);
    expect(stalls).toHaveLength(0);
  });

  it('folds a mood change into the next direction instead of opening a session', () => {
    scheduler.notifyMoodChanged(MOODS.serene);
    expect(scheduler.moodShiftQueued).toBe(true);
    scheduler.tick();
    expect(String(s.sent[0]!.prompt)).toMatch(/mood/i);
    expect(scheduler.moodShiftQueued).toBe(false);
  });

  it('sends a mood change on its own when there is nothing to arrive at', () => {
    const empty = makeRail(false);
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
    expect(String(s.sent[1]!.prompt)).toMatch(/Keep it non-literal/);
    scheduler.onPromptRejected({ promptVersion: Number(s.sent[1]!.prompt_version), reason: 'content_policy' });
    expect(rail.find(blot.id)!.state).toBe('passed');
    expect(warnings.some((w) => /content_policy/.test(w))).toBe(true);
  });

  it('ignores a rejection for a version it is not waiting on', () => {
    scheduler.tick();
    scheduler.onPromptRejected({ promptVersion: 99, reason: 'queue_full' });
    expect(scheduler.pending).toBe(1);
  });

  it('sends an unconfirmed direction again instead of losing the blot', () => {
    const blot = rail.ready[0]!;
    scheduler.tick();
    expect(scheduler.pending).toBe(1);
    clock += 40_000;
    scheduler.onChunk(chunk({ promptVersion: 1 }));
    expect(warnings.some((w) => /again/.test(w))).toBe(true);
    // the film keeps moving instead of waiting forever on a lost acknowledgement,
    // and it is still heading for the blot whose direction went unconfirmed
    expect(s.sent.length).toBeGreaterThan(1);
    expect(s.sent[1]!.end_image_url).toBe(blot.url);
  });

  it('reopens the gate on its own when no chunk arrives at all', () => {
    // onChunk can only notice a lost acknowledgement if a chunk arrives, so a
    // session that stops generating has to be checked from outside
    scheduler.tick();
    expect(scheduler.pending).toBe(1);
    expect(scheduler.checkDispatchTimeout()).toBe(false);
    clock += 40_000;
    expect(scheduler.checkDispatchTimeout()).toBe(true);
    expect(warnings.some((w) => /again/.test(w))).toBe(true);
    expect(scheduler.pending).toBe(0);
    // and the film can be sent its next destination immediately
    scheduler.tick();
    expect(s.sent.length).toBeGreaterThan(1);
  });

  it('gives up on an unconfirmed direction after one re-send', () => {
    const first = rail.ready[0]!;
    scheduler.tick();
    clock += 40_000;
    expect(scheduler.checkDispatchTimeout()).toBe(true);
    scheduler.tick();
    expect(s.sent).toHaveLength(2);
    // the same blot is being asked for again, so nothing new was dispatched
    expect(s.sent[1]!.end_image_url).toBe(s.sent[0]!.end_image_url);
    clock += 40_000;
    expect(scheduler.checkDispatchTimeout()).toBe(true);
    expect(warnings.some((w) => /dispatch gate/.test(w))).toBe(true);
    scheduler.tick();
    // the retry is not open-ended: the film moves on rather than sending the
    // same blot a third time
    expect(s.sent[2]!.end_image_url).not.toBe(s.sent[0]!.end_image_url);
    expect(rail.find(first.id)!.state).toBe('passed');
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
    expect(seen[1]).toMatch(/blot/);
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
    const empty = makeRail(false);
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
