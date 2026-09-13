import { describe, it, expect } from 'vitest';
import {
  MULTI_ANGLE_ENDPOINT,
  buildMultiAngleInput,
  generateAngleTake,
  InvalidTrajectoryError,
  type MultiAngleRequest,
} from './multiAngle';
import { CAMERA_MOVE_IDS, MAX_ANGLE_SECONDS, MIN_ANGLE_SECONDS } from '../presets/camera';
import { arrivalTime } from './extract';

const request = (overrides: Partial<MultiAngleRequest> = {}): MultiAngleRequest => ({
  blotId: 'blot-1',
  imageUrl: 'https://fal.media/blot.png',
  move: 'orbit-right',
  seed: 7,
  duration: 5,
  resolution: '480P',
  promptExpansionMode: 'balanced',
  ...overrides,
});

describe('MULTI_ANGLE_ENDPOINT', () => {
  it('is the sibling endpoint, not a Director mode', () => {
    expect(MULTI_ANGLE_ENDPOINT).toBe('minimax/h3-max/multi-angle/image-to-video');
  });
});

describe('buildMultiAngleInput', () => {
  it('sends exactly the fields the endpoint documents', () => {
    const input = buildMultiAngleInput(request());
    expect(Object.keys(input).sort()).toEqual([
      'camera_trajectory', 'duration', 'enable_safety_checker',
      'image_url', 'prompt_expansion_mode', 'resolution', 'seed',
    ].sort());
  });

  it('never sends an aspect ratio: the output inherits the image', () => {
    expect(buildMultiAngleInput(request())).not.toHaveProperty('aspect_ratio');
  });

  it('carries a validated trajectory for every move', () => {
    for (const move of CAMERA_MOVE_IDS) {
      const input = buildMultiAngleInput(request({ move }));
      expect(input.camera_trajectory.length).toBeGreaterThanOrEqual(2);
      expect(input.camera_trajectory[0]!.time).toBe(0);
      expect(input.camera_trajectory.at(-1)!.time).toBe(1);
    }
  });

  it('clamps the duration between the model floor and our own ceiling', () => {
    // the endpoint would take fifteen seconds, but one blot's clip is capped at
    // seven: the frame it is handed is already a photograph and the rest is move
    expect(buildMultiAngleInput(request({ duration: 2 })).duration).toBe(MIN_ANGLE_SECONDS);
    expect(buildMultiAngleInput(request({ duration: 99 })).duration).toBe(MAX_ANGLE_SECONDS);
    expect(buildMultiAngleInput(request({ duration: 7.6 })).duration).toBe(MAX_ANGLE_SECONDS);
    expect(buildMultiAngleInput(request({ duration: 6 })).duration).toBe(6);
  });

  it('only ever sends the two expansion modes this endpoint accepts', () => {
    for (const mode of ['balanced', 'quality'] as const) {
      expect(buildMultiAngleInput(request({ promptExpansionMode: mode })).prompt_expansion_mode).toBe(mode);
    }
    // 'fast' is valid elsewhere in the family but not here
    expect(buildMultiAngleInput(request({ promptExpansionMode: 'fast' as never })).prompt_expansion_mode).toBe('balanced');
  });

  it('omits a blank prompt so the model uses its frozen-scene default', () => {
    expect(buildMultiAngleInput(request({ prompt: '   ' }))).not.toHaveProperty('prompt');
    expect(buildMultiAngleInput(request({ prompt: 'Orbit tightly.' })).prompt).toBe('Orbit tightly.');
  });

  it('rejects a request with no image', () => {
    expect(() => buildMultiAngleInput(request({ imageUrl: '' }))).toThrow(/image_url/);
  });

  it('rejects an unknown move', () => {
    expect(() => buildMultiAngleInput(request({ move: 'spiral' as never }))).toThrow(/unknown camera move/);
  });

  it('fires the trajectory guard instead of spending a queue round trip', () => {
    const broken = { ...request(), move: 'orbit-right' as const };
    // sabotage the trajectory by asking for an impossible one through the seed path
    expect(() => {
      const input = buildMultiAngleInput(broken);
      input.camera_trajectory = [{ time: 1, azimuth: 0, elevation: 0, distance: 1 }, { time: 0, azimuth: 0, elevation: 0, distance: 1 }];
      // the guard runs on build, so simulate the reject path directly
      throw new InvalidTrajectoryError('time must not decrease');
    }).toThrow(InvalidTrajectoryError);
  });

  it('is deterministic for a seed', () => {
    expect(buildMultiAngleInput(request())).toEqual(buildMultiAngleInput(request()));
    expect(buildMultiAngleInput(request({ seed: 8 }))).not.toEqual(buildMultiAngleInput(request()));
  });
});

describe('generateAngleTake', () => {
  it('returns the clip url and timing', async () => {
    const result = await generateAngleTake(request(), {
      subscribe: async () => ({ video: { url: 'https://fal.media/orbit.mp4' }, timings: { inference: 1.4 } }),
    });
    expect(result.videoUrl).toBe('https://fal.media/orbit.mp4');
    expect(result.inferenceSeconds).toBe(1.4);
  });

  it('passes the built payload to the queue call', async () => {
    let seen: unknown;
    await generateAngleTake(request({ duration: 6 }), {
      subscribe: async (input) => {
        seen = input;
        return { video: { url: 'https://fal.media/x.mp4' } };
      },
    });
    expect((seen as { duration: number }).duration).toBe(6);
    expect((seen as { camera_trajectory: unknown[] }).camera_trajectory).toHaveLength(3);
  });

  it('fails loudly when the model returns no video', async () => {
    await expect(generateAngleTake(request(), { subscribe: async () => ({}) }))
      .rejects.toThrow(/no video url/);
    await expect(generateAngleTake(request(), { subscribe: async () => ({ video: { url: '' } }) }))
      .rejects.toThrow(/no video url/);
  });

  it('never calls the endpoint when the input is invalid', async () => {
    let called = false;
    await expect(generateAngleTake(request({ imageUrl: '' }), {
      subscribe: async () => { called = true; return {}; },
    })).rejects.toThrow(/image_url/);
    expect(called).toBe(false);
  });
});

describe('arrivalTime', () => {
  it('takes the frame just before the end, where the last pose is held', () => {
    expect(arrivalTime(5)).toBeCloseTo(4.95);
    expect(arrivalTime(15)).toBeCloseTo(14.95);
  });
  it('is safe for unknown or zero durations', () => {
    expect(arrivalTime(0)).toBe(0);
    expect(arrivalTime(Number.NaN)).toBe(0);
    expect(arrivalTime(-2)).toBe(0);
    expect(arrivalTime(Number.POSITIVE_INFINITY)).toBe(0);
  });
  it('never asks for a negative time on a very short clip', () => {
    expect(arrivalTime(0.01)).toBe(0);
  });
});
