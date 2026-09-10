import { describe, it, expect } from 'vitest';
import { createRng, parseSeed, clamp, clamp01, round } from './rng';

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const sequenceA = Array.from({ length: 8 }, () => a.next());
    const sequenceB = Array.from({ length: 8 }, () => b.next());
    expect(sequenceA).toEqual(sequenceB);
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 6 }, () => createRng(1).next());
    const b = Array.from({ length: 6 }, () => createRng(2).next());
    expect(a).not.toEqual(b);
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('survives a zero seed', () => {
    const rng = createRng(0);
    expect(Number.isFinite(rng.next())).toBe(true);
    expect(rng.int(1, 6)).toBeGreaterThanOrEqual(1);
  });

  it('int is inclusive at both ends and never escapes the range', () => {
    const rng = createRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 800; i++) {
      const value = rng.int(1, 6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect(seen.has(1)).toBe(true);
    expect(seen.has(6)).toBe(true);
  });

  it('range respects its bounds', () => {
    const rng = createRng(5);
    for (let i = 0; i < 200; i++) {
      const value = rng.range(-2, 3);
      expect(value).toBeGreaterThanOrEqual(-2);
      expect(value).toBeLessThan(3);
    }
  });

  it('pick throws rather than returning undefined for an empty list', () => {
    expect(() => createRng(1).pick([])).toThrow(/empty/);
  });

  it('bool honours the probability extremes', () => {
    const rng = createRng(3);
    expect(rng.bool(0)).toBe(false);
    expect(rng.bool(1)).toBe(true);
  });

  it('fork produces an independent but deterministic stream', () => {
    const parent = createRng(42);
    const first = parent.fork();
    const second = createRng(42).fork();
    expect(Array.from({ length: 5 }, () => first.next()))
      .toEqual(Array.from({ length: 5 }, () => second.next()));
  });
});

describe('parseSeed', () => {
  it('accepts integers and keeps their sign off', () => {
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed('-7')).toBe(7);
    expect(parseSeed(123)).toBe(123);
  });

  it('hashes words into a stable seed and ignores surrounding space', () => {
    const first = parseSeed('moonlit harbour');
    expect(first).toBe(parseSeed('moonlit harbour'));
    expect(first).toBe(parseSeed('  moonlit harbour  '));
    expect(first).not.toBe(parseSeed('moonlit harbor'));
    expect(Number.isInteger(first)).toBe(true);
  });

  it('falls back to a fresh seed for blank input', () => {
    expect(parseSeed('')).toBeGreaterThanOrEqual(0);
    expect(parseSeed(null)).toBeGreaterThanOrEqual(0);
    expect(parseSeed(undefined)).toBeGreaterThanOrEqual(0);
  });
});

describe('numeric helpers', () => {
  it('clamp bounds both sides', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
  it('clamp01 is clamp(0,1)', () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-2)).toBe(0);
  });
  it('round trims to the requested precision', () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(1.23456, 0)).toBe(1);
  });
});
