import { describe, it, expect } from 'vitest';
import {
  ANGLE_SECONDS,
  CAMERA_ANGLE_EVERY,
  CAMERA_MOVES,
  CAMERA_MOVE_IDS,
  MAX_ANGLE_SECONDS,
  MIN_ANGLE_SECONDS,
  angleResolutionFor,
  cameraMoveForSeed,
  defaultCameraConfig,
  validateTrajectory,
} from './camera';

const seeds = [0, 1, 7, 42, 1234, 99999];

describe('camera moves', () => {
  it('publishes a phrase for every move so text and camera agree', () => {
    for (const id of CAMERA_MOVE_IDS) {
      expect(CAMERA_MOVES[id].label.length).toBeGreaterThan(0);
      expect(CAMERA_MOVES[id].phrase.length).toBeGreaterThan(0);
      expect(CAMERA_MOVES[id].id).toBe(id);
    }
  });

  it('produces trajectories the Multi Angle endpoint accepts', () => {
    for (const id of CAMERA_MOVE_IDS) {
      for (const seed of seeds) {
        const frames = CAMERA_MOVES[id].keyframes(seed);
        const verdict = validateTrajectory(frames);
        expect(verdict.ok, `${id}/${seed}: ${verdict.reason}`).toBe(true);
      }
    }
  });

  it('starts at time 0 and holds to time 1', () => {
    for (const id of CAMERA_MOVE_IDS) {
      for (const seed of seeds) {
        const frames = CAMERA_MOVES[id].keyframes(seed);
        expect(frames[0]!.time).toBe(0);
        expect(frames[frames.length - 1]!.time).toBe(1);
      }
    }
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = CAMERA_MOVES['orbit-right'].keyframes(11);
    const b = CAMERA_MOVES['orbit-right'].keyframes(11);
    expect(a).toEqual(b);
    const different = seeds.map((seed) => JSON.stringify(CAMERA_MOVES['orbit-right'].keyframes(seed)));
    expect(new Set(different).size).toBeGreaterThan(1);
  });

  it('keeps every value inside the documented bounds', () => {
    for (const id of CAMERA_MOVE_IDS) {
      for (const seed of seeds) {
        for (const frame of CAMERA_MOVES[id].keyframes(seed)) {
          expect(Math.abs(frame.azimuth)).toBeLessThanOrEqual(360);
          expect(Math.abs(frame.elevation)).toBeLessThanOrEqual(90);
          // distance stays near reference so the subject keeps its framing
          expect(frame.distance).toBeGreaterThan(0.2);
          expect(frame.distance).toBeLessThanOrEqual(2.5);
        }
      }
    }
  });

  it('really moves the camera: no move is a no-op after the first frame', () => {
    for (const id of CAMERA_MOVE_IDS) {
      const frames = CAMERA_MOVES[id].keyframes(5);
      const start = frames[0]!;
      const end = frames[frames.length - 1]!;
      const moved = Math.abs(end.azimuth - start.azimuth) > 3 ||
        Math.abs(end.elevation - start.elevation) > 3 ||
        Math.abs(end.distance - start.distance) > 0.03;
      expect(moved, `${id} barely moves`).toBe(true);
    }
  });

  it('orbits in the direction its name promises', () => {
    expect(CAMERA_MOVES['orbit-right'].keyframes(3).at(-1)!.azimuth).toBeGreaterThan(0);
    expect(CAMERA_MOVES['orbit-left'].keyframes(3).at(-1)!.azimuth).toBeLessThan(0);
    expect(CAMERA_MOVES['push-in'].keyframes(3).at(-1)!.distance).toBeLessThan(1);
    expect(CAMERA_MOVES['pull-back'].keyframes(3).at(-1)!.distance).toBeGreaterThan(1);
    expect(CAMERA_MOVES['crane-up'].keyframes(3).at(-1)!.elevation).toBeGreaterThan(10);
  });
});

describe('validateTrajectory', () => {
  const ok = [
    { time: 0, azimuth: 0, elevation: 0, distance: 1 },
    { time: 1, azimuth: 40, elevation: 5, distance: 1 },
  ];

  it('accepts a sane two-frame path', () => {
    expect(validateTrajectory(ok)).toEqual({ ok: true });
  });

  it('rejects too few frames', () => {
    expect(validateTrajectory([]).ok).toBe(false);
    expect(validateTrajectory([ok[0]!]).ok).toBe(false);
  });

  it('rejects time that moves backwards or leaves 0..1', () => {
    expect(validateTrajectory([ok[1]!, ok[0]!]).ok).toBe(false);
    expect(validateTrajectory([{ ...ok[0]!, time: -0.1 }, ok[1]!]).ok).toBe(false);
    expect(validateTrajectory([ok[0]!, { ...ok[1]!, time: 1.5 }]).ok).toBe(false);
  });

  it('rejects out-of-range azimuth, elevation and distance', () => {
    expect(validateTrajectory([ok[0]!, { ...ok[1]!, azimuth: 400 }]).ok).toBe(false);
    expect(validateTrajectory([ok[0]!, { ...ok[1]!, elevation: 120 }]).ok).toBe(false);
    expect(validateTrajectory([ok[0]!, { ...ok[1]!, distance: 0 }]).ok).toBe(false);
  });

  it('rejects more azimuth travel than the model preserves', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({
      time: i / 39, azimuth: 360, elevation: 0, distance: 1,
    }));
    expect(validateTrajectory(frames)).toMatchObject({ ok: false });
    expect(validateTrajectory(frames).reason).toMatch(/turns/);
  });

  it('accepts a signed full turn', () => {
    expect(validateTrajectory([ok[0]!, { time: 0.5, azimuth: -180, elevation: 0, distance: 1 }, ok[1]!]).ok).toBe(true);
  });

  it('rejects non-numeric values', () => {
    expect(validateTrajectory([ok[0]!, { ...ok[1]!, azimuth: Number.NaN }]).ok).toBe(false);
    expect(validateTrajectory('nope' as unknown as typeof ok).ok).toBe(false);
  });
});

describe('defaultCameraConfig', () => {
  it('is one switch, on by default', () => {
    expect(defaultCameraConfig()).toEqual({ enabled: true });
  });
});

describe('angle constants', () => {
  it('rolls about one blot in five', () => {
    expect(CAMERA_ANGLE_EVERY).toBe(5);
  });

  it('keeps the clip inside the range the endpoint accepts', () => {
    expect(ANGLE_SECONDS).toBeGreaterThanOrEqual(MIN_ANGLE_SECONDS);
    expect(ANGLE_SECONDS).toBeLessThanOrEqual(MAX_ANGLE_SECONDS);
  });
});

describe('angleResolutionFor', () => {
  it('matches the stream tier, tier for tier', () => {
    expect(angleResolutionFor('480p')).toBe('480P');
    expect(angleResolutionFor('768p')).toBe('768P');
    expect(angleResolutionFor('1080p')).toBe('1080P');
  });
});

describe('cameraMoveForSeed', () => {
  const seeds = Array.from({ length: 1000 }, (_, index) => index + 1);

  it('is deterministic: the same blot always rolls the same move', () => {
    for (const seed of seeds.slice(0, 60)) {
      expect(cameraMoveForSeed(seed)).toBe(cameraMoveForSeed(seed));
    }
  });

  it('picks roughly one blot in five and leaves the rest plain', () => {
    const picked = seeds.filter((seed) => cameraMoveForSeed(seed) !== null).length;
    expect(picked / seeds.length).toBeGreaterThan(0.15);
    expect(picked / seeds.length).toBeLessThan(0.25);
  });

  it('only ever hands out a move from the whole set', () => {
    for (const seed of seeds) {
      const move = cameraMoveForSeed(seed);
      if (move) expect(CAMERA_MOVE_IDS).toContain(move);
    }
  });

  it('spaces the picks unevenly, the way a 1-in-5 roll implies', () => {
    const picked = seeds.filter((seed) => cameraMoveForSeed(seed) !== null);
    const gaps = picked.slice(1).map((seed, index) => seed - picked[index]!);
    // a fixed cycle would give one gap; an independent roll gives several
    expect(new Set(gaps).size).toBeGreaterThan(3);
  });
});
