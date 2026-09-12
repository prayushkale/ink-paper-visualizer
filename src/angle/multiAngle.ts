import {
  CAMERA_MOVES,
  MAX_ANGLE_SECONDS,
  MIN_ANGLE_SECONDS,
  validateTrajectory,
  type CameraKeyframe,
  type CameraMoveId,
} from '../presets/camera';

export const MULTI_ANGLE_ENDPOINT = 'minimax/h3-max/multi-angle/image-to-video';

export interface MultiAngleRequest {
  blotId: string;
  imageUrl: string;
  move: CameraMoveId;
  seed: number;
  duration: number;
  resolution: '480P' | '768P' | '1080P';
  promptExpansionMode: 'balanced' | 'quality';
  /** Optional override; the model's own frozen-scene default is used otherwise. */
  prompt?: string;
}

export interface MultiAngleInput {
  image_url: string;
  camera_trajectory: CameraKeyframe[];
  duration: number;
  resolution: string;
  seed: number;
  prompt_expansion_mode: string;
  enable_safety_checker: boolean;
  prompt?: string;
}

export class InvalidTrajectoryError extends Error {
  constructor(reason: string) {
    super(`camera trajectory rejected before it was sent: ${reason}`);
    this.name = 'InvalidTrajectoryError';
  }
}

/**
 * The clip length actually asked for: the endpoint's own five-second floor under
 * our seven-second ceiling. Shared so a prompt describing the clip can never
 * quote a length the request did not send.
 */
export function clampAngleSeconds(seconds: number): number {
  return Math.min(MAX_ANGLE_SECONDS, Math.max(MIN_ANGLE_SECONDS, Math.round(seconds)));
}

/**
 * Builds the Multi Angle payload. Kept pure and strict: the endpoint rejects
 * unknown fields, and a bad trajectory costs a real queue round trip, so both
 * are caught here rather than at the API.
 *
 * Note there is deliberately no `aspect_ratio`: image-to-video inherits the
 * ratio of the image it is given, which is why the blot canvas is rendered in
 * the session's aspect ratio in the first place.
 */
export function buildMultiAngleInput(request: MultiAngleRequest): MultiAngleInput {
  if (!request.imageUrl) throw new Error('multi angle needs an image_url');
  const keyframes = CAMERA_MOVES[request.move]?.keyframes(request.seed);
  if (!keyframes) throw new Error(`unknown camera move: ${request.move}`);
  const verdict = validateTrajectory(keyframes);
  if (!verdict.ok) throw new InvalidTrajectoryError(verdict.reason ?? 'unknown');
  // the endpoint would take fifteen seconds; a blot's own clip is capped at seven
  const duration = clampAngleSeconds(request.duration);
  const input: MultiAngleInput = {
    image_url: request.imageUrl,
    camera_trajectory: keyframes,
    duration,
    resolution: request.resolution,
    seed: request.seed >>> 0,
    // Multi Angle accepts only these two; 'fast' is not a valid mode here.
    prompt_expansion_mode: request.promptExpansionMode === 'quality' ? 'quality' : 'balanced',
    enable_safety_checker: true,
  };
  const prompt = request.prompt?.trim();
  if (prompt) input.prompt = prompt;
  return input;
}

export interface MultiAngleResult {
  videoUrl: string;
  expandedPrompt?: string;
  inferenceSeconds?: number;
}

export interface MultiAngleDeps {
  subscribe(input: MultiAngleInput): Promise<unknown>;
}

interface RawMultiAngleOutput {
  video?: { url?: unknown };
  expanded_prompt?: unknown;
  timings?: { inference?: unknown };
}

/** Runs one orbit take and returns the clip URL. */
export async function generateAngleTake(
  request: MultiAngleRequest,
  deps: MultiAngleDeps,
): Promise<MultiAngleResult> {
  const input = buildMultiAngleInput(request);
  const raw = (await deps.subscribe(input)) as RawMultiAngleOutput;
  const url = raw?.video?.url;
  if (typeof url !== 'string' || url === '') {
    throw new Error('multi angle returned no video url');
  }
  return {
    videoUrl: url,
    expandedPrompt: typeof raw.expanded_prompt === 'string' ? raw.expanded_prompt : undefined,
    inferenceSeconds: typeof raw.timings?.inference === 'number' ? raw.timings.inference : undefined,
  };
}
