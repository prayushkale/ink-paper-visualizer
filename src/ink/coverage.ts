import type { CanvasSpec, InkOp, InkToolId } from './types';
import { clamp, round, type Rng } from './rng';

/**
 * The share of the canvas a blot has to ink to read as a mark rather than a
 * speck.
 *
 * A sheet this size is not a place for pen marks: what belongs on it is a
 * handful of fat, wet shapes a child would leave behind. Every op log is grown
 * until it covers this much, so no blot reaches the film as a lone droplet in
 * the middle of an empty field.
 */
export const MIN_INK_COVERAGE = 0.2;

/**
 * The widest a single mark may become while a blot is being grown.
 *
 * Past this one op is no longer a mark on a sheet, it is the sheet - and a blot
 * that has to lean on it has already failed to be a composition.
 */
export const MAX_OP_WIDTH = 0.55;

/**
 * The widest a blot's own body may become while it has limbs to spend.
 *
 * A blot is grown to the floor by fattening its marks, and the heaviest mark is
 * the one that reaches the widest - so the body swallows the log: a batch grown
 * this way is a batch of boulders with the limbs inside them, and the largest a
 * body can honestly be is a shade under a third of the sheet. On a log with
 * limbs, growth is therefore spent on the limbs; a blot that is one mark, or a
 * body and a stub, still grows its own body to whatever the floor needs, because
 * there is nothing else in it to carry the ink.
 */
const BODY_WIDTH_CEILING = 0.3;

/** How few marks a log can have and still have limbs worth growing instead. */
const LIMBS_NEEDED = 3;

/**
 * The most of the sheet a blot is ever asked to ink.
 *
 * The floor keeps a blot from being a speck; this keeps the other end of the
 * range honest. Past roughly half the paper the only way there is to fatten every
 * mark of the log to the width ceiling, and a blot whose marks are all at the
 * ceiling is a boulder rather than a figure - its limbs are as thick as its body
 * because both have been grown until they could not be grown further. So the top
 * of the range is where a blot is still a mark on paper. It is ink laid down that
 * this counts, and a crease prints the ink a second time - the heavy end of a
 * folded blot's range is a sheet carrying most of its paper in pigment, which is
 * what a folded blot is.
 */
export const MAX_INK_COVERAGE = 0.4;

/**
 * The composition's own size at the two ends of the range.
 *
 * The floor still decides how much paper most blots end up taking - 20% of a
 * 1024px sheet is a lot of ink, and no composition with seven marks in it is
 * drawn at that size - so the scale is not asked to deliver the blot's size. It
 * is asked for the figure: one blot is a knot of ink the size of a thumbnail and
 * the next one is drawn half again as large, and the ink their limbs then walk
 * out into is what makes the two pages different pictures.
 */
const MIN_FORM_SCALE = 0.9;
const MAX_FORM_SCALE = 2.2;

/**
 * What this blot is aiming at, as a share of the sheet.
 *
 * Every invented blot used to be grown to the floor and no further, so a batch
 * of them all carried the same weight of ink and the pages read as one blot
 * reprinted at slightly different sizes. A blot now draws a size of its own.
 *
 * The size is asked for *before* the composition is drawn, not applied to it
 * afterwards: growing a finished form to a share of the sheet enlarges every one
 * of its marks by the factor the shortfall asks for, which puts the body on the
 * width ceiling, swells its thin limbs until they are fat as the body, and
 * leaves a lumpy mass where a figure was. Asking for the size first is what
 * makes one page a lone wet drop and the next a mass that has taken most of the
 * paper, while both stay the shapes they were composed as.
 */
export function inkTargetFor(rng: Rng): number {
  const drawn = MIN_INK_COVERAGE + rng.next() ** 1.8 * (MAX_INK_COVERAGE - MIN_INK_COVERAGE);
  return round(clamp(drawn, MIN_INK_COVERAGE, MAX_INK_COVERAGE), 3);
}

/**
 * The size the form is composed at, from the share of the sheet the blot wants.
 *
 * Compressed into the range a composition can honestly be drawn at, on purpose:
 * asking the composition for the whole of a heavy blot's target would draw a
 * single boulder of a form every time, and asking it for a floor-sized one would
 * draw a speck and leave the growing to the engine. It spans the range between
 * those, so a batch holds figures of visibly different sizes before any of them
 * is grown outwards.
 */
export function formScaleFor(target: number): number {
  const span = (target - MIN_INK_COVERAGE) / (MAX_INK_COVERAGE - MIN_INK_COVERAGE);
  return round(clamp(MIN_FORM_SCALE + span ** 0.8 * (MAX_FORM_SCALE - MIN_FORM_SCALE), MIN_FORM_SCALE, MAX_FORM_SCALE), 3);
}

/**
 * How much of a tool's nominal footprint actually ends up inked.
 *
 * A pool fades out past its solid core, a splatter is a disc with a sparse ring
 * of droplets around it, and a spray is a scatter of dots that is mostly paper.
 * Counting nominal footprints would let a blot of dust claim to cover the
 * sheet, so each tool is discounted to roughly what it really wets.
 */
const INK_FRACTION: Record<InkToolId, number> = {
  drop: 0.8,
  splatter: 0.5,
  pool: 0.6,
  // dots scale with the spray's own width, so a wet spray wets about a third of
  // its footprint (thin and dry, nearer a fifth) - there are no dust dots left
  spray: 0.32,
  streak: 0.8,
  curve: 0.7,
  drag: 0.5,
  // a backrun lifts pigment back out of the sheet: it never adds ink
  backrun: 0,
};

/** Resolution of the grid a blot's coverage is measured on. */
const GRID = 64;

/** How many times a blot may be grown before it is handed over as it is. */
const GROW_ATTEMPTS = 8;

/** Most a mark may be enlarged in one pass, so growth cannot explode. */
const MAX_GROW = 6;

/**
 * Least a mark may be enlarged in one pass.
 *
 * Growing by the exact ratio needed stalls one grid cell short of the floor:
 * k comes out as 1.001, the marks do not move by a measurable amount, and the
 * blot is handed over at 19.9% for ever. A floor on the step walks it in.
 */
const MIN_GROW = 1.08;

/**
 * How far the marks are pushed out from the blot's middle in one growth attempt.
 *
 * Growth used to reach the floor by fattening the marks, and fattening is what
 * makes a batch of blots look like one blot: every mark of the log is enlarged
 * by the factor the shortfall asks for, so a body with limbs on it arrives with
 * its limbs as thick as its body and the composition reads as a lump. Ink on
 * paper answers being pulled by spreading rather than by thickening - the body
 * stays where it was put and the limbs walk out to the sheet's edges - so growth
 * tries the walk first and only fattens what walking cannot reach.
 */
const STRETCH_STEP = 1.12;

/** Width given to a mark the grid could not even see, before growing it properly. */
const STARTER_WIDTH = 0.05;

/** Distance from a point to a segment, in the space where the mark is a unit disc. */
function distanceToSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** The radii one op wets, squashed to the canvas' aspect, or null if it adds no ink. */
function markRadii(op: InkOp, spec: CanvasSpec): { rx: number; ry: number } | null {
  const fraction = INK_FRACTION[op.tool] ?? 0;
  if (fraction <= 0 || op.points.length === 0) return null;
  const shortEdge = Math.min(spec.width, spec.height);
  // the fraction is an area, so it shrinks the radius by its square root
  const radius = op.width * shortEdge * Math.sqrt(fraction);
  const rx = radius / spec.width;
  const ry = radius / spec.height;
  if (!(rx > 0) || !(ry > 0)) return null;
  return { rx, ry };
}

/** Whether one op wets the point (cx, cy), UV space. */
export function opWets(op: InkOp, cx: number, cy: number, spec: CanvasSpec): boolean {
  const mark = markRadii(op, spec);
  if (!mark) return false;
  const { rx, ry } = mark;
  const points = op.points;
  if (points.length === 1) {
    const p = points[0]!;
    return Math.hypot((cx - p.x) / rx, (cy - p.y) / ry) <= 1;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    // in a space squashed by the mark's own radii the stroke is a capsule of radius 1
    const distance = distanceToSegment(a.x / rx, a.y / ry, b.x / rx, b.y / ry, cx / rx, cy / ry);
    if (distance <= 1) return true;
  }
  return false;
}

/**
 * How much of the canvas an op log inks, 0..1.
 *
 * Measured by stamping the log onto a coarse grid rather than by summing the
 * ops, so marks that fall on top of each other are counted once - a blot is how
 * much paper it covers, not how many times it was touched. Each op is stamped
 * inside its own box, so measuring a small blot costs a small amount of work:
 * this runs on every settings render and twice per painted frame.
 */
export function inkCoverage(ops: readonly InkOp[], spec: CanvasSpec): number {
  const marks = stampGrid(ops, spec);
  let wet = 0;
  for (let i = 0; i < marks.length; i++) if (marks[i]) wet++;
  return wet / (GRID * GRID);
}

/**
 * The grid a log wets: one byte per cell, 1 where the paper took ink.
 *
 * Exported for the tests that have to compare two blots as pictures rather than
 * as numbers - two logs whose marks land in the same cells are the same page,
 * whatever their tools and widths say.
 */
export function inkMask(ops: readonly InkOp[], spec: CanvasSpec): Uint8Array {
  return stampGrid(ops, spec);
}

/** The grid a log wets: one byte per cell, 1 where the paper took ink. */
function stampGrid(ops: readonly InkOp[], spec: CanvasSpec): Uint8Array {
  const marks = new Uint8Array(GRID * GRID);
  for (const op of ops) {
    const mark = markRadii(op, spec);
    if (!mark) continue;
    markOp(marks, op, mark, spec);
  }
  return marks;
}

/**
 * How many separate pieces of ink an op log lays down.
 *
 * A blot is meant to be one - a body with limbs growing out of it, which is
 * what every inkblot anyone has ever admired is - and a page holding five
 * separate soft blobs reads as five blobs, not as a blot. This counts the
 * connected wet regions on the same coarse grid the coverage is measured on, so
 * "one mass, not five" is something a test asserts rather than something a
 * reader has to judge from a 176px thumbnail. Four-way neighbours: a diagonal
 * touch is two marks leaning on each other, not one piece of ink.
 */
export function inkComponents(ops: readonly InkOp[], spec: CanvasSpec): number {
  const marks = stampGrid(ops, spec);
  const seen = new Uint8Array(marks.length);
  const queue: number[] = [];
  let components = 0;
  for (let start = 0; start < marks.length; start++) {
    if (!marks[start] || seen[start]) continue;
    components++;
    seen[start] = 1;
    queue.push(start);
    while (queue.length > 0) {
      const index = queue.pop()!;
      const x = index % GRID;
      const y = (index - x) / GRID;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < GRID - 1 ? index + 1 : -1,
        y > 0 ? index - GRID : -1,
        y < GRID - 1 ? index + GRID : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || seen[next] || !marks[next]) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
  }
  return components;
}

/** Writes every grid cell one op wets into `marks`. */
function markOp(marks: Uint8Array, op: InkOp, mark: { rx: number; ry: number }, spec: CanvasSpec): void {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of op.points) {
    minX = Math.min(minX, point.x - mark.rx);
    minY = Math.min(minY, point.y - mark.ry);
    maxX = Math.max(maxX, point.x + mark.rx);
    maxY = Math.max(maxY, point.y + mark.ry);
  }
  const firstX = Math.max(0, Math.floor(minX * GRID));
  const lastX = Math.min(GRID - 1, Math.ceil(maxX * GRID));
  const firstY = Math.max(0, Math.floor(minY * GRID));
  const lastY = Math.min(GRID - 1, Math.ceil(maxY * GRID));
  for (let gy = firstY; gy <= lastY; gy++) {
    for (let gx = firstX; gx <= lastX; gx++) {
      const index = gy * GRID + gx;
      if (marks[index]) continue;
      if (opWets(op, (gx + 0.5) / GRID, (gy + 0.5) / GRID, spec)) marks[index] = 1;
    }
  }
}

/** The middle of the area an op log wets, UV space. Null for a log that inks nothing. */
function blotCentre(ops: readonly InkOp[]): { x: number; y: number } | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const op of ops) {
    for (const point of op.points) {
      sumX += point.x;
      sumY += point.y;
      count++;
    }
  }
  if (count === 0) return null;
  return { x: sumX / count, y: sumY / count };
}

/**
 * Where a mark's point may sit for the mark to be on the sheet.
 *
 * A mark wider than the sheet has one answer, the middle of it, so the bounds
 * collapse to 0.5 for both sides rather than crossing over each other.
 */
function markBounds(mark: { rx: number; ry: number }): { lowX: number; highX: number; lowY: number; highY: number } {
  return {
    lowX: clamp(mark.rx, 0.02, 0.5),
    highX: clamp(1 - mark.rx, 0.5, 0.98),
    lowY: clamp(mark.ry, 0.02, 0.5),
    highY: clamp(1 - mark.ry, 0.5, 0.98),
  };
}

/**
 * One op, nudged a share of the way onto the sheet.
 *
 * A mark is only worth its full width when the sheet reaches all the way under
 * it: a wide mark anchored in a corner wets a sliver of paper while measuring
 * as a disc. Every point is walked toward the nearest place its own mark fits.
 */
function pullInside(op: InkOp, spec: CanvasSpec, share: number): InkOp {
  const mark = markRadii(op, spec);
  if (!mark || share <= 0) return op;
  const bounds = markBounds(mark);
  const inside = (value: number, low: number, high: number): number =>
    value + (clamp(value, low, high) - value) * share;
  return {
    ...op,
    points: op.points.map((point) => ({
      x: round(inside(point.x, bounds.lowX, bounds.highX), 4),
      y: round(inside(point.y, bounds.lowY, bounds.highY), 4),
    })),
  };
}

/**
 * One op, grown: fatter by `widthK`, pushed away from the blot's middle by
 * `spreadK`, and kept on the sheet as it goes.
 */
function enlarge(
  op: InkOp,
  widthK: number,
  spreadK: number,
  centre: { x: number; y: number },
  spec: CanvasSpec,
  ceiling = MAX_OP_WIDTH,
): InkOp {
  const width = round(Math.min(ceiling, op.width * widthK), 4);
  // the mark's own new size decides how close to the edge its point may sit:
  // spreading a mark out must not walk it off the sheet it is wetted on
  const mark = markRadii({ ...op, width }, spec);
  const bounds = mark ? markBounds(mark) : { lowX: 0.02, highX: 0.98, lowY: 0.02, highY: 0.98 };
  return {
    ...op,
    width,
    points: op.points.map((point) => ({
      x: round(clamp(centre.x + (point.x - centre.x) * spreadK, bounds.lowX, bounds.highX), 4),
      y: round(clamp(centre.y + (point.y - centre.y) * spreadK, bounds.lowY, bounds.highY), 4),
    })),
  };
}

/**
 * Grows an op log until it inks at least `floor` of the canvas.
 *
 * A mark only wets as much sheet as the sheet reaches under it, so growth walks
 * every mark onto the sheet and then fattens it: a fatter mark is what adds
 * paper, and pulling a mark inside can only add it. Spreading the marks apart is
 * the last resort, because marks near an edge slide into that edge and pile up
 * rather than separating. A blot that only lifts pigment (backruns) has nothing
 * to grow and is returned as it came.
 */
export function fitToInkFloor(ops: readonly InkOp[], spec: CanvasSpec, floor = MIN_INK_COVERAGE): InkOp[] {
  const start: InkOp[] = ops.map((op) => ({ ...op, points: op.points.map((point) => ({ ...point })) }));
  // the walk first, then as many fattening passes as the floor needs: a blot is
  // a mark on a sheet, and one that came out as a speck in an empty field is the
  // one thing the engine must never hand over
  let grown = growBlot(start, spec, floor, GROW_ATTEMPTS);
  for (let pass = 0; pass < 2 && inkCoverage(grown, spec) < floor; pass++) {
    grown = fattenBlot(grown, spec, floor, GROW_ATTEMPTS);
  }
  return grown;
}

/**
 * The measure-grow-measure loop: walk every mark onto the sheet, walk the ink
 * outwards while that is what adds paper, and fatten it when it is not.
 *
 * An attempt that adds nothing is answered by going straight to the widest a
 * mark may be: a mark growing inside a bigger one wets no new paper, so a log
 * that cannot be walked anywhere is one that can only be thickened.
 */
function growBlot(ops: InkOp[], spec: CanvasSpec, floor: number, attempts: number): InkOp[] {
  let grown = ops;
  let previous = -1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const coverage = inkCoverage(grown, spec);
    if (coverage >= floor) break;
    const middle = blotCentre(grown);
    if (!middle) break;
    if (coverage <= 0) {
      // a mark too small for the grid to see: give it a body, then measure again
      grown = grown.map((op) => ({ ...op, width: round(Math.max(op.width, STARTER_WIDTH), 4) }));
      continue;
    }
    const placed = grown.map((op) => pullInside(op, spec, 1));
    const centre = blotCentre(placed) ?? middle;
    // the walk first: the body stays where it was put and the ink leaves it. A
    // walk that pulls the ink apart into separate pools is refused, and a half
    // step is tried before giving up on walking: marks that lean on each other
    // are one piece of ink, and growing a blot into five blobs is not growth.
    const walked = walkOut(placed, spec, centre);
    if (walked && inkCoverage(walked, spec) > coverage * 1.004) {
      grown = walked;
      previous = coverage;
      continue;
    }
    grown = fatten(placed, spec, coverage, floor, previous, centre);
    previous = coverage;
  }
  return grown;
}

/**
 * The log, walked outwards from its middle, or null if that pulled it apart.
 *
 * The step is halved before the walk is refused, because how far a log can be
 * walked before its marks stop touching depends on how far apart they already
 * are - a chain of beads laid along a limb is the first thing to break.
 */
function walkOut(ops: readonly InkOp[], spec: CanvasSpec, centre: { x: number; y: number }): InkOp[] | null {
  for (const step of [STRETCH_STEP, Math.sqrt(STRETCH_STEP)]) {
    const walked = ops.map((op) => enlarge(op, 1, step, centre, spec));
    if (inkComponents(walked, spec) === 1) return walked;
  }
  return null;
}

/** One fattening pass: every mark widened by the factor the shortfall asks for. */
function fatten(
  ops: readonly InkOp[],
  spec: CanvasSpec,
  coverage: number,
  floor: number,
  previous: number,
  centre: { x: number; y: number },
): InkOp[] {
  const stalled = coverage <= previous * 1.002;
  const k = stalled
    ? MAX_GROW
    : Math.min(MAX_GROW, Math.max(MIN_GROW, Math.sqrt(floor / coverage)));
  // the body is the heaviest mark of the log, and it stops at its own ceiling
  // while the limbs may still grow: ink the body may not take is ink the limbs
  // have to walk out for, which is what keeps a grown blot a figure
  const body = ops.reduce((heaviest, op) => (op.width > heaviest ? op.width : heaviest), 0);
  const ceiling = ops.length >= LIMBS_NEEDED ? BODY_WIDTH_CEILING : MAX_OP_WIDTH;
  return ops.map((op) =>
    enlarge(op, k, 1, centre, spec, op.width >= body ? Math.max(ceiling, op.width) : MAX_OP_WIDTH),
  );
}

/** The measure-fatten-measure loop, for a log that cannot be walked any further. */
function fattenBlot(ops: InkOp[], spec: CanvasSpec, floor: number, attempts: number): InkOp[] {
  let grown = ops;
  let previous = -1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const coverage = inkCoverage(grown, spec);
    if (coverage >= floor) break;
    const middle = blotCentre(grown);
    if (!middle) break;
    if (coverage <= 0) {
      grown = grown.map((op) => ({ ...op, width: round(Math.max(op.width, STARTER_WIDTH), 4) }));
      continue;
    }
    const placed = grown.map((op) => pullInside(op, spec, 1));
    const centre = blotCentre(placed) ?? middle;
    grown = fatten(placed, spec, coverage, floor, previous, centre);
    previous = coverage;
  }
  return grown;
}
