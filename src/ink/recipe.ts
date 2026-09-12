import { MAX_OP_WIDTH, MIN_INK_COVERAGE, fitToInkFloor, inkCoverage, formScaleFor, inkTargetFor } from './coverage';
import { blotForm, type FormDomain, type FormRole } from './form';
import { creaseAt, foldGeometry } from './fold-math';
import { createRng, clamp, clamp01, round, type Rng } from './rng';
import {
  INK_TOOLS,
  canvasForAspect,
  type CanvasSpec,
  type Fold,
  type InkOp,
  type InkRecipe,
  type InkToolId,
} from './types';

export { MAX_INK_COVERAGE, MIN_INK_COVERAGE, formScaleFor, inkCoverage, inkTargetFor } from './coverage';
export { CARRIER_TOOLS, MIN_OP_WIDTH } from './form';
export { BLOT_FORM_KINDS, type BlotFormKind } from './form';

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
 * The pigment range the engine invents from, and it is light pigments only.
 *
 * Every blot is folded, and a fold prints the flap back over the sheet with
 * `multiply` - so past the first crease the ink is multiplied into itself and a
 * pigment that started dark has nowhere left to go. The same multiply is what
 * deepens a pool, a drag and a strand of the body where they overlap, so the
 * tone the engine has to *choose* is a light one and the darkening is left to
 * the paper. Read a colour here as the lightest a blot will ever be, not the
 * darkest: a light slate lands as a pale wash on white, and the overlaps, the
 * creases and the grain walk it down to an ink worth looking at.
 *
 * The reason the range is not merely biased light: the body of a blot always
 * carries the *deepest* pigment of its own palette, so a pool holding near-black
 * puts near-black under every blot's centre of gravity. The old range held 25 of
 * its 37 colours below mid-tone (`#0f0f12`, `#141821`, `#101a3a`, ...) and most
 * generations came out blackish. `recipe.test.ts` now floors every pigment here
 * at mid-tone, so a dark one cannot quietly come back.
 *
 * The studio no longer lets a palette be chosen by hand either way: every blot
 * draws its own colours from here, so a film wanders through the whole range
 * instead of sitting in one family.
 */
export const INK_COLOR_RANGE: readonly string[] = [
  // cool slate: the ink family, light enough that a folded pair still reads grey
  '#8a97a8', '#a3aebd', '#c0c9d6', '#9fb2c2',
  // sepia and earth
  '#a5876a', '#c0a487', '#d9c4ab',
  // ochre and gold
  '#c9a154', '#dbbd7d', '#ecd8ad',
  // indigo
  '#7f92c6', '#9cacd8', '#bcc8ea',
  // violet
  '#a294d0', '#b9aede', '#d3cdec',
  // ember
  '#d4876a', '#e5a887', '#f2c7ad', '#d9a071',
  // verdigris
  '#7bb6a2', '#9bcbb8', '#c0ded1',
  // rose
  '#d193a6', '#e2b2c0', '#f1ced6',
  // neutral greys
  '#9a9aa3', '#b4b4bc', '#cdcdd4',
  // the pale sage, the one colour of the old range that was already light
  '#a8c4bd',
];

/**
 * How many pigments this blot's palette holds.
 *
 * The engine used to draw two to four every time, and a blot made of four
 * pigments drawn out of a range that wanders across the whole spectrum has no
 * centre of gravity. The count is now rolled as its own decision, and the roll
 * reaches down to a single pigment, which is what a sumi-e blot is: one ink and
 * every tone in the picture coming out of how wet it was.
 */
export function rollPaletteSize(rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.12) return 1;
  if (roll < 0.42) return 2;
  if (roll < 0.78) return 3;
  if (roll < 0.94) return 4;
  return 5;
}

/**
 * Draws `size` distinct colours at random (2-4 unless asked for more). Never
 * returns an empty list.
 */
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

/**
 * Ceiling on how many creases one blot can take.
 *
 * Folds compose: every extra crease mirrors the result of the last one, so the
 * symmetry multiplies while the ink reading stays legible. Past seven the blot
 * turns into texture rather than a shape with a mirrored twin.
 */
export const MAX_FOLDS = 7;

/**
 * The most marks one blot is made of.
 *
 * Past seven the marks crowd into one another and the page reads as texture
 * rather than as a form somebody made. This is a ceiling, not the count:
 * `rollBlotCount` decides how many of them a given blot gets, and the form
 * spends every one of them - a lone body, or a body with four limbs and ink
 * pooled along them. The rail also replays a blot one mark at a time, so this
 * is what paces that show.
 */
export const BLOT_MARKS = 7;

/** The fewest marks a blot is made of: one drop is still a blot. */
export const MIN_BLOT_MARKS = 1;

/**
 * How many marks this blot is made of, drawn at random across 1..BLOT_MARKS.
 *
 * Every invented blot used to be seven marks, and a rail of seven-mark blots
 * reads as one blot reprinted: the sheet never got to be a single body, or a
 * pair, or a page that is mostly paper. The roll is even over the range, so a
 * batch holds a lone drop next to a crowded sheet, and every count between.
 */
export function rollBlotCount(rng: Rng): number {
  return rng.int(MIN_BLOT_MARKS, BLOT_MARKS);
}

/**
 * Weight per fold count, index = count, 0..MAX_FOLDS.
 *
 * The first four counts keep the original 0.15 / 0.40 / 0.32 / 0.13 shape, so a
 * barely folded blot still dominates; the remaining 0.13 spreads thin over
 * 4..7 because an over-folded blot should be an event, not the norm.
 */
const FOLD_COUNT_WEIGHTS = [0.15, 0.34, 0.26, 0.12, 0.07, 0.035, 0.018, 0.007];

/** A plan of 0..MAX_FOLDS creases, chosen per seed. */
export function foldPlan(rng: Rng): Fold[] {
  const roll = rng.next();
  let count = MAX_FOLDS;
  let cumulative = 0;
  for (let i = 0; i < FOLD_COUNT_WEIGHTS.length; i++) {
    cumulative += FOLD_COUNT_WEIGHTS[i]!;
    if (roll < cumulative) {
      count = i;
      break;
    }
  }
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

/**
 * Tools the automatic engine no longer reaches for.
 *
 * A splatter throws a ring of droplets clear of its own blob, so on the sheet it
 * reads as damage rather than as ink: it breaks the mark's edge into specks and
 * leaves the page looking torn. The paper still knows how to draw it - a stored
 * or shared recipe, and the hand-painted route, may both ask for it - but
 * nothing the engine invents does. Note that `MIN_INK_COVERAGE`'s estimator
 * still carries its fraction, because the renderer still draws it for those
 * callers.
 */
export const DISABLED_TOOLS: readonly InkToolId[] = ['splatter'];

/** The vocabulary the engine invents with: every tool it has not retired. */
export const ENABLED_TOOLS: readonly InkToolId[] = INK_TOOLS.filter((tool) => !DISABLED_TOOLS.includes(tool));

/** Fraction of the range a mark takes from the body of the blot outwards. */
type RoleRamp = Record<FormRole, number>;

/**
 * Where on the ramp this blot's limbs and knots sit.
 *
 * The ramp's ends are fixed - the body always carries the deepest pigment, and
 * the texture is that same pigment thrown back over the mass - but how far down
 * the scale a limb lands is a property of the blot. A blot whose limbs sit at
 * 0.2 into a five-pigment ramp is a near-monochrome sheet with a dark heart; one
 * whose limbs run to 0.85 is a pale, washed page with one black knot in it. Two
 * such pages out of the same palette are not the same picture, which is exactly
 * what a fixed 0.55 could not say.
 */
function roleRamp(rng: Rng): RoleRamp {
  const node = rng.range(0.12, 0.42);
  return {
    core: 0,
    node,
    limb: rng.range(Math.min(0.9, node + 0.1), 0.95),
    texture: 0,
  };
}

/**
 * How light a pigment is, 0 (black) to 1 (white).
 *
 * Not the mean of its channels: the eye sees green far more strongly than blue,
 * so a flat mean reads a deep indigo as pale as mid-grey and the ramp would put
 * the wrong pigment at the bottom of a blot.
 */
function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((char) => char + char).join('') : clean;
  const channel = (offset: number): number => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return Number.isFinite(value) ? (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) : 0;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * The recipe's palette, darkest first.
 *
 * One pigment per mark was the old rule and it is why a blot read as confetti:
 * seven marks drew seven unrelated colours out of a range that wanders across
 * the whole spectrum, so a page had no centre of gravity. A blot is read from
 * its body outwards instead - the deepest pigment pools where the brush landed
 * and everything walking away from it gets paler - which is what an inkblot
 * looks like however many pigments were on the palette.
 */
function pigmentRamp(palette: readonly string[]): string[] {
  return [...palette].sort((a, b) => luminance(a) - luminance(b));
}

/** The pigment one part of a blot takes from the ramp. */
function pigmentFor(ramp: readonly string[], role: FormRole, stops: RoleRamp): string {
  return ramp[Math.round(stops[role] * (ramp.length - 1))] ?? ramp[0]!;
}

/**
 * The part of the sheet the ink may occupy.
 *
 * A single crease near the middle is what makes a blot read as a Rorschach: the
 * moving flap is printed onto the far half, so ink painted on the flap alone
 * comes back as a mirrored pair. Ink painted on both halves is simply doubled
 * over there, which is why a blot of marks thrown anywhere used to arrive muddy
 * over its own mirror image. A second crease divides the flap again and there
 * is no longer room on it for a blot at the ink floor, so this applies to a
 * plan of exactly one centre crease and to no other.
 */
function inkDomain(recipe: InkRecipe): FormDomain | undefined {
  const [fold, ...rest] = recipe.folds;
  if (!fold || rest.length > 0) return undefined;
  if (Math.abs(creaseAt(fold) - 0.5) > 0.08) return undefined;
  return foldGeometry(fold).source;
}

/** The deterministic op log a recipe replays. Pure: same recipe, same ops. */
export function renderOps(recipe: InkRecipe): InkOp[] {
  const rng = createRng(recipe.seed ^ 0x85ebca6b);
  const tools = recipe.tools.length > 0 ? recipe.tools : ENABLED_TOOLS;
  const palette = recipe.palette.length > 0 ? recipe.palette : INK_PALETTES.ink!;
  // How many marks there are is the recipe's business (`rollBlotCount` at
  // invent time), and a recipe that asks for more than the ceiling (a stored
  // one, a shared one) is trimmed here, where the marks are drawn, not trusted.
  const count = Math.min(BLOT_MARKS, Math.max(MIN_BLOT_MARKS, Math.round(recipe.blotCount)));
  // How much paper this blot is going to take is decided before it is composed,
  // and the form is drawn at that scale: the size is a property of the
  // composition rather than something applied to it afterwards, so growing a
  // blot to the floor cannot flatten the figure it was drawn as. Both draws come
  // from seeds of their own, so neither disturbs the form's own randomness.
  const target = inkTargetFor(createRng(recipe.seed ^ 0x2545f491));
  const form = blotForm(rng, {
    marks: count,
    tools,
    spec: recipe.canvas,
    wetness: recipe.wetness,
    domain: inkDomain(recipe),
    scale: formScaleFor(target),
  });
  const ramp = pigmentRamp(palette);
  // the tone the blot is drawn in, and how much paper it means to take, are both
  // its own draws - from seeds of their own, so neither disturbs the form's own
  // stream of randomness
  const stops = roleRamp(createRng(recipe.seed ^ 0x9e3779b9));
  const ops: InkOp[] = form.marks.map((mark) => ({
    tool: mark.tool,
    points: mark.points,
    width: mark.width,
    color: pigmentFor(ramp, mark.role, stops),
    alpha: mark.alpha,
    wetness: mark.wetness,
    rampTo: mark.rampTo,
    seed: mark.seed,
  }));
  // and finally: a blot is a mark on a sheet, never a speck in an empty field -
  // grown by its own share of the paper rather than to every blot's floor, and
  // walked outwards while walking is what adds the paper, so the composition it
  // was drawn as survives the growing
  return fitToInkFloor(ops, recipe.canvas, target);
}

/** Builds a reproducible recipe for a seed. */
export function inkRecipeFromSeed(options: RecipeOptions): InkRecipe {
  const rng = createRng((options.seed || 1) ^ 0x27d4eb2f);
  // a retired tool is dropped at the door: a mood, a stored recipe or a share
  // link may still name it, and none of them may put it back on a fresh sheet
  const kept = (options.tools && options.tools.length > 0 ? options.tools : INK_TOOLS)
    .filter((tool) => !DISABLED_TOOLS.includes(tool));
  const tools = kept.length > 0 ? [...kept] : [...ENABLED_TOOLS];
  return {
    version: 1,
    seed: options.seed >>> 0,
    canvas: options.canvas ?? canvasForAspect('16:9'),
    // a blot is one or two pigments walked from its body outwards, so its
    // palette is the range it may draw on, not one colour per mark
    palette: options.palette && options.palette.length > 0
      ? [...options.palette]
      : randomInkPalette(rng.fork(), rollPaletteSize(rng)),
    tools,
    blotCount: options.blotCount ?? rollBlotCount(rng),
    // how wet the sheet was when it was painted: a dry blot is a hard-edged
    // shape, a wet one creeps and blots, and the roll reaches both ends now so a
    // batch holds both rather than a row of middling blots
    wetness: round(clamp01(options.wetness ?? rng.range(0.12, 0.92)), 3),
    bleed: round(clamp01(options.bleed ?? rng.range(0.02, 0.6)), 3),
    folds: options.folds === 'auto' || options.folds === undefined ? foldPlan(rng) : [...options.folds],
    grain: round(clamp01(options.grain ?? rng.range(0.02, 0.42)), 3),
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
    blotCount: BLOT_MARKS,
    wetness: 0.55,
    bleed: 0.25,
    folds: 'auto',
    grain: 0.2,
  });
}
