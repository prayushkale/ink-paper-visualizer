/**
 * Deterministic RNG. Every blot, fold plan and camera trajectory in the studio
 * is derived from a seed through this, so a run is reproducible and shareable.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniformly picks one element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  bool(p: number): boolean;
  /** A fresh rng seeded from this one, for sub-tasks. */
  fork(): Rng;
  /** A short stable integer, handy for per-op seeds. */
  seed32(): number;
}

/** mulberry32: small, fast, and stable across engines. */
export function createRng(seed: number): Rng {
  let state = (Math.floor(seed) || 1) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(rng.range(min, max + 1)),
    range: (min, max) => min + next() * (max - min),
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[Math.floor(next() * items.length) % items.length]!;
    },
    bool: (p) => next() < p,
    fork: () => createRng(rng.seed32()),
    seed32: () => Math.floor(next() * 0xffffffff) >>> 0,
  };
  return rng;
}

/** Parses a seed from user input; blank/invalid becomes a fresh random seed. */
export function parseSeed(raw: string | number | null | undefined, fallback = () => Math.floor(Math.random() * 0xffffffff)): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.abs(Math.floor(raw));
  const text = String(raw ?? '').trim();
  if (text === '') return fallback();
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && Number.isInteger(asNumber)) return Math.abs(asNumber);
  // stable string hash so words work as seeds too
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) >>> 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
