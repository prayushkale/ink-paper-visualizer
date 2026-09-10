import { describe, it, expect } from 'vitest';
import { extractJsonObject, fallbackReading, parseReading } from './reading';

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('reads through a markdown fence', () => {
    expect(extractJsonObject('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });
  it('ignores prose around the object', () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a": 3}\nHope that helps.')).toEqual({ a: 3 });
  });
  it('handles braces and escapes inside strings', () => {
    const raw = '{"prompt":"a {curly} \\"quoted\\" line"}';
    expect(extractJsonObject(raw)).toEqual({ prompt: 'a {curly} "quoted" line' });
  });
  it('returns null for malformed or absent json', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"a": ')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
  it('falls back to the raw text when the fenced block is not json', () => {
    expect(extractJsonObject('```\nnot json\n```\n{"b": 9}')).toEqual({ b: 9 });
  });
});

describe('parseReading', () => {
  it('reads a well-formed structured reply', () => {
    const reading = parseReading(JSON.stringify({
      subject: 'a whale breaching',
      prompt: 'The pigment folds upward and becomes a whale breaking the surface, then the water closes.',
      transition: 'the stain lifts',
      moodTags: ['Oceanic', ' calm ', ''],
      sound: 'a long low note and water falling',
    }));
    expect(reading.subject).toBe('a whale breaching');
    expect(reading.prompt).toMatch(/whale breaking the surface/);
    expect(reading.transition).toBe('the stain lifts');
    expect(reading.moodTags).toEqual(['oceanic', 'calm']);
    expect(reading.sound).toMatch(/long low note/);
    expect(reading.structured).toBe(true);
  });

  it('accepts alternative field names a model might volunteer', () => {
    const reading = parseReading('{"title":"a crow","beat":"A crow steps out of the dark, then folds back into it.","audio":"wingbeats"}');
    expect(reading.subject).toBe('a crow');
    expect(reading.prompt).toMatch(/crow steps out/);
    expect(reading.sound).toBe('wingbeats');
    expect(reading.structured).toBe(true);
  });

  it('derives a subject when the model only gives a prompt', () => {
    const reading = parseReading('{"prompt":"A slow tide crosses the paper, gathering into ridges."}');
    expect(reading.subject.length).toBeGreaterThan(0);
    expect(reading.structured).toBe(true);
  });

  it('falls back to prose rather than failing', () => {
    const reading = parseReading('A raven settles on the edge of the stain and watches it spread.');
    expect(reading.prompt).toMatch(/raven settles/);
    expect(reading.subject).toMatch(/raven settles/);
    expect(reading.structured).toBe(false);
  });

  it('keeps a usable beat when the json is valid but empty', () => {
    const reading = parseReading('{"subject":"", "prompt":""}');
    expect(reading.structured).toBe(false);
    expect(reading.prompt.length).toBeGreaterThan(0);
  });

  it('never returns empty strings for prompt or subject', () => {
    for (const raw of ['', '   ', '{}', 'null', '```json\n{}\n```', '[]']) {
      const reading = parseReading(raw);
      expect(reading.prompt.length, `raw=${JSON.stringify(raw)}`).toBeGreaterThan(0);
      expect(reading.subject.length).toBeGreaterThan(0);
    }
  });

  it('clamps runaway output to sane lengths', () => {
    const reading = parseReading(JSON.stringify({
      subject: 'x'.repeat(500),
      prompt: 'y'.repeat(20000),
      transition: 'z'.repeat(500),
      sound: 'w'.repeat(2000),
      moodTags: Array.from({ length: 40 }, (_, i) => `tag${i}`),
    }));
    expect(reading.subject.length).toBeLessThanOrEqual(120);
    expect(reading.prompt.length).toBeLessThanOrEqual(1200);
    expect(reading.transition.length).toBeLessThanOrEqual(160);
    expect(reading.sound.length).toBeLessThanOrEqual(300);
    expect(reading.moodTags.length).toBeLessThanOrEqual(6);
  });

  it('tolerates non-string values without throwing', () => {
    const reading = parseReading('{"subject":42,"prompt":{"deep":true},"moodTags":[1,2,null],"sound":9}');
    expect(typeof reading.prompt).toBe('string');
    expect(typeof reading.subject).toBe('string');
    expect(reading.moodTags).toEqual([]);
  });

  it('survives null and undefined input', () => {
    expect(parseReading(undefined as unknown as string).prompt.length).toBeGreaterThan(0);
    expect(parseReading(null as unknown as string).prompt.length).toBeGreaterThan(0);
  });
});

describe('fallbackReading', () => {
  it('is deterministic and always usable', () => {
    expect(fallbackReading(7)).toEqual(fallbackReading(7));
    expect(fallbackReading(7).prompt.length).toBeGreaterThan(0);
    expect(fallbackReading(0).subject.length).toBeGreaterThan(0);
    expect(fallbackReading(-3).subject.length).toBeGreaterThan(0);
  });
});
