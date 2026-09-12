import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BUDGET,
  DEFAULT_VISION_PROMPT,
  DIRECTOR_RATE,
  QUALITY_PRESETS,
  applyQualityPreset,
  defaultSettings,
  directorRate,
  estimateRun,
  loadSettings,
  mergeSettings,
  minutesLabel,
  multiAngleRate,
  planDestinations,
  qualityPresetDrifted,
  saveSettings,
  usd,
} from './state';
import { MOOD_IDS } from './presets/moods';
import { MUSIC_IDS } from './presets/music';
import { CAMERA_MOVE_IDS, MAX_ANGLE_SECONDS, MIN_ANGLE_SECONDS } from './presets/camera';
import { BLOT_MARKS } from './ink/recipe';

const PROMO_DAY = new Date('2026-09-10T12:00:00Z');
const LIST_DAY = new Date('2026-09-20T12:00:00Z');

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  } as Storage;
}

describe('rates', () => {
  it('uses the launch price before 2026-09-14 and list price after', () => {
    expect(directorRate(PROMO_DAY)).toBe(DIRECTOR_RATE.promo);
    expect(directorRate(LIST_DAY)).toBe(DIRECTOR_RATE.list);
    expect(multiAngleRate('480P', PROMO_DAY)).toBe(0.0125);
    expect(multiAngleRate('768P', PROMO_DAY)).toBe(0.02);
    expect(multiAngleRate('1080P', PROMO_DAY)).toBe(0.04);
    expect(multiAngleRate('480P', LIST_DAY)).toBe(0.05);
    expect(multiAngleRate('768P', LIST_DAY)).toBe(0.08);
    expect(multiAngleRate('1080P', LIST_DAY)).toBe(0.16);
  });

  it('falls back to the cheapest tier for an unknown resolution', () => {
    expect(multiAngleRate('nope' as never, PROMO_DAY)).toBe(0.0125);
  });
});

describe('planDestinations', () => {
  it('lands one destination per 10 s chunk', () => {
    expect(planDestinations(120, 0)).toEqual({ beats: 12, blots: 12, beatsPerBlot: 1 });
  });
  it('spends the angle views of a blot before moving on', () => {
    expect(planDestinations(120, 2)).toEqual({ beats: 12, blots: 4, beatsPerBlot: 3 });
    expect(planDestinations(120, 4)).toEqual({ beats: 12, blots: 2, beatsPerBlot: 5 });
  });
  it('always finds at least one blot once there is a chunk', () => {
    expect(planDestinations(30, 2).blots).toBe(1);
  });
  it('reports nothing for an empty run', () => {
    expect(planDestinations(0, 2)).toEqual({ beats: 0, blots: 0, beatsPerBlot: 3 });
  });
});

describe('estimateRun', () => {
  const base = {
    seconds: 120,
    sessionCapSeconds: 120,
    anglesPerBlot: 0,
    angleSeconds: 5,
    angleResolution: '480P' as const,
  };

  it('prices a two minute single session at the promo rate', () => {
    const estimate = estimateRun(base, PROMO_DAY);
    expect(estimate.sessions).toBe(1);
    expect(estimate.directorSeconds).toBe(120);
    expect(estimate.directorUsd).toBeCloseTo(2.4);
    expect(estimate.totalUsd).toBeCloseTo(2.4);
  });

  it('bills the 60 s minimum when a session is cut short', () => {
    const estimate = estimateRun({ ...base, seconds: 30 }, PROMO_DAY);
    expect(estimate.sessions).toBe(1);
    expect(estimate.directorSeconds).toBe(60);
    expect(estimate.directorUsd).toBeCloseTo(1.2);
  });

  it('bills each chained session at its own minimum', () => {
    const estimate = estimateRun({ ...base, seconds: 130, sessionCapSeconds: 120 }, PROMO_DAY);
    expect(estimate.sessions).toBe(2);
    // 120 s in the first session, then only 10 s of the second -> 60 s minimum
    expect(estimate.directorSeconds).toBe(180);
    expect(estimate.directorUsd).toBeCloseTo(3.6);
  });

  it('scales a long run across sessions', () => {
    const estimate = estimateRun({ ...base, seconds: 900, sessionCapSeconds: 120 }, PROMO_DAY);
    expect(estimate.sessions).toBe(8);
    expect(estimate.directorSeconds).toBe(900);
    expect(estimate.directorUsd).toBeCloseTo(18);
  });

  it('prices the angle takes separately, per resolution', () => {
    const estimate = estimateRun({ ...base, anglesPerBlot: 2 }, PROMO_DAY);
    // 12 beats over 3 beats per blot -> 4 blots -> 8 takes of 5 s at 480p
    expect(estimate.blots).toBe(4);
    expect(estimate.angleTakes).toBe(8);
    expect(estimate.angleSeconds).toBe(40);
    expect(estimate.angleUsd).toBeCloseTo(0.5);
    expect(estimate.totalUsd).toBeCloseTo(2.9);
  });

  it('charges more for angle takes at 768p after the promo', () => {
    const promo = estimateRun({ ...base, anglesPerBlot: 2, angleResolution: '768P' }, PROMO_DAY);
    const list = estimateRun({ ...base, anglesPerBlot: 2, angleResolution: '768P' }, LIST_DAY);
    expect(promo.angleUsd).toBeCloseTo(0.8);
    expect(list.angleUsd).toBeCloseTo(3.2);
    expect(list.directorUsd).toBeCloseTo(9.6);
  });

  it('costs nothing when there are no chunks', () => {
    const estimate = estimateRun({ ...base, seconds: 0, anglesPerBlot: 3 }, PROMO_DAY);
    expect(estimate.beats).toBe(0);
    expect(estimate.angleTakes).toBe(0);
    expect(estimate.directorSeconds).toBe(60); // one session still bills its minimum
  });

  it('reports an honest session count for short caps', () => {
    const estimate = estimateRun({ ...base, seconds: 600, sessionCapSeconds: 60 }, PROMO_DAY);
    expect(estimate.sessions).toBe(10);
    expect(estimate.directorSeconds).toBe(600);
  });
});

describe('formatting', () => {
  it('shortens durations', () => {
    expect(minutesLabel(45)).toBe('45s');
    expect(minutesLabel(120)).toBe('2m');
    expect(minutesLabel(150)).toBe('2m 30s');
  });
  it('formats usd to two places', () => {
    expect(usd(2.4)).toBe('$2.40');
    expect(usd(0)).toBe('$0.00');
  });
});

describe('defaultSettings', () => {
  it('builds a complete, sane studio configuration', () => {
    const settings = defaultSettings();
    expect(settings.version).toBe(3);
    expect(settings.quality).toBe('low');
    expect(settings.stream.falModel).toBe('minimax/h3-max/director');
    expect(settings.stream.resolution).toBe('480p');
    expect(settings.stream.memory).toBe(6);
    expect(settings.stream.autoChain).toBe(true);
    expect(MOOD_IDS).toContain(settings.moodId);
    expect(MUSIC_IDS).toContain(settings.music.musicId);
    // the bundled music folder ships empty, so the default score has to be the
    // one that needs no track to be dropped in first
    expect(settings.music.mode).toBe('generated');
    expect(settings.camera.enabled).toBe(false);
    expect(settings.camera.moves.every((move) => CAMERA_MOVE_IDS.includes(move))).toBe(true);
    expect(settings.budget).toEqual(DEFAULT_BUDGET);
    expect(settings.ink.blotCount).toBe(BLOT_MARKS);
    expect(settings.manualModeEnabled).toBe(true);
  });

  it('returns an independent object each time', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a.stream.memory = 40;
    a.ink.palette.push('#ffffff');
    expect(b.stream.memory).toBe(6);
    expect(b.ink.palette).not.toContain('#ffffff');
  });

  it('ships low as the cheapest preset', () => {
    const low = QUALITY_PRESETS.low;
    const medium = QUALITY_PRESETS.medium;
    const high = QUALITY_PRESETS.high;
    expect(low.camera.enabled).toBe(false);
    expect(low.camera.anglesPerBlot).toBe(0);
    expect(low.stream.resolution).toBe('480p');
    expect(low.budget.sessionCapSeconds).toBeLessThan(medium.budget.sessionCapSeconds);
    expect(medium.budget.sessionCapSeconds).toBeLessThan(high.budget.sessionCapSeconds);
    expect(low.budget.sessionCapUsd).toBeLessThan(medium.budget.sessionCapUsd);
    expect(medium.budget.sessionCapUsd).toBeLessThan(high.budget.sessionCapUsd);
  });
});

describe('applyQualityPreset', () => {
  it('writes the stream, camera and budget groups and is pure', () => {
    const base = defaultSettings();
    const before = structuredClone(base);
    const applied = applyQualityPreset(base, 'high');
    expect(applied).not.toBe(base);
    expect(base).toEqual(before);
    expect(applied.quality).toBe('high');
    expect(applied.stream.resolution).toBe('1080p');
    expect(applied.camera.enabled).toBe(true);
    expect(applied.camera.anglesPerBlot).toBe(4);
    expect(applied.budget.sessionCapSeconds).toBe(600);
  });

  it('reports drift when a derived value is edited by hand', () => {
    const applied = applyQualityPreset(defaultSettings(), 'medium');
    expect(qualityPresetDrifted(applied)).toBe(false);
    applied.stream.memory = 3;
    expect(qualityPresetDrifted(applied)).toBe(true);
  });
});

describe('mergeSettings', () => {
  it('merges nested objects instead of replacing them', () => {
    const merged = mergeSettings(defaultSettings(), { stream: { resolution: '480p' }, moodStrength: 0.2 });
    expect(merged.stream.resolution).toBe('480p');
    expect(merged.stream.memory).toBe(6);
    expect(merged.moodStrength).toBeCloseTo(0.2);
  });

  it('never restores runtime-only state from a stored payload', () => {
    const merged = mergeSettings(defaultSettings(), { music: { resolvedUrl: 'https://fal.media/t.mp3' } });
    expect(merged.music.resolvedUrl).toBeNull();
  });

  it('clamps hostile or out-of-range payloads into legal ranges', () => {
    const merged = mergeSettings(defaultSettings(), {
      stream: { memory: 999 },
      camera: { anglesPerBlot: -4 },
      budget: { sessionCapSeconds: 5 },
      moodStrength: 7,
      music: { volume: -1 },
    });
    expect(merged.stream.memory).toBe(50);
    expect(merged.camera.anglesPerBlot).toBe(0);
    expect(merged.budget.sessionCapSeconds).toBe(10);
    expect(merged.moodStrength).toBe(1);
    expect(merged.music.volume).toBe(0);
  });

  it('survives junk payloads', () => {
    const base = defaultSettings();
    for (const junk of [null, undefined, 42, 'text', [], true]) {
      expect(mergeSettings(base, junk)).toEqual(base);
    }
  });

  it('does not let a payload escalate the version or drop required fields', () => {
    const merged = mergeSettings(defaultSettings(), { version: 99, ink: null });
    expect(merged.version).toBe(3);
    expect(merged.ink.blotCount).toBeGreaterThan(0);
  });
});

describe('loadSettings / saveSettings', () => {
  it('returns defaults with no storage at all', () => {
    expect(loadSettings(null)).toEqual(defaultSettings());
  });

  it('round trips', () => {
    const storage = memoryStorage();
    const settings = defaultSettings();
    settings.stream.memory = 30;
    settings.moodId = 'menacing';
    saveSettings(settings, storage);
    const loaded = loadSettings(storage);
    expect(loaded.stream.memory).toBe(30);
    expect(loaded.moodId).toBe('menacing');
  });

  it('migrates the v1 blob without losing the chosen model or prompt', () => {
    const storage = memoryStorage({
      'ink-paper-settings-v1': JSON.stringify({
        openrouterModel: 'google/gemini-2.5-flash',
        visionPrompt: 'look deeply',
        video: { falModel: 'minimax/h3-max-turbo/image-to-video', duration: 5 },
      }),
    });
    const loaded = loadSettings(storage);
    expect(loaded.openrouterModel).toBe('google/gemini-2.5-flash');
    expect(loaded.visionPrompt).toBe('look deeply');
    // the removed clip mode leaves no trace
    expect(JSON.stringify(loaded)).not.toContain('h3-max-turbo');
  });

  it('falls back to defaults on a corrupt payload', () => {
    const storage = memoryStorage({ 'ink-paper-studio-v2': '{not json' });
    expect(loadSettings(storage)).toEqual(defaultSettings());
  });

  it('ships the deepseek vision model by default', () => {
    expect(defaultSettings().openrouterModel).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('asks the shipped imagining for a seven second clip that switches in a second', () => {
    const prompt = defaultSettings().visionPrompt;
    expect(prompt).toMatch(/no more than seven seconds long/);
    expect(prompt).toMatch(/within the first second/);
    expect(prompt).toMatch(/live-action/);
  });

  it('moves a stored copy of an old shipped prompt forward, and leaves a typed one alone', () => {
    const storage = memoryStorage();
    const shipped = defaultSettings();
    // what this app used to ship, verbatim
    shipped.visionPrompt =
      'You are a visionary film director. Study this abstract ink blot painting. Let its shapes, colors and negative space suggest something only you can see - figures, landscapes, creatures, weather, machines, dreams. Then write ONE vivid video-generation prompt for a short cinematic video that STARTS exactly from this painting as its first frame and then comes alive and evolves into what you imagined. Describe subject, motion, camera movement, lighting and mood. Output ONLY the video prompt text, under 150 words, no preamble.';
    saveSettings(shipped, storage);
    expect(loadSettings(storage).visionPrompt).toBe(DEFAULT_VISION_PROMPT);

    shipped.visionPrompt = 'look deeply at the stain';
    saveSettings(shipped, storage);
    expect(loadSettings(storage).visionPrompt).toBe('look deeply at the stain');
  });

  it('clamps a stored orbit length into the range a blot clip may use', () => {
    const storage = memoryStorage();
    const stored = defaultSettings();
    stored.camera.duration = 15;
    saveSettings(stored, storage);
    expect(loadSettings(storage).camera.duration).toBe(MAX_ANGLE_SECONDS);

    stored.camera.duration = 1;
    saveSettings(stored, storage);
    expect(loadSettings(storage).camera.duration).toBe(MIN_ANGLE_SECONDS);
  });

  it('migrates a stored superseded default model onto the current one', () => {
    const storage = memoryStorage({
      'ink-paper-studio-v2': JSON.stringify({ openrouterModel: 'z-ai/glm-5.3-flash' }),
    });
    expect(loadSettings(storage).openrouterModel).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('keeps a vision model the user deliberately typed in', () => {
    const storage = memoryStorage({
      'ink-paper-studio-v2': JSON.stringify({ openrouterModel: 'anthropic/claude-4.6-sonnet' }),
    });
    expect(loadSettings(storage).openrouterModel).toBe('anthropic/claude-4.6-sonnet');
  });

  it('survives storage that throws', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(loadSettings(hostile)).toEqual(defaultSettings());
    expect(() => saveSettings(defaultSettings(), hostile)).not.toThrow();
  });

  it('clears the resolved music url on save round trip', () => {
    const storage = memoryStorage();
    const settings = defaultSettings();
    settings.music.resolvedUrl = 'https://fal.media/uploaded.mp3';
    saveSettings(settings, storage);
    expect(loadSettings(storage).music.resolvedUrl).toBeNull();
  });
});
