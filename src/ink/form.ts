import { MAX_OP_WIDTH } from './coverage';
import { clamp, round, type Rng } from './rng';
import type { CanvasSpec, InkToolId, UV } from './types';

/**
 * Tools that can carry a blot on their own: each of these wets a wide area, so
 * a blot that has one of them in it can always be grown to fill its share of
 * the sheet. The faint tools (a spray of dots, a backrun that lifts pigment)
 * only ever support a mark - a blot made of nothing but those is dust, however
 * big it gets.
 */
export const CARRIER_TOOLS: readonly InkToolId[] = ['pool', 'drop', 'streak', 'curve', 'drag'];

/** The marks that make up a blot may never be thinner than this share of the short edge. */
export const MIN_OP_WIDTH = 0.04;

/**
 * The most limbs one blot may be given.
 *
 * A blot spends its marks on a body, then on limbs, then on knots, and the old
 * rule spent every mark it had on another arm - which is why a seven-mark blot
 * came out as a body with six arms and a five-mark blot as the same thing with
 * four. Five is where a blot stops reading as a composition and starts reading
 * as a sea urchin, and it leaves the spare marks to pool along the limbs the
 * blot does have, which is what a knotted arm is made of.
 */
export const MAX_LIMBS = 5;

/** Tools that lay a stroke rather than a blob, in the order the engine prefers them. */
const STROKE_TOOLS: readonly InkToolId[] = ['curve', 'streak', 'drag'];

/** Tools that lay a round mark, so a chain of them beads into a tendril. */
const BEAD_TOOLS: readonly InkToolId[] = ['drop', 'pool'];

/** Tools that only ever texture a blot the carriers have already made. */
const TEXTURE_TOOLS: readonly InkToolId[] = ['spray', 'backrun'];

/** Where along a limb the ink pools, when marks are left over. */
const NODE_STOPS = [0.22, 0.38, 0.54, 0.7, 0.84, 0.94];

/**
 * How often a limb is laid as a chain of round marks rather than as a stroke.
 *
 * Beading used to be the fallback for a mood with no stroke in its vocabulary,
 * which meant every blot the engine invented - and every mood it ships offers a
 * curve - came out of nothing but smooth tapered lines.
 */
const BEAD_CHANCE = 0.28;

/**
 * The character of one blot: how the ink went down this time round.
 *
 * A blot used to be a scatter of independent marks - the field was cut into a
 * grid, each mark took a cell, and the sheet came out as five or seven separate
 * blobs that happened to share a page. Every good inkblot is the other thing: a
 * single connected mass with a heavy body and a few limbs walking away from it.
 * So a form is what the engine composes now, and the marks are what it composes
 * the form out of.
 */
export type BlotFormKind = 'bud' | 'plume' | 'crown' | 'tendril' | 'rake' | 'crossing' | 'arch' | 'wall';

export const BLOT_FORM_KINDS: readonly BlotFormKind[] = [
  'bud',
  'plume',
  'crown',
  'tendril',
  'rake',
  'crossing',
  'arch',
  'wall',
];

/** A rectangle of the sheet, in UV: the part of the paper the ink may occupy. */
export interface FormDomain {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What a mark is doing in the composition: the body of the blot, a limb walking
 * away from it, a knot of ink pooled along a limb, or the texture over the lot.
 * The recipe reads this to place the mark on its own ramp of pigment.
 */
export type FormRole = 'core' | 'limb' | 'node' | 'texture';

export interface FormMark {
  role: FormRole;
  tool: InkToolId;
  points: UV[];
  /** Share of the short edge. */
  width: number;
  alpha: number;
  wetness: number;
  /** Width at the far end of a stroke, as a multiplier. 1 leaves it untapered. */
  rampTo?: number;
  seed: number;
}

export interface BlotForm {
  kind: BlotFormKind;
  core: UV;
  /** The body's own radius, as a share of the short edge. */
  coreWidth: number;
  /** In painting order: the body first, then the marks that grow out of it. */
  marks: FormMark[];
}

export interface FormOptions {
  /** How many marks the blot is made of, 1..BLOT_MARKS. Always spent exactly. */
  marks: number;
  tools: readonly InkToolId[];
  spec: CanvasSpec;
  wetness: number;
  /**
   * The part of the sheet the ink may occupy. Defaults to all of it. A recipe
   * with a single centre crease hands the moving flap in here, so the fold's
   * print comes back as a mirrored pair instead of over a copy of the blot.
   */
  domain?: FormDomain;
  /**
   * How large the composition is drawn, 1 being the engine's ordinary blot.
   *
   * The whole form scales together - body and limbs - so a heavier blot is a
   * bigger figure rather than the same figure grown, and the ratio between a
   * limb and the body it grew out of survives the change. A limb's reach does
   * not scale with it: that is measured from the body's middle to the sheet's
   * edge, and a bigger body honestly has less room to reach across.
   */
  scale?: number;
}

/** A point in canvas pixels. Every bit of geometry below is done in this space. */
interface Px {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One limb, as the form asks for it before the sheet has its say. */
interface LimbSpec {
  /** Heading in radians. */
  angle: number;
  /**
   * How much of the room between the body and the sheet's edge the limb takes,
   * 0..1.
   *
   * Not a multiple of the body's own radius: that roll was dead, because a limb
   * asked for six body-radii of reach on a field one body-radius deep is always
   * clipped to the edge, so every arm on every blot arrived with its tip on the
   * paper's border and every composition came out as a body with arms to every
   * edge. A share of the room the sheet actually offers is what lets one blot
   * hold a stub and another a long arm thrown the whole way across.
   */
  reach: number;
  /** Radians the limb drifts through on its way out. */
  bend: number;
  /**
   * Width at the root, as a share of the sheet's short edge.
   *
   * Not a multiple of the body's radius. A limb is only read as a limb while it
   * is much longer than it is wide, and the body is grown to the ink floor
   * after the form is composed - so a limb sized off the body's radius is
   * inflated along with it and arrives as another lobe of the same mass. The
   * widths a limb may take are therefore the sheet's own: a tendril is 3-8% of
   * the short edge, a broad swept wash twice that, and the body is whatever it
   * has to be to carry the ink.
   */
  root: number;
  /** Width at the far end, as a multiple of the root. */
  tip: number;
}

interface Skeleton {
  /** Body centre, as a fraction of the field. */
  anchor: UV;
  /** As a share of the short edge, before the form's own scale. */
  coreWidth: number;
  limbs: LimbSpec[];
}

/**
 * The shapes a blot takes, as a body and the limbs that leave it.
 *
 * Each is a kind of composition rather than a different scatter: a lone wet
 * body with a stub, a body low on the sheet with one long arm, a body with arms
 * all round it, fronds leaning the same way, a dry sweep set off from an edge,
 * and two arms crossing at the middle. Anchors are fractions of the field, so a
 * fold can hand the form a flap to live in and get the same composition in a
 * smaller space.
 */
function skeletonFor(kind: BlotFormKind, rng: Rng): Skeleton {
  const coreWidth = rng.range(0.045, 0.095);
  // One blot is a lonely fat drop and the next is a thin-armed sprawl: the
  // form's own scale is the first thing that separates two pages, so it is wide.
  const scale = rng.range(0.8, 1.45);
  /**
   * Limbs fanned about a heading, each with its own length, its own thickness
   * and its own drift.
   *
   * The thickness roll is what decides whether a blot's arms read as legs or as
   * lobes: a limb a third of the body's width is a tendril, one nearly as wide as
   * the body is the next lobe of an amoeba, and a batch with only the middle of
   * that range in it is a batch of soft round clouds. So every kind asks for its
   * own range rather than sharing one.
   */
  const fan = (
    count: number,
    lean: number,
    spread: number,
    reach: [number, number],
    root: [number, number] = [0.025, 0.055],
    tip: [number, number] = [0.2, 0.5],
  ): LimbSpec[] => {
    const limbs: LimbSpec[] = [];
    for (let i = 0; i < count; i++) {
      const at = count === 1 ? 0 : i / (count - 1) - 0.5;
      limbs.push({
        angle: lean + at * spread + rng.range(-0.32, 0.32),
        reach: rng.range(reach[0], reach[1]),
        bend: rng.range(-1, 1),
        root: rng.range(root[0], root[1]),
        tip: rng.range(tip[0], tip[1]),
      });
    }
    return limbs;
  };
  switch (kind) {
    case 'plume':
      // a heavy body low on the field with one long arm thrown up and across it
      return {
        anchor: { x: round(rng.range(0.2, 0.8), 4), y: round(rng.range(0.5, 0.86), 4) },
        coreWidth: coreWidth * scale,
        limbs: [
          {
            angle: -Math.PI / 2 + rng.range(-0.6, 0.6),
            reach: rng.range(0.8, 1),
            bend: rng.range(-1.3, 1.3),
            root: rng.range(0.022, 0.05),
            tip: rng.range(0.12, 0.3),
          },
          ...fan(rng.int(0, 2), -Math.PI / 2, 2.1, [0.55, 1], [0.022, 0.05]),
        ],
      };
    case 'crown':
      // a body with arms all round it: the most symmetric thing a blot can be
      return {
        anchor: { x: round(rng.range(0.22, 0.78), 4), y: round(rng.range(0.22, 0.78), 4) },
        coreWidth: coreWidth * scale,
        limbs: fan(
          rng.int(2, 5),
          rng.range(-Math.PI, Math.PI),
          rng.range(Math.PI * 0.8, Math.PI * 1.3),
          [0.62, 1],
          [0.025, 0.055],
          [0.22, 0.62],
        ),
      };
    case 'tendril': {
      // fronds leaning the same way, set off to one side of the sheet: the
      // thinnest arms the engine makes, so the page reads as line work rather
      // than as a mass
      const lean = rng.bool(0.5) ? rng.range(-0.5, 0.5) : Math.PI + rng.range(-0.5, 0.5);
      return {
        anchor: { x: round(rng.range(0.12, 0.88), 4), y: round(rng.range(0.18, 0.82), 4) },
        coreWidth: coreWidth * scale * rng.range(0.8, 1.1),
        limbs: fan(rng.int(2, 4), lean, 0.9, [0.66, 1], [0.018, 0.04], [0.14, 0.34]).map((limb) => ({
          ...limb,
          bend: rng.range(-1.6, 1.6),
        })),
      };
    }
    case 'rake': {
      // a dry broad sweep, set off from one edge and dragged across the sheet
      const fromLeft = rng.bool(0.5);
      return {
        anchor: {
          x: round(fromLeft ? rng.range(0.08, 0.22) : rng.range(0.78, 0.92), 4),
          y: round(rng.range(0.22, 0.78), 4),
        },
        coreWidth: coreWidth * scale * 0.85,
        limbs: fan(
          rng.int(1, 2),
          fromLeft ? rng.range(-0.45, 0.45) : Math.PI + rng.range(-0.45, 0.45),
          0.7,
          [0.85, 1],
          // a swept brush keeps most of its width to the end of the stroke
          [0.04, 0.075],
          [0.45, 0.72],
        ).map((limb) => ({ ...limb, bend: rng.range(-0.5, 0.5) })),
      };
    }
    case 'crossing':
      // two arms crossing at the body, one long and one short
      return {
        anchor: { x: round(rng.range(0.3, 0.7), 4), y: round(rng.range(0.3, 0.7), 4) },
        coreWidth: coreWidth * scale,
        limbs: [
          { angle: rng.range(-Math.PI, Math.PI), reach: rng.range(0.7, 1), bend: rng.range(-0.6, 0.6), root: rng.range(0.03, 0.06), tip: rng.range(0.15, 0.3) },
          { angle: rng.range(-Math.PI, Math.PI), reach: rng.range(0.42, 0.9), bend: rng.range(-0.9, 0.9), root: rng.range(0.025, 0.055), tip: rng.range(0.25, 0.5) },
        ],
      };
    case 'arch':
      // a body with two arms that curl back around it, the way a folded sheet
      // holds its own print: the silhouette is a loop rather than a starburst
      return {
        anchor: { x: round(rng.range(0.18, 0.82), 4), y: round(rng.range(0.2, 0.8), 4) },
        coreWidth: coreWidth * scale * rng.range(0.85, 1.15),
        limbs: fan(2, rng.range(-Math.PI, Math.PI), rng.range(1.1, 2.4), [0.66, 1], [0.022, 0.05]).map((limb) => ({
          ...limb,
          bend: rng.bool(0.5) ? rng.range(1.1, 2.1) : rng.range(-2.1, -1.1),
        })),
      };
    case 'wall':
      // a broad wash dropped along one edge of the sheet, with the ink piling up
      // in a bank rather than reaching out: the flattest blot the engine makes
      return {
        anchor: {
          x: round(rng.range(0.16, 0.84), 4),
          y: round(rng.bool(0.5) ? rng.range(0.7, 0.9) : rng.range(0.1, 0.3), 4),
        },
        coreWidth: coreWidth * scale * rng.range(1.3, 1.7),
        limbs: fan(
          rng.int(1, 3),
          rng.range(-Math.PI, Math.PI),
          Math.PI * 0.9,
          [0.5, 0.92],
          [0.055, 0.11],
          [0.5, 0.78],
        ).map((limb) => ({ ...limb, bend: rng.range(-0.6, 0.6) })),
      };
    case 'bud':
    default:
      // the smallest thing that is still a blot: one wet body and a stub
      return {
        anchor: { x: round(rng.range(0.18, 0.82), 4), y: round(rng.range(0.18, 0.82), 4) },
        coreWidth: coreWidth * scale * rng.range(1.15, 1.45),
        limbs: [
          { angle: rng.range(-Math.PI, Math.PI), reach: rng.range(0.42, 0.8), bend: rng.range(-1, 1), root: rng.range(0.035, 0.08), tip: rng.range(0.3, 0.6) },
        ],
      };
  }
}

/** The field the ink may use, in pixels, inset so a mark cannot hang off it. */
function fieldBox(domain: FormDomain | undefined, spec: CanvasSpec, margin: number): Box {
  const box: Box = domain
    ? { x: domain.x * spec.width, y: domain.y * spec.height, w: domain.w * spec.width, h: domain.h * spec.height }
    : { x: 0, y: 0, w: spec.width, h: spec.height };
  const inset = Math.min(margin, Math.min(box.w, box.h) * 0.25);
  return { x: box.x + inset, y: box.y + inset, w: Math.max(1, box.w - inset * 2), h: Math.max(1, box.h - inset * 2) };
}

/** Where a fraction of the field lands, in pixels. */
function insideField(box: Box, at: UV): Px {
  return { x: box.x + at.x * box.w, y: box.y + at.y * box.h };
}

/** How far the field reaches from a point along a heading, in pixels. */
function reachToEdge(from: Px, heading: number, box: Box): number {
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  const limits: number[] = [];
  if (dx > 1e-6) limits.push((box.x + box.w - from.x) / dx);
  if (dx < -1e-6) limits.push((box.x - from.x) / dx);
  if (dy > 1e-6) limits.push((box.y + box.h - from.y) / dy);
  if (dy < -1e-6) limits.push((box.y - from.y) / dy);
  return limits.length > 0 ? Math.max(0, Math.min(...limits)) : 0;
}

/**
 * Where a limb points, and how much room it has when it gets there.
 *
 * A limb pointing off the sheet turns rather than stopping: the four mirrorings
 * of a heading are the four directions it can be bent into, which is the same
 * set of answers a crease gives a line crossing it. Most of the time the longest
 * of them wins, because a limb left as a stub against an edge buys nothing -
 * which is what a heading reflected blindly produces whenever the form's reach
 * is longer than the field is deep. The rest of the time any mirroring will do,
 * and that is deliberate: it is what lets an arm come out short and a
 * composition come out lopsided, instead of every blot in a batch being a body
 * with arms to all four edges. The caller then takes a share of the room it is
 * given, so a limb is never a stub by accident, only by choice.
 */
function limbHeading(rng: Rng, from: Px, angle: number, box: Box): { heading: number; reach: number } {
  const options = [angle, Math.PI - angle, -angle, Math.PI + angle].map((heading) => ({
    heading,
    reach: reachToEdge(from, heading, box),
  }));
  const longest = options.reduce((best, candidate) => (candidate.reach > best.reach ? candidate : best), options[0]!);
  if (rng.next() < 0.68) return longest;
  return rng.pick(options);
}

/** A point `distance` away from `from` along a heading. */
function walk(from: Px, heading: number, distance: number): Px {
  return { x: from.x + Math.cos(heading) * distance, y: from.y + Math.sin(heading) * distance };
}

/**
 * A limb laid as an overlapping chain of round marks.
 *
 * A mood that offers no stroke - a vocabulary of drops and pools - still gets
 * limbs, as a beaded tendril: each mark sits close enough to the last to
 * overlap it, so the chain is one piece of ink with knots pooled along it. This
 * is what keeps a blot connected whatever the mood asks for, and the engine
 * beads about a quarter of its limbs even when a stroke was on offer, because a
 * page of nothing but smooth tapered curves is a page of soft, similar shapes.
 *
 * A bead carries the width of the chain at its own point, so the tendril tapers
 * from the body to its tip the way a stroke does. Every bead taking the limb's
 * root width - which is what it used to do - made the arm a tube as fat as the
 * body it grew out of, and a blot with a tube on it is a lump rather than a
 * figure.
 */
function beadLimb(
  from: Px,
  heading: number,
  reach: number,
  rootRadius: number,
  tip: number,
  budget: number,
  spec: CanvasSpec,
): Array<{ at: Px; radius: number }> {
  const beads: Array<{ at: Px; radius: number }> = [];
  // The first bead sits a little way out from the body's middle rather than on
  // it: two marks stacked on one point are one mark on the page, and a limb
  // that beads nothing looks like the body printed twice.
  let cursor = walk(from, heading, Math.min(reach, rootRadius) * 0.5);
  let radius = rootRadius;
  let travelled = 0;
  while (beads.length < budget) {
    beads.push({ at: cursor, radius });
    const next = Math.max(rootRadius * tip, radius * 0.68);
    const step = (radius + next) * 0.72;
    if (travelled + step > reach) break;
    cursor = walk(cursor, heading, step);
    travelled += step;
    radius = next;
    if (cursor.x < 0 || cursor.y < 0 || cursor.x > spec.width || cursor.y > spec.height) break;
  }
  return beads;
}

/** A point a share of the way along a mark's own path, in pixels. */
function alongPath(points: readonly Px[], share: number): Px {
  if (points.length === 1) return { ...points[0]! };
  let total = 0;
  const spans: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const span = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    spans.push(span);
    total += span;
  }
  if (total <= 0) return { ...points[0]! };
  let wanted = share * total;
  for (let i = 0; i < spans.length; i++) {
    if (wanted > spans[i]!) {
      wanted -= spans[i]!;
      continue;
    }
    const t = spans[i]! <= 0 ? 0 : wanted / spans[i]!;
    const a = points[i]!;
    const b = points[i + 1]!;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return { ...points[points.length - 1]! };
}

/**
 * A limb's own path: a line that drifts as it goes, because a limb of ink is
 * pulled by the paper rather than ruled. A streak and a drag are two control
 * points by definition, so their drift is the renderer's wobble; a curve walks
 * point by point and carries its own bend.
 */
function strokePath(rng: Rng, from: Px, heading: number, reach: number, bend: number, tool: InkToolId): Px[] {
  const segments = tool === 'curve' ? rng.int(3, 5) : 1;
  // The path opens on the point it grew out of: a limb that started at its own
  // second control point would be a line floating beside the body rather than
  // ink leaving it, and the whole blot would come apart into separate pieces.
  const points: Px[] = [from];
  let cursor = from;
  let angle = heading;
  for (let i = 0; i < segments; i++) {
    angle += (bend / segments) * rng.range(0.4, 1.6);
    cursor = walk(cursor, angle, reach / segments);
    points.push(cursor);
  }
  return points;
}

/**
 * One blot's composition: a body, the limbs that grow out of it, ink pooled
 * along those limbs, and a texture over the finished mass.
 *
 * The form spends exactly `options.marks` marks whatever it is handed: the body
 * is one, a limb takes one (or as many beads as a strokeless mood needs), the
 * texture at most one, and anything left pools as a knot on a mark that is
 * already down. It is composed in the order it is painted, so the rail's show
 * grows the blot outwards the way a brush would.
 */
export function blotForm(rng: Rng, options: FormOptions): BlotForm {
  const { spec } = options;
  const shortEdge = Math.min(spec.width, spec.height);
  const budget = Math.max(1, Math.round(options.marks));
  const kind = rng.pick(BLOT_FORM_KINDS);
  const skeleton = skeletonFor(kind, rng);
  const share = Math.max(0.2, options.scale ?? 1);
  const coreRadius = skeleton.coreWidth * shortEdge * share;
  const box = fieldBox(options.domain, spec, coreRadius * 0.8);
  const core = insideField(box, skeleton.anchor);
  const strokes = STROKE_TOOLS.filter((tool) => options.tools.includes(tool));
  const beads = BEAD_TOOLS.filter((tool) => options.tools.includes(tool));
  const texture = TEXTURE_TOOLS.find((tool) => options.tools.includes(tool));
  const carrier = options.tools.includes('pool')
    ? 'pool'
    : CARRIER_TOOLS.find((tool) => options.tools.includes(tool)) ?? rng.pick(CARRIER_TOOLS);

  /** Widths are a share of the short edge, floored so no mark reads as dust. */
  const clampWidth = (radius: number): number =>
    round(clamp(radius, MIN_OP_WIDTH * shortEdge, MAX_OP_WIDTH * shortEdge) / shortEdge, 4);

  /** Every mark rides the recipe's wetness, with its own variation on top. */
  const wetness = (): number => clamp(options.wetness + rng.range(-0.3, 0.3), 0, 1);

  const toUV = (at: Px): UV => ({
    x: round(clamp(at.x, 0, spec.width) / spec.width, 4),
    y: round(clamp(at.y, 0, spec.height) / spec.height, 4),
  });

  const marks: FormMark[] = [
    coreMark(rng, { tool: carrier, at: core, radius: coreRadius, wetness: wetness() }, toUV, clampWidth),
  ];
  // The texture is one of the blot's marks, so its slot is reserved before any
  // limb is laid: a beaded limb will happily spend the whole budget, and the
  // texture is the mood's own look on the paper, not a mark to lose.
  const textureSlot = texture && budget > 3 ? 1 : 0;
  /** The marks a knot may pool on, and the pixel paths they were drawn along. */
  const limbPaths: Array<{ mark: FormMark; path: Px[] }> = [];
  let left = budget - 1 - textureSlot;

  // How many arms this blot may lay.
  //
  // Not "as many as the marks allow", which is what made a seven-mark blot a
  // body with six arms: how many arms a blot has is a composition of its own,
  // rolled separately from the count, and one blot will throw five thin limbs
  // across the sheet while the next pools its whole budget into two knots along
  // one arm. At least one knot stays back for a blot with room to spare, so a
  // crowded page gathers weight instead of growing a leg.
  const room = Math.max(0, left);
  const limbWant = Math.min(
    MAX_LIMBS,
    rng.int(1, Math.max(1, room - (room >= 4 ? 1 : 0))),
  );
  const specs = [...skeleton.limbs];
  while (specs.length < limbWant) {
    const seed = rng.pick(skeleton.limbs);
    specs.push({
      ...seed,
      angle: seed.angle + rng.range(-0.9, 0.9),
      reach: rng.range(0.35, 1),
      bend: seed.bend * rng.range(-1.4, 1.4),
    });
  }
  const limbCount = Math.min(specs.length, Math.max(0, left));
  for (let i = 0; i < limbCount && left > 0; i++) {
    const limb = specs[i]!;
    const fitted = limbHeading(rng, core, limb.angle, box);
    const heading = fitted.heading;
    // The limb takes a share of the room the sheet offers it, so its length is
    // the limb's own decision rather than the field's.
    const reach = fitted.reach * limb.reach;
    const rootRadius = clampWidth(limb.root * shortEdge * share) * shortEdge;
    const tool = strokes.length > 0 ? pickLimbTool(rng, strokes, limbPaths.map((entry) => entry.mark)) : undefined;
    // A limb does not have to be a stroke, even when the mood has one to offer.
    // A chain of overlapping round marks is a knobbly tendril - ink that ran
    // rather than ink that was pulled - and a batch of nothing but smooth
    // tapered curves is a batch of soft, similar shapes however far apart the
    // forms are planted. Roughly a quarter of the engine's limbs bead.
    // a limb may only bead with a tool the mood actually offers - a chain of
    // drops on a sheet that was promised nothing but curves is a mark the recipe
    // never asked for, and the tools a log reaches for are checked against it
    const beadTool = beads.length > 0 ? rng.pick(beads) : rng.pick(BEAD_TOOLS);
    const beadsThisLimb = beads.length > 0 && (strokes.length === 0 || rng.next() < BEAD_CHANCE);
    // A stroke shorter than its own width is a dot wearing a stroke's name, and
    // the sheet has no room for the limb: the mark becomes a knot on the body
    // instead, which is where a mark with nowhere to go belongs.
    if (tool && !beadsThisLimb && reach > rootRadius) {
      const path = strokePath(rng, core, heading, reach, limb.bend, tool);
      const mark: FormMark = {
        role: 'limb',
        tool,
        points: path.map(toUV),
        width: clampWidth(rootRadius),
        rampTo: round(limb.tip, 3),
        alpha: round(rng.range(0.5, 0.88), 3),
        wetness: round(wetness(), 3),
        seed: rng.seed32(),
      };
      marks.push(mark);
      limbPaths.push({ mark, path });
      left--;
      continue;
    }
    // the limb beads out of round marks, so the chain is one piece of ink
    // whatever the mood offered. The last resort is the blobs themselves, never a
    // stroke - a bead is one point, and a one-point streak is not a streak and
    // would break the shape the tool promises the renderer.
    const chain = beadLimb(core, heading, reach, rootRadius, limb.tip, left, spec);
    for (const bead of chain) {
      const mark: FormMark = {
        role: 'limb',
        tool: beadTool,
        points: [toUV(bead.at)],
        width: clampWidth(bead.radius),
        alpha: round(rng.range(0.5, 0.88), 3),
        wetness: round(wetness(), 3),
        seed: rng.seed32(),
      };
      marks.push(mark);
      limbPaths.push({ mark, path: [bead.at] });
      left--;
    }
  }

  // Anything the limbs did not spend pools as a knot along one of them: ink
  // gathers where a limb thickens, which is where a blot's weight comes from.
  const hosts = limbPaths.length > 0 ? limbPaths : [{ mark: marks[0]!, path: [core] }];
  for (let spent = 0; left > 0; spent++) {
    const host = hosts[spent % hosts.length]!;
    const stop = NODE_STOPS[Math.floor(spent / hosts.length) % NODE_STOPS.length]!;
    const at = alongPath(host.path, stop);
    const blend = beads.length > 0 && strokes.length === 0 ? rng.pick(beads) : 'pool';
    const tool = options.tools.includes(blend) ? blend : host.mark.tool;
    const radius = host.mark.width * shortEdge * rng.range(0.75, 1.4);
    // a knot on a stroke is itself a short stroke - a curve is three control
    // points and a streak is two, and a mark that broke either contract would
    // stop being the tool it says it is
    const points = STROKE_TOOLS.includes(tool)
      ? strokePath(rng, at, rng.range(-Math.PI, Math.PI), radius * 1.4, rng.range(-0.7, 0.7), tool).map(toUV)
      : [toUV(at)];
    marks.push({
      role: 'node',
      tool,
      points,
      width: clampWidth(radius),
      alpha: round(rng.range(0.45, 0.8), 3),
      wetness: round(wetness(), 3),
      seed: rng.seed32(),
    });
    left--;
  }

  // The texture does not make the blot, it is what the paper's tooth did to it:
  // a speckle over the finished mass, or a lift of pigment back out of it. It
  // goes on last because that is when a spray or a blot would land.
  if (textureSlot > 0 && texture) {
    const spread = marks.reduce((widest, mark) => {
      const radius = mark.width * shortEdge;
      const reach = mark.points.reduce((far, point) => Math.max(far, Math.hypot(point.x * spec.width - core.x, point.y * spec.height - core.y)), 0);
      return Math.max(widest, reach + radius);
    }, 0);
    marks.push({
      role: 'texture',
      tool: texture,
      points: [toUV(core)],
      width: clampWidth(spread * (texture === 'backrun' ? 0.4 : 0.34) * rng.range(0.85, 1.15)),
      alpha: round(texture === 'backrun' ? rng.range(0.3, 0.5) : rng.range(0.16, 0.3), 3),
      wetness: round(wetness(), 3),
      seed: rng.seed32(),
    });
  }

  const trimmed = marks.length > budget ? marks.slice(0, budget) : marks;
  return { kind, core: toUV(core), coreWidth: round(coreRadius / shortEdge, 4), marks: trimmed };
}

/**
 * The body of the blot.
 *
 * A blob tool pools where it was pressed. A mood with nothing but strokes gets
 * a body all the same, drawn with the widest stroke it has: a short fat comma
 * the limbs then grow out of, which is what a brush loaded with ink leaves
 * behind anyway.
 */
function coreMark(
  rng: Rng,
  options: { tool: InkToolId; at: Px; radius: number; wetness: number },
  toUV: (at: Px) => UV,
  clampWidth: (radius: number) => number,
): FormMark {
  const { tool, at, radius } = options;
  const base = {
    role: 'core' as FormRole,
    tool,
    width: clampWidth(radius),
    alpha: round(rng.range(0.82, 1), 3),
    wetness: round(options.wetness, 3),
    seed: rng.seed32(),
  };
  if (tool === 'curve') {
    // a curve needs three control points to be a curve: a knot of them sits
    // where the body is, turning hard enough to close back on itself
    const points: UV[] = [toUV(at)];
    let heading = rng.range(-Math.PI, Math.PI);
    let cursor = at;
    for (let i = 0; i < 3; i++) {
      heading += rng.range(1.1, 1.9);
      cursor = walk(cursor, heading, radius * rng.range(0.7, 0.95));
      points.push(toUV(cursor));
    }
    return { ...base, points };
  }
  if (tool === 'streak' || tool === 'drag') {
    // a stroke body runs both ways from its centre, so the limbs leave the
    // middle of the mass rather than one end of it
    const heading = rng.range(-Math.PI, Math.PI);
    return {
      ...base,
      points: [toUV(walk(at, heading + Math.PI, radius * 0.55)), toUV(walk(at, heading, radius))],
    };
  }
  return { ...base, points: [toUV(at)] };
}

/**
 * Which stroke a limb is laid with.
 *
 * Drag is the last of them and never more than two on a sheet: a drag rakes its
 * own path with bristle marks, which is beautiful once and busy three times.
 * The cap shapes the mix rather than walling a limb off - a blot that has spent
 * its drags still gets its limb, drawn with the next tool down.
 */
function pickLimbTool(rng: Rng, strokes: readonly InkToolId[], used: readonly FormMark[]): InkToolId {
  const drags = used.filter((mark) => mark.tool === 'drag').length;
  const allowed = strokes.filter((tool) => tool !== 'drag' || drags < 2);
  const list = allowed.length > 0 ? allowed : strokes;
  // curve lays the longest, smoothest line, so it leads; drag trails both
  const weight = (tool: InkToolId): number => (tool === 'curve' ? 1.3 : tool === 'streak' ? 1 : 0.55);
  const total = list.reduce((sum, tool) => sum + weight(tool), 0);
  let roll = rng.next() * total;
  for (const tool of list) {
    roll -= weight(tool);
    if (roll <= 0) return tool;
  }
  return list[list.length - 1]!;
}
