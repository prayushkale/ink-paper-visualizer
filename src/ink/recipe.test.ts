import { describe, it, expect } from 'vitest';
import {
  INK_PALETTES,
  foldPlan,
  inkRecipeFromSeed,
  recipeKey,
  renderOps,
  defaultInkRecipe,
} from './recipe';
import { createRng } from './rng';
import { canvasForAspect, INK_TOOLS } from './types';

const base = () => inkRecipeFromSeed({
  seed: 4242,
  canvas: canvasForAspect('16:9'),
  palette: INK_PALETTES.ink,
  blotCount: 5,
  wetness: 0.5,
  bleed: 0.2,
  folds: 'auto',
  grain: 0.2,
});

describe('canvasForAspect', () => {
  it('produces the ratio the model will receive', () => {
    expect(canvasForAspect('16:9', 1024)).toEqual({ width: 1024, height: 576 });
    expect(canvasForAspect('9:16', 1024)).toEqual({ width: 576, height: 1024 });
    expect(canvasForAspect('1:1', 1024)).toEqual({ width: 1024, height: 1024 });
  });
});

describe('foldPlan', () => {
  it('always produces a valid plan of 0-3 folds', () => {
    for (let seed = 0; seed < 600; seed++) {
      const folds = foldPlan(createRng(seed));
      expect(folds.length).toBeGreaterThanOrEqual(0);
      expect(folds.length).toBeLessThanOrEqual(3);
      for (const fold of folds) {
        expect(['vertical', 'horizontal']).toContain(fold.axis);
        expect(
          fold.axis === 'vertical' ? ['left', 'right'] : ['top', 'bottom'],
        ).toContain(fold.direction);
        expect(fold.at).toBeGreaterThanOrEqual(0.36);
        expect(fold.at).toBeLessThanOrEqual(0.64);
      }
    }
  });

  it('produces unsymmetric blots sometimes and over-folded ones rarely', () => {
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<number, number>;
    for (let seed = 0; seed < 4000; seed++) {
      counts[foldPlan(createRng(seed)).length]!++;
    }
    expect(counts[0]).toBeGreaterThan(200);   // a decent share stay unsymmetric
    expect(counts[1]).toBeGreaterThan(counts[2]);
    expect(counts[3]).toBeLessThan(counts[1]);
  });

  it('mixes vertical and horizontal creases', () => {
    const axes = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      for (const fold of foldPlan(createRng(seed))) axes.add(fold.axis);
    }
    expect(axes).toEqual(new Set(['vertical', 'horizontal']));
  });
});

describe('inkRecipeFromSeed', () => {
  it('is reproducible', () => {
    expect(base()).toEqual(base());
  });

  it('changes with the seed', () => {
    const a = inkRecipeFromSeed({ seed: 1, folds: 'auto' });
    const b = inkRecipeFromSeed({ seed: 2, folds: 'auto' });
    expect(recipeKey(a)).not.toBe(recipeKey(b));
  });

  it('honours explicit overrides', () => {
    const recipe = inkRecipeFromSeed({
      seed: 9,
      canvas: canvasForAspect('9:16'),
      palette: INK_PALETTES.ember,
      tools: ['drop'],
      blotCount: 2,
      wetness: 0.1,
      bleed: 0,
      folds: [],
      grain: 0,
    });
    expect(recipe.canvas).toEqual({ width: 576, height: 1024 });
    expect(recipe.palette).toEqual(INK_PALETTES.ember);
    expect(recipe.tools).toEqual(['drop']);
    expect(recipe.blotCount).toBe(2);
    expect(recipe.folds).toEqual([]);
    expect(recipe.wetness).toBeCloseTo(0.1);
    expect(recipe.grain).toBe(0);
  });

  it('keeps a copy of its inputs so later mutation cannot rewrite history', () => {
    const palette = ['#000000'];
    const recipe = inkRecipeFromSeed({ seed: 1, palette });
    palette.push('#ffffff');
    expect(recipe.palette).toEqual(['#000000']);
  });

  it('defaults folds to an automatic plan and lets explicit folds win', () => {
    const automatic = inkRecipeFromSeed({ seed: 3 });
    expect(automatic.folds).toEqual(inkRecipeFromSeed({ seed: 3, folds: 'auto' }).folds);
    expect(automatic.folds.length).toBeLessThanOrEqual(3);
    const explicit = inkRecipeFromSeed({ seed: 3, folds: [{ axis: 'vertical', direction: 'left', at: 0.5 }] });
    expect(explicit.folds).toEqual([{ axis: 'vertical', direction: 'left', at: 0.5 }]);
  });

  it('falls back to the full tool set rather than an empty one', () => {
    const recipe = inkRecipeFromSeed({ seed: 1, tools: [] });
    expect(recipe.tools).toEqual([...INK_TOOLS]);
  });
});

describe('renderOps', () => {
  it('is deterministic: a recipe replays to the same op log', () => {
    const recipe = base();
    expect(renderOps(recipe)).toEqual(renderOps(recipe));
  });

  it('produces exactly blotCount ops', () => {
    expect(renderOps(base())).toHaveLength(5);
    expect(renderOps(inkRecipeFromSeed({ seed: 8, blotCount: 11 }))).toHaveLength(11);
  });

  it('only reaches for the tools it was given', () => {
    const recipe = inkRecipeFromSeed({ seed: 77, tools: ['drop', 'spray'], blotCount: 40 });
    const used = new Set(renderOps(recipe).map((op) => op.tool));
    expect([...used].every((tool) => tool === 'drop' || tool === 'spray')).toBe(true);
    expect(used.size).toBe(2);
  });

  it('only uses colours from the palette', () => {
    const recipe = inkRecipeFromSeed({ seed: 5, palette: ['#101010', '#202020'], blotCount: 30 });
    const used = new Set(renderOps(recipe).map((op) => op.color));
    expect([...used].every((color) => recipe.palette.includes(color))).toBe(true);
  });

  it('keeps every op inside the canvas and within numeric bounds', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const op of renderOps(inkRecipeFromSeed({ seed, blotCount: 12 }))) {
        expect(op.points.length).toBeGreaterThan(0);
        for (const point of op.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(1);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(1);
        }
        expect(op.width).toBeGreaterThan(0);
        expect(op.alpha).toBeGreaterThan(0);
        expect(op.alpha).toBeLessThanOrEqual(1);
        expect(op.wetness).toBeGreaterThanOrEqual(0);
        expect(op.wetness).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives path tools more than one control point', () => {
    const ops = renderOps(inkRecipeFromSeed({ seed: 21, tools: ['curve'], blotCount: 20 }));
    for (const op of ops) expect(op.points.length).toBeGreaterThanOrEqual(3);
    const streaks = renderOps(inkRecipeFromSeed({ seed: 22, tools: ['streak'], blotCount: 10 }));
    for (const op of streaks) expect(op.points).toHaveLength(2);
  });

  it('never mutates the recipe', () => {
    const recipe = base();
    const before = JSON.stringify(recipe);
    renderOps(recipe);
    expect(JSON.stringify(recipe)).toBe(before);
  });
});

describe('recipeKey', () => {
  it('is stable and sensitive to every meaningful field', () => {
    const recipe = inkRecipeFromSeed({
      seed: 100,
      folds: [{ axis: 'vertical', direction: 'left', at: 0.5 }, { axis: 'horizontal', direction: 'top', at: 0.42 }],
    });
    expect(recipeKey(recipe)).toBe(recipeKey({ ...recipe }));
    expect(recipeKey(recipe)).not.toBe(recipeKey({ ...recipe, seed: 101 }));
    expect(recipeKey(recipe)).not.toBe(recipeKey({ ...recipe, wetness: recipe.wetness + 0.01 }));
    expect(recipeKey(recipe)).not.toBe(recipeKey({ ...recipe, folds: [] }));
    expect(recipeKey(recipe)).not.toBe(recipeKey({ ...recipe, canvas: { width: 1, height: 1 } }));
  });
});

describe('defaultInkRecipe', () => {
  it('is a valid recipe independent of import order', () => {
    const recipe = defaultInkRecipe();
    expect(recipe.version).toBe(1);
    expect(recipe.palette.length).toBeGreaterThan(0);
    expect(renderOps(recipe).length).toBe(recipe.blotCount);
    expect(defaultInkRecipe()).toEqual(recipe);
  });
});
