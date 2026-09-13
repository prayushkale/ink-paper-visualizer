import type { BlotReading } from '../rail/reading';
import type { MoodPreset } from '../presets/moods';
import type { AspectRatio } from '../ink/types';

/**
 * The imagining: an ink blot turned into the photograph the film is built from.
 *
 * The blot is a reference, never a picture. Handed straight to the Director it
 * *is* the picture - the model animates the ink, and every beat arrives on a
 * painted frame. So each blot is realised as a still first, by an image-editing
 * model that is asked to photograph what the vision model saw in it, and it is
 * that photograph (never the blot) the video model opens on and arrives at.
 *
 * `fal-ai/flux-2/turbo/edit` is a normal queue endpoint, so it goes through the
 * fal client pointed at our proxy like Multi Angle does. The proxy allowlists
 * the endpoint (`server/index.mjs`).
 */
export const IMAGINE_ENDPOINT = 'fal-ai/flux-2/turbo/edit';

/** The endpoint's own ceiling is 2048px; 1280 matches the stream's long edge. */
export const IMAGINE_LONG_EDGE = 1280;

export interface ImagineRequest {
  /** The hosted ink blot the model edits. */
  imageUrl: string;
  /** The reading, i.e. what the vision model saw in the blot. */
  reading: BlotReading;
  mood: MoodPreset;
  aspectRatio: AspectRatio;
  seed: number;
}

export interface ImagineInput {
  prompt: string;
  image_urls: string[];
  image_size: { width: number; height: number };
  num_images: number;
  output_format: 'png';
  enable_safety_checker: boolean;
  enable_prompt_expansion: boolean;
  guidance_scale: number;
  seed: number;
}

/** The size the still is asked for, matching the stream's own shape. */
export function imagineSize(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: Math.round((IMAGINE_LONG_EDGE * 9) / 16 / 2) * 2, height: IMAGINE_LONG_EDGE };
    case '1:1':
      return { width: 1024, height: 1024 };
    case '16:9':
    default:
      return { width: IMAGINE_LONG_EDGE, height: Math.round((IMAGINE_LONG_EDGE * 9) / 16 / 2) * 2 };
  }
}

/**
 * What the image model is asked for.
 *
 * The paint is an instruction, not a description: the attached blot is the
 * composition and the palette, and the reading is the scene to photograph. The
 * clauses at the end are the ones that keep the model from returning a nicer
 * painting - "no ink, no paper, no pigment, no brush marks" is the whole point
 * of the step.
 */
export function composeImaginePrompt(input: { reading: BlotReading; mood: MoodPreset }): string {
  const subject = input.reading.subject.trim();
  const beat = input.reading.prompt.trim();
  return [
    'Repaint the attached ink painting as a photograph. Keep its forms, its composition and its colours; its shapes depict a real scene, so photograph that scene instead of the ink.',
    subject === '' ? '' : `The scene: ${subject}.`,
    beat === '' ? '' : beat,
    `Mood: ${input.mood.label} - ${input.mood.lead}`,
    'Real photography of a real place in real materials - skin, water, dust, stone, metal, fabric, weather - with practical light, natural motion blur and true optics, shot on 35mm.',
    'No paper, no ink, no pigment, no brush marks, no wash, no drawing, no illustration, no text, no logos, no legible signage.',
  ].filter((line) => line !== '').join('\n\n');
}

export function buildImagineInput(request: ImagineRequest): ImagineInput {
  return {
    prompt: composeImaginePrompt({ reading: request.reading, mood: request.mood }),
    image_urls: [request.imageUrl],
    image_size: imagineSize(request.aspectRatio),
    num_images: 1,
    output_format: 'png',
    enable_safety_checker: true,
    // the prompt is already written for this model; expanding it again drifts
    enable_prompt_expansion: false,
    guidance_scale: 2.5,
    seed: request.seed >>> 0,
  };
}

export interface ImagineDeps {
  subscribe(input: ImagineInput): Promise<unknown>;
}

interface RawImagineOutput {
  images?: Array<{ url?: unknown }>;
}

/** Runs one imagining and returns the hosted still's URL. */
export async function generateImagining(
  input: ImagineInput,
  deps: ImagineDeps,
): Promise<{ url: string }> {
  const raw = (await deps.subscribe(input)) as RawImagineOutput;
  const url = raw?.images?.[0]?.url;
  if (typeof url !== 'string' || url === '') {
    throw new Error('the image model returned no picture');
  }
  return { url };
}
