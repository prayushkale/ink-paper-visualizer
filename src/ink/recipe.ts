import { createRng, clamp, clamp01, round, type Rng } from './rng';
import {
  INK_TOOLS,
  canvasForAspect,
  type CanvasSpec,
  type Fold,
  type InkOp,
  type InkRecipe,
  type InkToolId,
  type UV,
} from './types';

/** Ink palettes that read well as pigment on warm paper. */
export const INK_PALETTES: Record<string, string[]> = {
  ink: ['#141821', '#1f2933', '#2b2b33'],
  sepia: ['#3b2a1e', '#5a3d26', '#7a5b3a'],
  indigo: ['#1b2a49', '#26406b', '#3d5a8a'],
  ember: ['#5b1d18', '#8c2f1f', '#c25a2a'],
  verdigris: ['#123f38', '#1d6b52', '#3f9d7a'],
  rose: ['#5c1f33', '#8e2f4a', '#c46a7d'],
  ochre: ['#6b4a12', '#9c7320', '#c9a154'],
  violet: ['#2c1a4a', '#452a70', '#6a4a9c'],
  mono: ['#0f0f12', '#2d2d33', '#5a5a63'],
  duotone: ['#101820', '#c0552a'],
};

export const PALETTE_IDS = Object.keys(INK_PALETTES) as Array<keyof typeof INK_PALETTES>;

/**
 * The full pigment range the engine may reach for. The studio no longer lets a
 * palette be chosen by hand: every blot draws its own colours from here, so a
 * film wanders through the whole range instead of sitting in one family.
 */
export const INK_COLOR_RANGE: readonly string[] = [
  '#141821', '#1f2933', '#2b2b33', '#0f0f12', '#2d2d33', '#5a5a63',
  '#3b2a1e', '#5a3d26', '#7a5b3a', '#6b4a12', '#9c7320', '#c9a154',
  '#1b2a49', '#26406b', '#3d5a8a', '#101a3a', '#2c1a4a', '#452a70',
  '#6a4a9c', '#8f7fd8', '#c3b6e8',
  '#5b1d18', '#8c2f1f', '#c25a2a', '#e8a020', '#f46036',
  '#123f38', '#1d6b52', '#3f9d7a', '#0d5c63', '#1b998b',
  '#5c1f33', '#8e2f4a', '#c46a7d', '#2f4f4a', '#5d8580', '#a8c4bd',
];

/** Draws 2-4 distinct colours at random. Never returns an empty list. */
export function randomInkPalette(rng: Rng, size?: number): string[] {
  const pool = [...INK_COLOR_RANGE];
  const count = Math.max(1, size ?? rng.int(2, 4));
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]!);
  }
  return picked;
}

export interface RecipeOptions {
  seed: number;
  canvas?: CanvasSpec;
  palette?: string[];
  tools?: readonly InkToolId[];
  blotCount?: number;
  wetness?: number;
  bleed?: number;
  folds?: Fold[] | 'auto';
  grain?: number;
}

/** 0.15 / 0.40 / 0.32 / 0.13 split over fold counts, chosen per seed. */
export function foldPlan(rng: Rng): Fold[] {
  const roll = rng.next();
  const count = roll < 0.15 ? 0 : roll < 0.55 ? 1 : roll < 0.87 ? 2 : 3;
  const folds: Fold[] = [];
  for (let i = 0; i < count; i++) {
    const axis = rng.bool(0.5) ? 'vertical' : 'horizontal';
    const direction = axis === 'vertical'
      ? (rng.bool(0.5) ? 'left' : 'right')
      : (rng.bool(0.5) ? 'top' : 'bottom');
    // mostly a clean centre crease, sometimes an off-centre one
    const at = rng.bool(0.7) ? 0.5 : round(rng.range(0.36, 0.64), 3);
    folds.push({ axis, direction, at });
  }
  return folds;
}

function spot(rng: Rng, marginX: number, marginY: number): UV {
  return {
    x: round(clamp(rng.range(marginX, 1 - marginX), 0.02, 0.98), 4),
    y: round(clamp(rng.range(marginY, 1 - marginY), 0.02, 0.98), 4),
  };
}

function pathPoints(tool: InkToolId, rng: Rng, marginX: number, marginY: number): UV[] {
  const start = spot(rng, marginX, marginY);
  switch (tool) {
    case 'streak': {
      const angle = rng.range(0, Math.PI * 2);
      const length = rng.range(0.18, 0.5);
      return [start, {
        x: round(clamp(start.x + Math.cos(angle) * length, 0.02, 0.98), 4),
        y: round(clamp(start.y + Math.sin(angle) * length, 0.02, 0.98), 4),
      }];
    }
    case 'drag': {
      const angle = rng.range(0, Math.PI * 2);
      const length = rng.range(0.08, 0.28);
      return [start, {
        x: round(clamp(start.x + Math.cos(angle) * length, 0.02, 0.98), 4),
        y: round(clamp(start.y + Math.sin(angle) * length, 0.02, 0.98), 4),
      }];
    }
    case 'curve': {
      const points: UV[] = [start];
      const segments = rng.int(2, 4);
      let angle = rng.range(0, Math.PI * 2);
      let cursor = { ...start };
      for (let i = 0; i < segments; i++) {
        angle += rng.range(-0.9, 0.9);
        const step = rng.range(0.06, 0.18);
        cursor = {
          x: round(clamp(cursor.x + Math.cos(angle) * step, 0.02, 0.98), 4),
          y: round(clamp(cursor.y + Math.sin(angle) * step, 0.02, 0.98), 4),
        };
        points.push(cursor);
      }
      return points;
    }
    default:
      return [start];
  }
}

const WIDTH_BY_TOOL: Record<InkToolId, [number, number]> = {
  drop: [0.03, 0.09],
  splatter: [0.03, 0.07],
  streak: [0.012, 0.035],
  curve: [0.008, 0.03],
  pool: [0.06, 0.14],
  drag: [0.02, 0.05],
  spray: [0.15, 0.35],
  backrun: [0.02, 0.06],
};

/** The deterministic op log a recipe replays. Pure: same recipe, same ops. */
export function renderOps(recipe: InkRecipe): InkOp[] {
  const rng = createRng(recipe.seed ^ 0x85ebca6b);
  const tools = recipe.tools.length > 0 ? recipe.tools : INK_TOOLS;
  const palette = recipe.palette.length > 0 ? recipe.palette : INK_PALETTES.ink!;
  const ops: InkOp[] = [];
  let previousColor = palette[0]!;
  for (let i = 0; i < Math.max(1, recipe.blotCount); i++) {
    const tool = rng.pick(tools);
    const [minWidth, maxWidth] = WIDTH_BY_TOOL[tool] ?? [0.02, 0.06];
    // 65% chance to stay on the previous colour: cohesion over confetti
    const color = rng.bool(0.65) ? previousColor : rng.pick(palette);
    previousColor = color;
    ops.push({
      tool,
      points: pathPoints(tool, rng, 0.14, 0.12),
      width: round(rng.range(minWidth, maxWidth), 4),
      color,
      alpha: round(rng.range(0.5, 0.9), 3),
      wetness: round(clamp01(recipe.wetness + rng.range(-0.22, 0.22)), 3),
      seed: rng.seed32(),
    });
  }
  return ops;
}

/** Builds a reproducible recipe for a seed. */
export function inkRecipeFromSeed(options: RecipeOptions): InkRecipe {
  const rng = createRng((options.seed || 1) ^ 0x27d4eb2f);
  const tools = options.tools && options.tools.length > 0 ? [...options.tools] : [...INK_TOOLS];
  return {
    version: 1,
    seed: options.seed >>> 0,
    canvas: options.canvas ?? canvasForAspect('16:9'),
    palette: options.palette && options.palette.length > 0 ? [...options.palette] : randomInkPalette(rng.fork()),
    tools,
    blotCount: options.blotCount ?? rng.int(3, 7),
    wetness: round(clamp01(options.wetness ?? rng.range(0.25, 0.8)), 3),
    bleed: round(clamp01(options.bleed ?? rng.range(0.05, 0.45)), 3),
    folds: options.folds === 'auto' || options.folds === undefined ? foldPlan(rng) : [...options.folds],
    grain: round(clamp01(options.grain ?? rng.range(0.05, 0.35)), 3),
  };
}

/** A stable identity for a recipe, used to cache vision calls and shares. */
export function recipeKey(recipe: InkRecipe): string {
  return [
    recipe.seed,
    recipe.canvas.width,
    recipe.canvas.height,
    recipe.palette.join(','),
    recipe.tools.join(','),
    recipe.blotCount,
    recipe.wetness,
    recipe.bleed,
    recipe.folds.map((f) => `${f.axis[0]}${f.direction[0]}${f.at ?? 0.5}`).join('|'),
    recipe.grain,
  ].join('~');
}

export function defaultInkRecipe(): InkRecipe {
  return inkRecipeFromSeed({
    seed: 20260908,
    canvas: canvasForAspect('16:9'),
    blotCount: 5,
    wetness: 0.55,
    bleed: 0.25,
    folds: 'auto',
    grain: 0.2,
  });
}
