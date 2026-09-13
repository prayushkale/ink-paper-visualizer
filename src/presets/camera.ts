import { createRng, round } from '../ink/rng';

/** One keyframe of a Multi Angle camera trajectory. */
export interface CameraKeyframe {
  /** Normalized position in the clip, 0..1. Must ascend. */
  time: number;
  /** Degrees of orbit around the subject. Signed turns are preserved. */
  azimuth: number;
  /** Degrees up/down. Negative looks up from below. */
  elevation: number;
  /** 1 is the reference distance; smaller pushes in, larger pulls back. */
  distance: number;
}

export type CameraMoveId =
  | 'orbit-right'
  | 'orbit-left'
  | 'push-in'
  | 'pull-back'
  | 'crane-up'
  | 'fly-over'
  | 'slow-drift';

export interface CameraMove {
  id: CameraMoveId;
  label: string;
  /** Injected into the Director direction so the text and the camera agree. */
  phrase: string;
  /** Trajectory handed to `minimax/h3-max/multi-angle/image-to-video`. */
  keyframes(seed: number): CameraKeyframe[];
}

/**
 * The clip lengths Multi Angle accepts. The endpoint allows 5 to 15 seconds.
 */
export const MIN_ANGLE_SECONDS = 5;

/**
 * The longest one blot's clip may be.
 *
 * The clip exists to hand the film one more viewpoint of a blot, and the frame
 * it is handed is already a photograph, so the whole take is the camera's move
 * and nothing else: past seven seconds the model has run out of move to make
 * and invents, and every extra second is billed.
 */
export const MAX_ANGLE_SECONDS = 7;

/**
 * Multi Angle preserves signed turns up to 32 full rotations, and holds the
 * first pose before `time[0]` and the last pose after `time[n-1]`, so the final
 * keyframe is exactly the still we extract as a Director destination.
 */
export const CAMERA_MOVES: Record<CameraMoveId, CameraMove> = {
  'orbit-right': {
    id: 'orbit-right',
    label: 'Orbit right',
    phrase: 'the camera orbits slowly to the right around the mass',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0x1b873593);
      const turns = rng.pick([35, 45, 60, 90]);
      const arc = rng.next() < 0.5 ? 0.55 : 0.7;
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-4, 4), 1), distance: 1 },
        { time: round(arc, 3), azimuth: round(turns * 0.55, 1), elevation: round(rng.range(2, 12), 1), distance: round(rng.range(0.95, 1.1), 3) },
        { time: 1, azimuth: turns, elevation: round(rng.range(-2, 8), 1), distance: 1 },
      ];
    },
  },
  'orbit-left': {
    id: 'orbit-left',
    label: 'Orbit left',
    phrase: 'the camera orbits slowly to the left around the mass',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0x93e1a9c3);
      const turns = rng.pick([-35, -45, -60, -90]);
      const arc = rng.next() < 0.5 ? 0.55 : 0.7;
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-4, 4), 1), distance: 1 },
        { time: round(arc, 3), azimuth: round(turns * 0.55, 1), elevation: round(rng.range(2, 12), 1), distance: round(rng.range(0.95, 1.1), 3) },
        { time: 1, azimuth: turns, elevation: round(rng.range(-2, 8), 1), distance: 1 },
      ];
    },
  },
  'push-in': {
    id: 'push-in',
    label: 'Push in',
    phrase: 'the camera pushes in until the mass fills the frame',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0xc2b2ae35);
      const close = round(rng.range(0.3, 0.5), 3);
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-3, 3), 1), distance: 1 },
        { time: 0.6, azimuth: round(rng.range(-14, 14), 1), elevation: round(rng.range(-6, 10), 1), distance: round((1 + close) / 2, 3) },
        { time: 1, azimuth: round(rng.range(-20, 20), 1), elevation: round(rng.range(-8, 12), 1), distance: close },
      ];
    },
  },
  'pull-back': {
    id: 'pull-back',
    label: 'Pull back',
    phrase: 'the camera pulls back until the mass is a small shape in a wide field',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0x27d4eb2f);
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-3, 3), 1), distance: 1 },
        { time: 0.65, azimuth: round(rng.range(-12, 12), 1), elevation: round(rng.range(0, 14), 1), distance: round(rng.range(1.3, 1.6), 3) },
        { time: 1, azimuth: round(rng.range(-18, 18), 1), elevation: round(rng.range(2, 22), 1), distance: round(rng.range(1.7, 2.3), 3) },
      ];
    },
  },
  'crane-up': {
    id: 'crane-up',
    label: 'Crane up',
    phrase: 'the camera cranes upward, looking down on the mass from above',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0x165667b1);
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-4, 2), 1), distance: 1 },
        { time: 0.6, azimuth: round(rng.range(-10, 10), 1), elevation: round(rng.range(20, 35), 1), distance: round(rng.range(0.95, 1.15), 3) },
        { time: 1, azimuth: round(rng.range(-20, 20), 1), elevation: round(rng.range(42, 62), 1), distance: round(rng.range(1.0, 1.3), 3) },
      ];
    },
  },
  'fly-over': {
    id: 'fly-over',
    label: 'Fly over',
    phrase: 'the camera flies over the mass, horizon tilting, as if crossing a landscape',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0xd3a2646c);
      const turn = rng.pick([70, 95, 120]);
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-6, 0), 1), distance: round(rng.range(0.9, 1.05), 3) },
        { time: 0.5, azimuth: round(turn * 0.5, 1), elevation: round(rng.range(30, 45), 1), distance: round(rng.range(0.6, 0.85), 3) },
        { time: 1, azimuth: turn, elevation: round(rng.range(6, 20), 1), distance: round(rng.range(1.05, 1.4), 3) },
      ];
    },
  },
  'slow-drift': {
    id: 'slow-drift',
    label: 'Slow drift',
    phrase: 'the camera drifts almost imperceptibly, a held breath',
    keyframes: (seed) => {
      const rng = createRng(seed ^ 0xfd7046c5);
      const drift = round(rng.range(8, 22), 1);
      return [
        { time: 0, azimuth: 0, elevation: round(rng.range(-2, 2), 1), distance: 1 },
        { time: 0.5, azimuth: round(drift * 0.4, 1), elevation: round(rng.range(1, 6), 1), distance: round(rng.range(0.97, 1.04), 3) },
        { time: 1, azimuth: drift, elevation: round(rng.range(-1, 8), 1), distance: round(rng.range(0.96, 1.06), 3) },
      ];
    },
  },
};

export const CAMERA_MOVE_IDS = Object.keys(CAMERA_MOVES) as CameraMoveId[];

/**
 * Roughly one blot in five is given a camera move.
 *
 * The roll is per blot and independent, so the gaps vary exactly as a 1-in-5
 * rate implies: one blot in a row might get a move, then the next six might not.
 */
export const CAMERA_ANGLE_EVERY = 5;

/**
 * Length of one orbit clip, in seconds.
 *
 * Multi Angle accepts 5-15 seconds. The shortest is already more move than a
 * single blot needs - the clip is a viewpoint, not a scene - and every extra
 * second is billed.
 */
export const ANGLE_SECONDS = MIN_ANGLE_SECONDS;

/** Multi Angle's spelling of the three stream resolution tiers. */
export type AngleResolutionId = '480P' | '768P' | '1080P';

/** The orbit resolution that matches a stream resolution, tier for tier. */
export function angleResolutionFor(stream: '480p' | '768p' | '1080p'): AngleResolutionId {
  return stream === '1080p' ? '1080P' : stream === '768p' ? '768P' : '480P';
}

export interface CameraConfig {
  /**
   * Give some blots a camera move.
   *
   * When on, roughly one blot in five is handed one move - rolled at random
   * from the whole set - and one Multi Angle take is shot for it at the stream's
   * own resolution. The move is stamped on the blot, so the reading and the
   * direction the film's shot is given agree with the take. Every other blot is
   * plain: no orbit, no extra cost. The seam between sessions is always the last
   * frame, so the film never cuts to an angle.
   */
  enabled: boolean;
}

export function defaultCameraConfig(): CameraConfig {
  return { enabled: true };
}

/**
 * The camera move rolled for a blot, or null for the four in five that get none.
 *
 * Deterministic from the blot's own seed, so the selection survives a re-run and
 * a share code lands on the same blots. A blot that wins the roll then draws one
 * move from the whole enabled set.
 */
export function cameraMoveForSeed(seed: number): CameraMoveId | null {
  const rng = createRng(seed ^ 0x5f356495);
  if (!rng.bool(1 / CAMERA_ANGLE_EVERY)) return null;
  return rng.pick(CAMERA_MOVE_IDS);
}

/** Validates a trajectory against the model's documented constraints. */
export function validateTrajectory(frames: CameraKeyframe[]): { ok: boolean; reason?: string } {
  if (!Array.isArray(frames) || frames.length < 2) return { ok: false, reason: 'need at least two keyframes' };
  let previousTime = -1;
  let totalAzimuth = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > 1) {
      return { ok: false, reason: 'time must be within 0..1' };
    }
    if (frame.time < previousTime) return { ok: false, reason: 'time must not decrease' };
    previousTime = frame.time;
    if (!Number.isFinite(frame.azimuth) || Math.abs(frame.azimuth) > 360) {
      return { ok: false, reason: 'azimuth must be within ±360 degrees' };
    }
    totalAzimuth += Math.abs(frame.azimuth);
    if (!Number.isFinite(frame.distance) || frame.distance <= 0) {
      return { ok: false, reason: 'distance must be positive' };
    }
    if (!Number.isFinite(frame.elevation) || Math.abs(frame.elevation) > 90) {
      return { ok: false, reason: 'elevation must be within ±90 degrees' };
    }
  }
  // the model preserves at most 32 signed turns of total azimuth travel
  if (totalAzimuth / 360 > 32) return { ok: false, reason: 'more than 32 turns of azimuth travel' };
  return { ok: true };
}
