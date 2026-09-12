import { describe, it, expect } from 'vitest';
import {
  BLOT_MARKS,
  DISABLED_TOOLS,
  ENABLED_TOOLS,
  INK_COLOR_RANGE,
  INK_PALETTES,
  MAX_FOLDS,
  MIN_BLOT_MARKS,
  foldPlan,
  inkRecipeFromSeed,
  randomInkPalette,
  recipeKey,
  renderOps,
  defaultInkRecipe,
} from './recipe';
import { createRng } from './rng';
import { canvasForAspect, INK_TOOLS } from './types';
import { MAX_OP_WIDTH, MIN_INK_COVERAGE, inkComponents, inkCoverage, inkMask } from './coverage';
import { CARRIER_TOOLS, MIN_OP_WIDTH } from './recipe';
import { MOODS } from '../presets/moods';

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
  it('always produces a valid plan of 0-MAX_FOLDS folds', () => {
    for (let seed = 0; seed < 600; seed++) {
      const folds = foldPlan(createRng(seed));
      expect(folds.length).toBeGreaterThanOrEqual(0);
      expect(folds.length).toBeLessThanOrEqual(MAX_FOLDS);
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
    const counts = new Array<number>(MAX_FOLDS + 1).fill(0);
    for (let seed = 0; seed < 4000; seed++) {
      counts[foldPlan(createRng(seed)).length]!++;
    }
    expect(counts[0]).toBeGreaterThan(200);   // a decent share stay unsymmetric
    expect(counts[1]).toBeGreaterThan(counts[2]);
    // the tail is reachable but stays thinner than the low counts, all the way out
    for (let count = 4; count <= MAX_FOLDS; count++) {
      expect(counts[count]).toBeGreaterThan(0);
      expect(counts[count]).toBeLessThan(counts[count - 1]!);
    }
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
    expect(automatic.folds.length).toBeLessThanOrEqual(MAX_FOLDS);
    const explicit = inkRecipeFromSeed({ seed: 3, folds: [{ axis: 'vertical', direction: 'left', at: 0.5 }] });
    expect(explicit.folds).toEqual([{ axis: 'vertical', direction: 'left', at: 0.5 }]);
  });

  it("falls back to the engine's own vocabulary rather than an empty one", () => {
    const recipe = inkRecipeFromSeed({ seed: 1, tools: [] });
    expect(recipe.tools).toEqual([...ENABLED_TOOLS]);
  });

  it('draws its own random colours when no palette is given', () => {
    const recipe = inkRecipeFromSeed({ seed: 11 });
    // how many pigments a blot draws is rolled per blot and reaches down to one,
    // which is what a monochrome blot is - so the floor here is a single colour,
    // not the two-to-four the engine used to draw every time
    expect(recipe.palette.length).toBeGreaterThanOrEqual(1);
    const sizes = new Set(
      Array.from({ length: 120 }, (_, index) => inkRecipeFromSeed({ seed: 2000 + index }).palette.length),
    );
    expect([...sizes].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(recipe.palette.every((color) => INK_COLOR_RANGE.includes(color))).toBe(true);
    // same seed, same colours
    expect(recipe.palette).toEqual(inkRecipeFromSeed({ seed: 11 }).palette);
    // different seeds wander through the range instead of sitting in one family
    const palettes = new Set(
      Array.from({ length: 20 }, (_, index) => inkRecipeFromSeed({ seed: 100 + index }).palette.join(',')),
    );
    expect(palettes.size).toBeGreaterThan(5);
  });
});

describe('the pigment range the engine invents from', () => {
  it('holds light pigments only, because every crease darkens what it prints', () => {
    // A blot is multiplied into itself by every crease past the first, and the
    // body always carries the deepest pigment of its palette - so a dark colour
    // anywhere in this range puts a black core under a whole share of the film.
    // The floor is the rule; the exact value is what "light" means in practice.
    for (const pigment of INK_COLOR_RANGE) {
      expect(lightness(pigment)).toBeGreaterThanOrEqual(0.24);
    }
    // and nothing else can put one back on a sheet: the engine's own draw, over
    // every palette size and mood, stays inside the range
    for (let seed = 0; seed < 200; seed++) {
      const recipe = inkRecipeFromSeed({ seed, folds: 'auto' });
      expect(recipe.palette.length).toBeGreaterThan(0);
      for (const pigment of recipe.palette) expect(INK_COLOR_RANGE).toContain(pigment);
    }
  });
});

describe('randomInkPalette', () => {
  it('returns distinct colours drawn from the pigment range', () => {
    for (let seed = 0; seed < 60; seed++) {
      const palette = randomInkPalette(createRng(seed));
      expect(palette.length).toBeGreaterThanOrEqual(2);
      expect(palette.length).toBeLessThanOrEqual(4);
      expect(new Set(palette).size).toBe(palette.length);
      expect(palette.every((color) => INK_COLOR_RANGE.includes(color))).toBe(true);
    }
  });
});

describe('renderOps', () => {
  it('is deterministic: a recipe replays to the same op log', () => {
    const recipe = base();
    expect(renderOps(recipe)).toEqual(renderOps(recipe));
  });

  it('rolls its own mark count between one and the ceiling', () => {
    const counts = new Set<number>();
    for (let seed = 0; seed < 240; seed++) {
      const ops = renderOps(inkRecipeFromSeed({ seed }));
      expect(ops.length).toBeGreaterThanOrEqual(MIN_BLOT_MARKS);
      expect(ops.length).toBeLessThanOrEqual(BLOT_MARKS);
      counts.add(ops.length);
    }
    // every count in the range turns up: seven on every sheet was the complaint
    expect(counts.size).toBe(BLOT_MARKS);
    // a stored or shared recipe cannot put a dozen back on the sheet
    expect(renderOps(inkRecipeFromSeed({ seed: 8, blotCount: 11 }))).toHaveLength(BLOT_MARKS);
    // ...and a recipe that deliberately asks for fewer keeps its own count
    expect(renderOps(base())).toHaveLength(5);
  });

  it('never reaches for a tool the engine has retired', () => {
    for (let seed = 0; seed < 120; seed++) {
      const recipe = inkRecipeFromSeed({ seed, tools: [...INK_TOOLS], folds: 'auto' });
      expect(recipe.tools).not.toContain('splatter');
      for (const op of renderOps(recipe)) expect(op.tool).not.toBe('splatter');
    }
    // a recipe that names only retired tools still comes back with a vocabulary
    const retired = inkRecipeFromSeed({ seed: 4, tools: [...DISABLED_TOOLS] });
    expect(retired.tools).toEqual([...ENABLED_TOOLS]);
    for (const op of renderOps(retired)) expect(op.tool).not.toBe('splatter');
  });

  it('leans on pool, and keeps drag to one or two marks', () => {
    let pool = 0;
    let marks = 0;
    for (let seed = 0; seed < 300; seed++) {
      // the full vocabulary, so nothing but the mix itself is being measured
      const ops = renderOps(inkRecipeFromSeed({ seed, tools: [...INK_TOOLS], blotCount: BLOT_MARKS }));
      marks += ops.length;
      pool += ops.filter((op) => op.tool === 'pool').length;
      expect(ops.filter((op) => op.tool === 'drag').length).toBeLessThanOrEqual(2);
    }
    // pool is the blot's body: it takes a clear share of every mark drawn
    expect(pool / marks).toBeGreaterThan(0.25);
  });

  it('walks its palette from the body outwards instead of one dip per mark', () => {
    for (let seed = 0; seed < 200; seed++) {
      const recipe = inkRecipeFromSeed({ seed, folds: 'auto' });
      const ops = renderOps(recipe);
      expect(ops.every((op) => recipe.palette.includes(op.color))).toBe(true);
      // the body carries the deepest pigment on the sheet...
      const darkest = ops[0]!.color;
      for (const op of ops) expect(lightness(op.color)).toBeGreaterThanOrEqual(lightness(darkest) - 0.002);
      // ...and a page is a handful of pigments walked from it, not seven
      // unrelated dips that arrive as confetti
      expect(new Set(ops.map((op) => op.color)).size).toBeLessThanOrEqual(3);
      // a palette shorter than the ramp is still all a mark may draw on
      const twoTone = renderOps(inkRecipeFromSeed({ seed, palette: ['#101010', '#f0f0f0'], folds: 'auto' }));
      expect(new Set(twoTone.map((op) => op.color)).size).toBeLessThanOrEqual(2);
      expect(twoTone[0]!.color).toBe('#101010');
    }
  });

  it('lays every blot down as one connected mass rather than a scatter', () => {
    // The complaint this replaces: a batch read as five or seven separate soft
    // blobs sharing a page. A blot is one piece of ink - a body with limbs
    // growing out of it - and that is a property of the op log, so it is
    // measured on the same grid the ink floor is measured on.
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const canvas = canvasForAspect(aspect);
      for (let seed = 0; seed < 120; seed++) {
        const recipe = inkRecipeFromSeed({ seed: seed * 7919 + 13, canvas, folds: 'auto' });
        expect(inkComponents(renderOps(recipe), canvas)).toBe(1);
      }
    }
    // ...and it is a form rather than one mark laid on top of itself. A one-mark
    // blot and a body with its texture on it are one point on the sheet by
    // definition, so what has to reach across the page is a blot made of three
    // marks or more - which is nearly all of them.
    const spans: number[] = [];
    for (let seed = 0; seed < 300; seed++) {
      const ops = renderOps(inkRecipeFromSeed({ seed: seed * 31 + 7, folds: 'auto' }));
      if (ops.length < 3) continue;
      const points = ops.flatMap((op) => op.points);
      let span = 0;
      for (const a of points) {
        for (const b of points) span = Math.max(span, Math.hypot(a.x - b.x, a.y - b.y));
      }
      spans.push(span);
    }
    spans.sort((a, b) => a - b);
    expect(spans[Math.floor(0.1 * spans.length)]!).toBeGreaterThan(0.1);
    expect(spans.filter((span) => span <= 0.05).length).toBeLessThanOrEqual(6);
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

/** The same weighting the recipe ramps a palette with, so the test reads a page
 * the way the engine ordered it. */
function lightness(hex: string): number {
  const clean = hex.replace('#', '');
  const channel = (offset: number): number => {
    const value = parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

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

describe('how big a blot is', () => {
  const toolSets = [[...INK_TOOLS], ...Object.values(MOODS).map((mood) => [...mood.tools])];

  it('grows every blot past the ink floor, whatever the mood and the frame', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      for (const tools of toolSets) {
        for (let i = 0; i < 25; i++) {
          const recipe = inkRecipeFromSeed({
            seed: 1000 + i * 7919,
            canvas: canvasForAspect(aspect),
            tools: [...tools],
            folds: 'auto',
          });
          expect(inkCoverage(renderOps(recipe), recipe.canvas)).toBeGreaterThanOrEqual(MIN_INK_COVERAGE);
        }
      }
    }
  });

  it('opens every blot with a mark that can carry it', () => {
    // a spray of dots and a backrun on their own wet nothing worth seeing, so a
    // mark that wets a wide area is always in the log, and the blot starts with it
    for (let seed = 0; seed < 150; seed++) {
      const ops = renderOps(inkRecipeFromSeed({ seed, tools: ['spray', 'backrun'], blotCount: 1 }));
      expect(CARRIER_TOOLS).toContain(ops[0]!.tool);
    }
  });

  it('never makes a mark narrower than the floor on marks', () => {
    for (let seed = 0; seed < 150; seed++) {
      for (const op of renderOps(inkRecipeFromSeed({ seed, folds: 'auto' }))) {
        expect(op.width).toBeGreaterThanOrEqual(MIN_OP_WIDTH);
      }
    }
  });
});

describe('how alike two blots are', () => {
  /**
   * A fingerprint of what a blot is, from its op log alone: which tools it used,
   * how many marks, how fat they are, and where on the sheet it sits.
   */
  const fingerprint = (ops: ReturnType<typeof renderOps>): number[] => {
    const meanWidth = ops.reduce((sum, op) => sum + op.width, 0) / ops.length / MAX_OP_WIDTH;
    const cx = ops.reduce((sum, op) => sum + op.points[0]!.x, 0) / ops.length;
    const cy = ops.reduce((sum, op) => sum + op.points[0]!.y, 0) / ops.length;
    const channels = ops
      .map((op) => channelMeans(op.color))
      .reduce((acc, rgb) => [acc[0]! + rgb[0], acc[1]! + rgb[1], acc[2]! + rgb[2]], [0, 0, 0]);
    // How many marks the blot is made of separates two pages now that the count
    // is rolled per blot; what else does is which tools wet the sheet, how fat
    // the marks are, where they sit - and, each mark carrying its own pigment,
    // the colour itself.
    return [
      ops.length / BLOT_MARKS,
      ...INK_TOOLS.map((tool) => ops.filter((op) => op.tool === tool).length / ops.length),
      meanWidth,
      cx,
      cy,
      ...channels.map((sum) => sum! / ops.length),
    ];
  };

  /** The mean of a mark's colour, 0..1 per channel, so a pigment is a number. */
  const channelMeans = (hex: string): number[] => {
    const clean = hex.replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((char) => char + char).join('') : clean;
    return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255);
  };

  /**
   * Where each mark of a page sits, sorted, as one flat vector.
   *
   * A mark's *middle*, not its first point: every limb of a blot is now drawn
   * growing out of the body, so the first control point of four marks on one
   * page is the same point four times and a layout read from it would call two
   * different blots identical.
   */
  const layout = (ops: ReturnType<typeof renderOps>): number[] =>
    [...ops.map((op) => {
      const x = op.points.reduce((sum, point) => sum + point.x, 0) / op.points.length;
      const y = op.points.reduce((sum, point) => sum + point.y, 0) / op.points.length;
      return [x, y] as [number, number];
    })]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .flat();

  const distance = (a: number[], b: number[]): number =>
    a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;

  /**
   * Two layouts lined up. Blots no longer hold the same number of marks, so the
   * shorter page is padded with bare paper (the middle of the sheet is not where
   * a missing mark is, and 0.5 keeps the comparison honest about the gap).
   */
  const aligned = (a: number[], b: number[]): [number[], number[]] => {
    const length = Math.max(a.length, b.length);
    const pad = (values: number[]): number[] => [...values, ...Array(length - values.length).fill(0.5)];
    return [pad(a), pad(b)];
  };

  it('makes a different page every time', () => {
    const canvas = canvasForAspect('16:9');
    const moodIds = Object.keys(MOODS) as Array<keyof typeof MOODS>;
    const runs = 60;
    const perRun = 8;
    const distances: number[] = [];
    const spreads: number[] = [];
    const layouts = new Set<string>();
    const quadrants = new Set<string>();
    const prints = new Set<string>();
    const roots = new Set<string>();

    for (let run = 0; run < runs; run++) {
      const mood = MOODS[moodIds[run % moodIds.length]!]!;
      const runOps: Array<ReturnType<typeof renderOps>> = [];
      for (let i = 0; i < perRun; i++) {
        const recipe = inkRecipeFromSeed({
          seed: (run * 104729 + i * 7919 + 11) % 0xffffffff,
          canvas,
          tools: [...mood.tools],
          folds: 'auto',
        });
        const ops = renderOps(recipe);
        runOps.push(ops);
        layouts.add(layout(ops).map((value) => value.toFixed(2)).join(','));
        // where the form was planted: a connected mass moves as one piece, so
        // two blots whose bodies sit in the same place are the same page
        roots.add(`${ops[0]!.points[0]!.x.toFixed(3)},${ops[0]!.points[0]!.y.toFixed(3)}`);
        const cx = ops.reduce((sum, op) => sum + op.points[0]!.x, 0) / ops.length;
        const cy = ops.reduce((sum, op) => sum + op.points[0]!.y, 0) / ops.length;
        quadrants.add(`${cx < 0.5 ? 'L' : 'R'}${cy < 0.5 ? 'T' : 'B'}`);
        // Two blots are the same page if every mark of one lands where a mark
        // of the other did, at the same size. Counting tools and marks stopped
        // separating pages once every blot became a body with limbs on it and
        // the mood decided the tools - the layout is what differs now.
        prints.add([
          ops.length,
          ops.map((op) => `${op.tool}@${op.width.toFixed(3)}:${op.points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('>')}`).join('|'),
        ].join('#'));
      }
      for (let i = 0; i < perRun; i++) {
        for (let j = i + 1; j < perRun; j++) {
          distances.push(distance(fingerprint(runOps[i]!), fingerprint(runOps[j]!)));
          const [pageA, pageB] = aligned(layout(runOps[i]!), layout(runOps[j]!));
          spreads.push(distance(pageA, pageB));
        }
      }
    }

    distances.sort((a, b) => a - b);
    spreads.sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)]!;
    const medianSpread = spreads[Math.floor(spreads.length / 2)]!;
    // a rail of blots that read as one blot printed again is the failure this
    // guards: the layout is the difference that has to carry the most weight,
    // and the fingerprint backs it up
    // A connected form moves as one piece, so two pages no longer separate as
    // widely as a scatter of independent marks did - that is what makes a blot
    // a blot. What has to hold is that no two pages put their marks in the same
    // places (below), and that the median pair is not the same page twice.
    expect(medianSpread).toBeGreaterThan(0.06);
    expect(median).toBeGreaterThan(0.1);
    // the ink is not stuck in one corner, and no two pages are laid out alike
    expect([...quadrants].sort()).toEqual(['LB', 'LT', 'RB', 'RT']);
    expect(layouts.size).toBeGreaterThan(0.95 * runs * perRun);
    expect(prints.size).toBeGreaterThan(0.7 * runs * perRun);
    expect(roots.size).toBeGreaterThan(0.95 * runs * perRun);
  });

  it('gives a good share of its blots limbs that leave the body', () => {
    // The failure this guards: every blot grown to the floor by fattening its
    // marks, so the body swallows the log and a batch is a batch of boulders
    // with the limbs inside them. How far the ink reaches from its own bulk, in
    // units of the radius of a disc of the same area, is what a critic reads as
    // "a body with arms on it" - a ball is about 1.3, a figure with limbs 2 and
    // up - and it is measured on the same grid the floor is measured on.
    const canvas = canvasForAspect('16:9');
    const moodIds = Object.keys(MOODS) as Array<keyof typeof MOODS>;
    const ratios: number[] = [];
    for (let i = 0; i < 300; i++) {
      const mood = MOODS[moodIds[i % moodIds.length]!]!;
      const recipe = inkRecipeFromSeed({ seed: 5000 + i * 7919, canvas, tools: [...mood.tools], folds: 'auto' });
      const ops = renderOps(recipe);
      const mask = inkMask(ops, canvas);
      let wet = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          if (!mask[y * 64 + x]) continue;
          wet++;
          sx += x / 64;
          sy += y / 64;
        }
      }
      let far = 0;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          if (mask[y * 64 + x]) far = Math.max(far, Math.hypot(x / 64 - sx / wet, y / 64 - sy / wet));
        }
      }
      ratios.push(far / Math.sqrt(wet / (64 * 64) / Math.PI));
    }
    ratios.sort((a, b) => a - b);
    expect(ratios[Math.floor(0.5 * ratios.length)]!).toBeGreaterThan(1.45);
    expect(ratios.filter((ratio) => ratio > 1.8).length).toBeGreaterThan(0.25 * ratios.length);
  });

  it('spreads its size across the frame rather than hovering at the floor', () => {
    const canvas = canvasForAspect('16:9');
    const moodIds = Object.keys(MOODS) as Array<keyof typeof MOODS>;
    const coverages: number[] = [];
    for (let i = 0; i < 300; i++) {
      const mood = MOODS[moodIds[i % moodIds.length]!]!;
      const recipe = inkRecipeFromSeed({ seed: 1000 + i * 7919, canvas, tools: [...mood.tools], folds: 'auto' });
      coverages.push(inkCoverage(renderOps(recipe), recipe.canvas));
    }
    coverages.sort((a, b) => a - b);
    const q = (at: number): number => coverages[Math.floor(at * coverages.length)]!;
    // The floor is a floor, so the bottom of the range is flat by design and the
    // whole spread has to come from the forms: what must hold is that the
    // *middle* blot is not sitting on the floor, that most of the batch is not,
    // and that the sizes still span a range rather than converging on one.
    expect(q(0.5)).toBeGreaterThan(MIN_INK_COVERAGE * 1.06);
    expect(q(0.9)).toBeGreaterThan(q(0.1) * 1.4);
    expect(coverages.filter((coverage) => coverage < MIN_INK_COVERAGE * 1.025).length)
      .toBeLessThan(0.35 * coverages.length);
  });
});
