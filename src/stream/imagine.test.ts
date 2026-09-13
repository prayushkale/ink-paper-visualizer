import { describe, it, expect } from 'vitest';
import {
  IMAGINE_ENDPOINT,
  buildImagineInput,
  composeImaginePrompt,
  generateImagining,
  imagineSize,
} from './imagine';
import { fallbackReading } from '../rail/reading';
import { MOODS } from '../presets/moods';

const reading = { ...fallbackReading(7), subject: 'a whale under ice', prompt: 'The whale rolls and the ice cracks above it.' };

describe('imagineSize', () => {
  it('asks for a still in the stream\'s own shape', () => {
    expect(imagineSize('16:9')).toEqual({ width: 1280, height: 720 });
    expect(imagineSize('9:16')).toEqual({ width: 720, height: 1280 });
    expect(imagineSize('1:1')).toEqual({ width: 1024, height: 1024 });
  });

  it('stays inside the endpoint\'s 512-2048 box on every edge', () => {
    for (const ratio of ['16:9', '9:16', '1:1'] as const) {
      const { width, height } = imagineSize(ratio);
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(512);
      expect(Math.max(width, height)).toBeLessThanOrEqual(2048);
    }
  });
});

describe('composeImaginePrompt', () => {
  it('asks for the scene as a photograph and refuses the medium', () => {
    const prompt = composeImaginePrompt({ reading, mood: MOODS.dreamlike });
    expect(prompt).toContain('Repaint the attached ink painting as a photograph');
    expect(prompt).toContain('a whale under ice');
    expect(prompt).toContain('The whale rolls and the ice cracks above it.');
    expect(prompt).toContain(MOODS.dreamlike.label);
    expect(prompt).toMatch(/No paper, no ink, no pigment/);
  });

  it('survives a reading with nothing in it', () => {
    const prompt = composeImaginePrompt({
      reading: { subject: '', prompt: '', transition: '', moodTags: [], sound: '', structured: false },
      mood: MOODS.dreamlike,
    });
    expect(prompt).toContain('Repaint the attached ink painting as a photograph');
    expect(prompt).not.toMatch(/\n\n\n/);
  });
});

describe('buildImagineInput', () => {
  it('hands the model the blot, the reading and the size', () => {
    const input = buildImagineInput({
      imageUrl: 'https://fal.media/blot.png',
      reading,
      mood: MOODS.dreamlike,
      aspectRatio: '16:9',
      seed: 12,
    });
    expect(input.image_urls).toEqual(['https://fal.media/blot.png']);
    expect(input.image_size).toEqual({ width: 1280, height: 720 });
    expect(input.num_images).toBe(1);
    expect(input.output_format).toBe('png');
    // the prompt is already written for this model; expanding it again drifts
    expect(input.enable_prompt_expansion).toBe(false);
    expect(input.seed).toBe(12);
    // the safety checker is never switched off: disabling it needs account authorization
    expect(input.enable_safety_checker).toBe(true);
  });
});

describe('generateImagining', () => {
  it('returns the hosted still', async () => {
    const result = await generateImagining(
      buildImagineInput({ imageUrl: 'https://fal.media/blot.png', reading, mood: MOODS.dreamlike, aspectRatio: '1:1', seed: 1 }),
      { subscribe: async () => ({ images: [{ url: 'https://fal.media/scene.png' }] }) },
    );
    expect(result.url).toBe('https://fal.media/scene.png');
  });

  it('refuses an empty answer rather than handing on nothing', async () => {
    await expect(generateImagining(
      buildImagineInput({ imageUrl: 'https://fal.media/blot.png', reading, mood: MOODS.dreamlike, aspectRatio: '1:1', seed: 1 }),
      { subscribe: async () => ({ images: [] }) },
    )).rejects.toThrow(/no picture/);
  });
});

it('names the image model the proxy has to allow', () => {
  expect(IMAGINE_ENDPOINT).toBe('fal-ai/flux-2/turbo/edit');
});
