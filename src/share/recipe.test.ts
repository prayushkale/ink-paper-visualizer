import { describe, it, expect } from 'vitest';
import { decodeShare, describeShare, encodeShare, readShareFromHash, shareUrl, type SharedSettings } from './recipe';
import { BLOT_MARKS, MAX_FOLDS, defaultInkRecipe, inkRecipeFromSeed, renderOps } from '../ink/recipe';
import { canvasForAspect } from '../ink/types';

const fallback = defaultInkRecipe();

function makeShared(overrides: Partial<SharedSettings> = {}): SharedSettings {
  const recipe = inkRecipeFromSeed({
    seed: 4321,
    canvas: canvasForAspect('16:9'),
    palette: ['#101010', '#202020'],
    tools: ['drop', 'spray'],
    blotCount: 4,
    wetness: 0.4,
    bleed: 0.2,
    folds: [{ axis: 'vertical', direction: 'left', at: 0.42 }],
    grain: 0.1,
  });
  return {
    seed: 4321,
    recipe,
    moodId: 'cosmic',
    moodStrength: 0.8,
    musicId: 'trance',
    musicMode: 'pinned',
    camera: {
      enabled: true,
    },
    stream: { resolution: '768p', aspectRatio: '16:9', memory: 20, arrivalMode: 'soft' },
    sessionCapSeconds: 180,
    ...overrides,
  };
}

describe('encodeShare / decodeShare', () => {
  it('round trips a whole configuration', () => {
    const shared = makeShared();
    const decoded = decodeShare(encodeShare(shared), fallback);
    expect(decoded).toEqual(shared);
  });

  it('round trips the recipe exactly, so the blot is identical', () => {
    const shared = makeShared();
    const decoded = decodeShare(encodeShare(shared), fallback)!;
    expect(decoded.recipe).toEqual(shared.recipe);
    expect(renderOps(decoded.recipe)).toEqual(renderOps(shared.recipe));
  });

  it('produces a url-safe code', () => {
    const code = encodeShare(makeShared());
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code).not.toMatch(/[+/=]/);
  });

  it('survives unicode in the payload', () => {
    const shared = makeShared();
    shared.recipe.palette = ['#101010'];
    const decoded = decodeShare(encodeShare(shared), fallback);
    expect(decoded).not.toBeNull();
  });

  it('returns null for junk instead of throwing', () => {
    for (const code of ['', '   ', 'not base64!!', 'e30=', 'x'.repeat(20_000)]) {
      expect(() => decodeShare(code, fallback)).not.toThrow();
      expect(decodeShare(code, fallback)).toBeNull();
    }
  });

  it('returns null when the payload is valid base64 but not an object', () => {
    const code = encodeShare('hello' as unknown as SharedSettings);
    expect(decodeShare(code, fallback)).toBeNull();
  });

  it('rejects a payload with no seed at all', () => {
    expect(decodeShare(encodeShare({} as unknown as SharedSettings), fallback)).toBeNull();
    expect(decodeShare(encodeShare({ seed: 'x' } as unknown as SharedSettings), fallback)).toBeNull();
  });

  it('clamps hostile values into legal ranges', () => {
    const payload = {
      seed: -1,
      recipe: { seed: 1, blotCount: 9999, wetness: 5, bleed: -3, grain: 9, folds: [] },
      moodId: 'nonexistent',
      moodStrength: 12,
      musicId: 'polka',
      musicMode: 'loud',
      camera: { anglesPerBlot: 99, duration: 1, resolution: '8K', moves: ['spiral'], handoff: 'teleport', enabled: false },
      stream: { resolution: '4K', aspectRatio: '21:9', memory: 900, arrivalMode: 'smooth' },
      sessionCapSeconds: 5,
    };
    const code = encodeShare(payload as unknown as SharedSettings);
    const decoded = decodeShare(code, fallback)!;
    expect(decoded.recipe.blotCount).toBeLessThanOrEqual(BLOT_MARKS);
    expect(decoded.recipe.wetness).toBeLessThanOrEqual(1);
    expect(decoded.recipe.bleed).toBeGreaterThanOrEqual(0);
    expect(decoded.moodId).toBe('dreamlike');
    expect(decoded.musicId).toBe('ambient');
    expect(decoded.musicMode).toBe('pinned');
    expect(decoded.camera.enabled).toBe(false);
    expect(decoded.stream.memory).toBeLessThanOrEqual(50);
    expect(decoded.stream.arrivalMode).toBe('hard');
    expect(decoded.sessionCapSeconds).toBeGreaterThanOrEqual(10);
  });

  it('keeps a fold plan up to the fold ceiling and trims anything past it', () => {
    const plan = (count: number) => Array.from({ length: count }, () => ({
      axis: 'vertical' as const,
      direction: 'left' as const,
      at: 0.5,
    }));
    const full = makeShared();
    full.recipe = { ...full.recipe, folds: plan(MAX_FOLDS) };
    expect(decodeShare(encodeShare(full), fallback)!.recipe.folds).toHaveLength(MAX_FOLDS);

    const over = makeShared();
    over.recipe = { ...over.recipe, folds: plan(MAX_FOLDS + 2) };
    expect(decodeShare(encodeShare(over), fallback)!.recipe.folds).toHaveLength(MAX_FOLDS);
  });

  it('falls back to the supplied recipe when the payload has none', () => {
    const decoded = decodeShare(encodeShare({ seed: 5 } as unknown as SharedSettings), fallback)!;
    expect(decoded.recipe.canvas).toEqual(canvasForAspect('16:9', 1024));
    expect(decoded.recipe.palette.length).toBeGreaterThan(0);
  });

  it('derives a portrait canvas for a portrait share', () => {
    const shared = makeShared();
    shared.stream.aspectRatio = '9:16';
    shared.recipe = { ...shared.recipe, canvas: canvasForAspect('9:16') };
    const decoded = decodeShare(encodeShare(shared), fallback)!;
    expect(decoded.recipe.canvas.width).toBeLessThan(decoded.recipe.canvas.height);
  });
});

describe('shareUrl / readShareFromHash', () => {
  const loc = { origin: 'https://ink.example', pathname: '/' };

  it('builds a url a friend can open', () => {
    const url = shareUrl(makeShared(), loc);
    expect(url.startsWith('https://ink.example/#s=')).toBe(true);
    expect(readShareFromHash(url.slice(url.indexOf('#')), fallback)).toMatchObject({ seed: 4321, moodId: 'cosmic' });
  });

  it('finds the payload among other hash parameters', () => {
    const code = encodeShare(makeShared());
    expect(readShareFromHash(`#s=${code}&other=1`, fallback)).toMatchObject({ seed: 4321 });
    expect(readShareFromHash(`#watch=1&s=${code}`, fallback)).toMatchObject({ seed: 4321 });
  });

  it('returns null when there is no payload', () => {
    expect(readShareFromHash('', fallback)).toBeNull();
    expect(readShareFromHash('#watch=1', fallback)).toBeNull();
    expect(readShareFromHash('#s=@@@', fallback)).toBeNull();
  });
});

describe('describeShare', () => {
  it('summarises the run', () => {
    const text = describeShare(makeShared());
    expect(text).toContain('4321');
    expect(text).toContain('cosmic');
    expect(text).toContain('trance');
    expect(text).toContain('camera on');
  });
});
