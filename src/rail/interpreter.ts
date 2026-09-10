import { api } from '../api/client';
import { CAMERA_MOVES, type CameraMoveId } from '../presets/camera';
import type { MoodPreset } from '../presets/moods';
import type { MusicPreset } from '../presets/music';
import { composeVisionPrompt } from '../stream/promptComposer';
import { parseReading, type BlotReading } from './reading';

export interface InterpretRequest {
  imageDataUri: string;
  model: string;
  visionPrompt: string;
}

/** The single call the interpreter makes, so it can be faked in tests. */
export interface VisionCaller {
  call(request: InterpretRequest): Promise<string>;
}

export interface InterpreterArgs {
  imageDataUri: string;
  mood: MoodPreset;
  music: MusicPreset;
  cameraMoveId: CameraMoveId | null;
  previousPrompts: readonly string[];
  beatIndex: number;
  moodStrength: number;
}

export interface StudioInterpreterOptions {
  model: string;
  basePrompt: string;
  caller?: VisionCaller;
}

const defaultCaller: VisionCaller = {
  call: ({ imageDataUri, model, visionPrompt }) =>
    api.interpret({ image: imageDataUri, model, visionPrompt }),
};

/**
 * Turns a blot into the next beat of the film.
 *
 * The model is asked for JSON, but it is not trusted to provide it: whatever
 * comes back is parsed leniently, and a total failure still yields a usable
 * beat so the stream never stops for a vision call.
 */
export function createStudioInterpreter(options: StudioInterpreterOptions) {
  const caller = options.caller ?? defaultCaller;
  return async function interpret(args: InterpreterArgs): Promise<BlotReading> {
    const visionPrompt = composeVisionPrompt({
      basePrompt: options.basePrompt,
      mood: args.mood,
      music: args.music,
      camera: args.cameraMoveId ? CAMERA_MOVES[args.cameraMoveId] : null,
      previousPrompts: args.previousPrompts,
      beatIndex: args.beatIndex,
      moodStrength: args.moodStrength,
    });
    const raw = await caller.call({
      imageDataUri: args.imageDataUri,
      model: options.model,
      visionPrompt,
    });
    return parseReading(raw);
  };
}
