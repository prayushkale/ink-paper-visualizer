import { foldGeometry } from './fold-math';
import { paintBeats, type PaintBeat } from './paintReel';
import { renderOps } from './recipe';
import { createRng, clamp, round, type Rng } from './rng';
import type { CanvasSpec, DropOptions, Fold, InkOp, InkRecipe, UV } from './types';

export const CANVAS_SIZE = 1024;

/**
 * The sheet is pure white, not a warm paper tone.
 *
 * A fold prints the moving flap back over the far half with `multiply`, and
 * that blend cannot tell ink from paper: against a tinted sheet every crease
 * multiplies the tint by itself and the blot turns up with darker patches at
 * the folds, as if the fold were dirt. Against white the same maths only ever
 * deepens ink, which is what a fold is supposed to show.
 */
export const PAPER_COLOR = '#ffffff';

/**
 * Nothing smaller than this reads as a drop; below it the mark is dust, and a
 * page of dust is not a blot.
 */
const MIN_MARK_PX = 2.5;

/** PAPER_COLOR at zero alpha, so a bloom fades into the sheet whatever the sheet is. */
function paperFade(): string {
  const hex = PAPER_COLOR.replace('#', '');
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, 0)`;
}

export function clampDropRadius(radius: number): number {
  return clamp(radius, 10, 120);
}

/** Fraction of the short edge a UV width represents, in pixels. */
export function uvToPixels(width: number, spec: CanvasSpec): number {
  return width * Math.min(spec.width, spec.height);
}

/** Walks a polyline, stamping circles with a varying radius: a tapered stroke. */
function stampPath(
  ctx: CanvasRenderingContext2D,
  points: readonly UV[],
  spec: CanvasSpec,
  widthPx: number,
  options: { taper?: number; wobble?: number; rng?: () => number; spacing?: number; rampTo?: number } = {},
): void {
  const taper = options.taper ?? 0.35;
  const wobble = options.wobble ?? 0;
  const rng = options.rng ?? (() => 0.5);
  const spacing = options.spacing ?? 0.25;
  const rampTo = options.rampTo;
  const scaled = points.map((p) => ({ x: p.x * spec.width, y: p.y * spec.height }));
  if (scaled.length === 0) return;
  if (scaled.length === 1) {
    ctx.beginPath();
    ctx.arc(scaled[0]!.x, scaled[0]!.y, widthPx, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let travelled = 0;
  let total = 0;
  for (let i = 1; i < scaled.length; i++) {
    total += Math.hypot(scaled[i]!.x - scaled[i - 1]!.x, scaled[i]!.y - scaled[i - 1]!.y);
  }
  if (total === 0) total = 1;
  for (let i = 1; i < scaled.length; i++) {
    const from = scaled[i - 1]!;
    const to = scaled[i]!;
    const segment = Math.hypot(to.x - from.x, to.y - from.y);
    // A brush runs out of ink: toward the far end of a tapering limb the stamps
    // spread out and the stroke breaks into flecks, which is what a stroke's
    // tail looks like and what a hard-edged polygon of a protrusion is not.
    const thinning = rampTo === undefined ? 1 : 1 + (1 - clamp(rampTo, 0, 1)) * (travelled / total) * 1.5;
    const steps = Math.max(1, Math.ceil((segment * thinning) / Math.max(1, widthPx * spacing)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      travelled += segment / steps;
      const progress = travelled / total;
      // fat in the middle, thin at the ends unless taper is 0
      const profile = taper === 0 ? 1 : 1 - taper * Math.abs(progress * 2 - 1) ** 1.4;
      // A limb thins as it is pulled away from the body, so a mark may be given
      // the width it has at its own far end. Undefined leaves the symmetric
      // profile to decide, which is what a mark that is not a limb wants.
      const ramp = rampTo === undefined ? 1 : 1 + (rampTo - 1) * progress;
      const jitter = wobble === 0 ? 0 : (rng() - 0.5) * wobble * widthPx;
      const radius = Math.max(0.4, widthPx * profile * ramp * (1 - wobble / 2) + jitter);
      ctx.beginPath();
      ctx.arc(x + jitter * 0.5, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * A closed, lobed outline: the edge a mark actually took on the sheet.
 *
 * A mark drawn as a circle reads as a soft airbrushed dot, which is not what
 * ink does on paper - the edge of a pool is uneven, with broad lobes where it
 * spread and a finer wobble where the sheet's tooth caught it. The harmonics
 * are low and few, so the outline stays a mark rather than turning into frills.
 */
function blobPath(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rng: Rng, lobes = 3): void {
  const waves: Array<{ k: number; amp: number; phase: number }> = [];
  for (let i = 0; i < lobes; i++) {
    // k starts at 2: a k = 1 wave would only shift the whole mark sideways
    waves.push({ k: i + 2, amp: rng.range(0.05, 0.17) / (i + 1), phase: rng.range(0, Math.PI * 2) });
  }
  // Two finer octaves on top of the lobes: what the sheet's own grain does to
  // the boundary. Without them the outline is a smooth curve and the mark reads
  // as an airbrushed dot however good its tonality is.
  const fibres = [
    { k: rng.int(7, 13), amp: rng.range(0.03, 0.055), phase: rng.range(0, Math.PI * 2) },
    { k: rng.int(15, 26), amp: rng.range(0.012, 0.024), phase: rng.range(0, Math.PI * 2) },
  ];
  // A droplet is a few pixels across, so a ripple that reads as a fibre on a
  // pool reads as nothing on it: small marks are roughened instead, which is
  // what stops the specks around a blot looking like perfect circles.
  const coarsen = clamp(16 / Math.max(radius, 1), 1, 2.6);
  const ampScale = Math.min(coarsen, 0.5 / Math.max(0.001, [...waves, ...fibres].reduce((sum, wave) => sum + wave.amp, 0)));
  for (const wave of [...waves, ...fibres]) wave.amp *= ampScale;
  // A small mark needs fewer turns of the outline than a large one does, and at
  // thumbnail size the difference is invisible either way.
  const steps = Math.round(clamp(radius * 1.4, 32, 160));
  ctx.beginPath();
  for (let step = 0; step <= steps; step++) {
    const turn = (step / steps) * Math.PI * 2;
    let reach = 1;
    for (const wave of waves) reach += wave.amp * Math.cos(wave.k * turn + wave.phase);
    for (const fibre of fibres) reach += fibre.amp * Math.cos(fibre.k * turn + fibre.phase);
    const px = x + Math.cos(turn) * radius * reach;
    const py = y + Math.sin(turn) * radius * reach;
    if (step === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * One mark of ink, the way pigment sits on paper.
 *
 * Four passes, because a mark does four things: its pigment creeps past its own
 * edge into damp paper, its body takes the edge the ink actually left, the body
 * is denser where the brush came to rest, and a few droplets sit on that edge.
 * A mark drawn as one flat circle reads as airbrush; every inkblot worth
 * looking at is edge, density and spatter. The caller owns the composite
 * operation: this is pigment, so it is laid down with `multiply`.
 */
function drawInkBody(
  ctx: CanvasRenderingContext2D,
  mark: { center: UV; radius: number; color: string; alpha: number; wetness: number; spec: CanvasSpec; rng: Rng; lobes?: number; grit?: number },
): void {
  const x = mark.center.x * mark.spec.width;
  const y = mark.center.y * mark.spec.height;
  const radius = Math.max(MIN_MARK_PX, mark.radius);
  const rng = mark.rng;
  const previousAlpha = ctx.globalAlpha;
  const base = clamp(mark.alpha, 0.02, 1);
  const lobes = mark.lobes ?? 3;
  ctx.fillStyle = mark.color;
  const pools = (count: number, minSize: number, maxSize: number, minSpread: number, maxSpread: number, alpha: number): void => {
    for (let i = 0; i < count; i++) {
      const turn = i === 0 ? 0 : rng.range(0, Math.PI * 2);
      const distance = i === 0 ? 0 : radius * rng.range(minSpread, maxSpread);
      ctx.globalAlpha = clamp(alpha, 0.02, 1);
      blobPath(
        ctx,
        x + Math.cos(turn) * distance,
        y + Math.sin(turn) * distance,
        radius * rng.range(minSize, maxSize),
        rng,
        i % 2 === 0 ? lobes : 2,
      );
      ctx.fill();
    }
  };

  // The bleed: an uneven fringe of pale wisps, closer on some sides than others.
  // Pigment creeps into paper the way the paper lets it, so this may not be a
  // ring - a ring is the first thing that says the mark was drawn, not poured.
  const wisps = 5 + Math.round(mark.wetness * 9) + (mark.grit === 0 ? -2 : 0);
  for (let i = 0; i < wisps; i++) {
    const turn = rng.range(0, Math.PI * 2);
    const distance = radius * (rng.bool(0.62) ? rng.range(0.86, 1.18) : rng.range(1.12, 1.48));
    ctx.globalAlpha = clamp(base * rng.range(0.05, 0.16), 0.02, 1);
    blobPath(
      ctx,
      x + Math.cos(turn) * distance,
      y + Math.sin(turn) * distance,
      radius * rng.range(0.1, 0.34),
      rng,
      3,
    );
    ctx.fill();
  }

  // The body: two pools of much the same size, well apart, laid as flat
  // pigment. Tone comes out of where they overlap and multiply, not out of a
  // radial gradient inside them - a mark shaded by a gradient is a set of
  // concentric rings, which is what a topographic map looks like and what a
  // stain does not.
  pools(2, 0.7, 1, 0.2, 0.5, base * 0.62);

  // Granulation: pigment settles unevenly, so the body is mottled rather than
  // evenly toned. A couple of quirks of tone is all it takes - more and the mark
  // turns into noise, which is a different failure.
  pools(2 + Math.round(mark.wetness * 2), 0.16, 0.4, 0.1, 0.62, base * rng.range(0.1, 0.2));

  // Its heart, two smaller pools laid inside the body: ink is densest where the
  // brush came to rest, and the multiply that makes is the difference between a
  // drawn shape and a mark that was actually made.
  pools(2, 0.36, 0.58, 0.05, 0.24, base * 0.6);

  // And the grit: droplets sitting on the boundary, never beyond it. A droplet
  // that clears the mark it came off is debris, and a blot's edge may be broken
  // by droplets but must not be sprinkled with anything that is not touching it.
  const grit = mark.grit ?? Math.round(3 + mark.wetness * 5);
  for (let i = 0; i < grit; i++) {
    const turn = rng.range(0, Math.PI * 2);
    const distance = radius * rng.range(0.82, 1.04);
    ctx.globalAlpha = clamp(base * rng.range(0.18, 0.45), 0.02, 1);
    blobPath(ctx, x + Math.cos(turn) * distance, y + Math.sin(turn) * distance, Math.max(MIN_MARK_PX, radius * rng.range(0.03, 0.075)), rng, 2);
    ctx.fill();
  }
  // A wet mark throws a speck or two clear of itself, and a blot with a few of
  // them in the white reads as ink that landed rather than as ink that was
  // drawn - but only a few, and only off a mark that was actually wet.
  const thrown = mark.grit === 0 || mark.wetness <= 0.45 ? 0 : rng.int(0, 2);
  for (let i = 0; i < thrown; i++) {
    const turn = rng.range(0, Math.PI * 2);
    const distance = radius * rng.range(1.06, 1.34);
    ctx.globalAlpha = clamp(base * rng.range(0.3, 0.6), 0.02, 1);
    blobPath(ctx, x + Math.cos(turn) * distance, y + Math.sin(turn) * distance, Math.max(MIN_MARK_PX, radius * rng.range(0.025, 0.065)), rng, 2);
    ctx.fill();
  }
  ctx.globalAlpha = previousAlpha;
}

/**
 * The wash a limb leaves either side of itself.
 *
 * A wet stroke carries pigment out into the paper around it, so a limb that is
 * nothing but a taper looks cut out of the page instead of drawn on it. This is
 * that halo: the same path, a little wider and much fainter.
 */
function washAlong(
  ctx: CanvasRenderingContext2D,
  points: readonly UV[],
  spec: CanvasSpec,
  widthPx: number,
  alpha: number,
  wetness: number,
  rampTo: number | undefined,
  rng: Rng,
): void {
  if (wetness <= 0.25) return;
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = clamp(alpha * 0.22, 0.02, 1);
  stampPath(ctx, points, spec, widthPx * (1.5 + wetness * 0.6), { taper: 0.35, rampTo, spacing: 0.3, rng: rng.next });
  ctx.globalAlpha = previous;
}

/** A soft-edged bloom: pigment sitting in a wet pool. */
function drawPool(ctx: CanvasRenderingContext2D, center: UV, spec: CanvasSpec, radiusPx: number, color: string, alpha: number): void {
  const x = center.x * spec.width;
  const y = center.y * spec.height;
  const gradient = ctx.createRadialGradient(x, y, radiusPx * 0.1, x, y, radiusPx);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.62, color);
  gradient.addColorStop(1, paperFade());
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = previousAlpha;
}

/** Deterministic paper grain, multiplied over the dried pigment. */
function drawGrain(ctx: CanvasRenderingContext2D, spec: CanvasSpec, amount: number, seed: number): void {
  if (amount <= 0) return;
  const rng = createRng(seed ^ 0x5bf03635);
  const tiles = 2600;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  // neutral, because a tinted fleck would tint the white sheet it sits on
  ctx.fillStyle = '#d9d9d9';
  for (let i = 0; i < tiles; i++) {
    const x = rng.next() * spec.width;
    const y = rng.next() * spec.height;
    const size = rng.range(0.6, 2.4);
    ctx.globalAlpha = rng.range(0.02, 0.09) * (0.4 + amount);
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

/**
 * The sheet's tooth, showing as light flecks in the pigment.
 *
 * A screen pass rather than another multiply: screening a neutral near-white
 * over white paper is a no-op, so this can only ever lighten ink and can never
 * tint the sheet - which is why it is safe where a tinted fleck would not be.
 * The grain that is already pressed in with multiply darkens; this is the other
 * half of the same texture, and it is what makes a filled mark read as pigment
 * sitting in the paper rather than as a shape.
 */
function drawTooth(ctx: CanvasRenderingContext2D, spec: CanvasSpec, amount: number, seed: number): void {
  if (amount <= 0) return;
  const rng = createRng(seed ^ 0x1b873593);
  const tiles = 2200;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < tiles; i++) {
    const x = rng.next() * spec.width;
    const y = rng.next() * spec.height;
    const size = rng.range(0.7, 2.6);
    ctx.globalAlpha = rng.range(0.03, 0.11) * (0.4 + amount);
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

/**
 * The offscreen canvas is the single source of truth for a painting.
 *
 * Manual mode paints onto it directly; the automatic engine replays a recipe's
 * op log onto it. Both then run the same fold commit, so a hand-folded blot and
 * a generated one are produced by identical physics.
 */
export class Paper {
  readonly canvas: HTMLCanvasElement;
  readonly spec: CanvasSpec;
  private ctx: CanvasRenderingContext2D;

  constructor(spec: CanvasSpec = { width: CANVAS_SIZE, height: CANVAS_SIZE }) {
    this.spec = { ...spec };
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.spec.width;
    this.canvas.height = this.spec.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.clear();
  }

  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = PAPER_COLOR;
    this.ctx.fillRect(0, 0, this.spec.width, this.spec.height);
  }

  /** Replays a whole recipe: paint, then fold, then grain. */
  render(recipe: InkRecipe): void {
    this.renderInStages(recipe, () => {});
  }

  /**
   * Replays a recipe a beat at a time, reporting after each one.
   *
   * `render` is this with the beats dropped, so the painting a viewer watches
   * and the painting the vision model is shown are the same pass in the same
   * order: a show can never drift from the picture it is showing.
   */
  renderInStages(recipe: InkRecipe, onBeat: (beat: PaintBeat) => void): void {
    this.clear();
    const ops = renderOps(recipe);
    let next = 0;
    for (const beat of paintBeats(recipe)) {
      if (beat.kind === 'ink') {
        const op = ops[next++];
        if (op) this.applyOp(op);
      } else if (beat.kind === 'fold-print' && beat.fold) {
        this.commitFold(beat.fold);
      } else if (beat.kind === 'grain') {
        drawGrain(this.ctx, this.spec, recipe.grain, recipe.seed);
        drawTooth(this.ctx, this.spec, recipe.grain, recipe.seed);
      }
      onBeat(beat);
    }
  }

  /** Executes an op log. Pure with respect to the canvas: same ops, same ink. */
  applyOps(ops: InkOp[]): void {
    for (const op of ops) this.applyOp(op);
  }

  applyOp(op: InkOp): void {
    const widthPx = Math.max(0.6, uvToPixels(op.width, this.spec));
    const rng = createRng(op.seed || 1);
    this.ctx.save();
    this.ctx.globalAlpha = clamp(op.alpha, 0.02, 1);
    this.ctx.fillStyle = op.color;
    // pigment multiplies rather than covers, so overlaps deepen
    this.ctx.globalCompositeOperation = op.tool === 'backrun' ? 'source-over' : 'multiply';
    const first = op.points[0] ?? { x: 0.5, y: 0.5 };
    switch (op.tool) {
      case 'drop': {
        const radius = widthPx * rng.range(0.88, 1.15);
        drawInkBody(this.ctx, { center: first, radius, color: op.color, alpha: op.alpha, wetness: op.wetness, spec: this.spec, rng, lobes: 2 });
        // lobes that touch the body: ink that bulged where it landed, never a
        // satellite of its own, which is what broke the edge of the old drop
        for (let i = 0; i < 3; i++) {
          const angle = rng.range(0, Math.PI * 2);
          const distance = radius * rng.range(0.55, 0.9);
          const lobe = { x: first.x + (Math.cos(angle) * distance) / this.spec.width, y: first.y + (Math.sin(angle) * distance) / this.spec.height };
          this.ctx.globalAlpha = clamp(op.alpha * 0.85, 0.02, 1);
          this.ctx.fillStyle = op.color;
          blobPath(this.ctx, lobe.x * this.spec.width, lobe.y * this.spec.height, Math.max(MIN_MARK_PX, radius * rng.range(0.25, 0.5)), rng, 2);
          this.ctx.fill();
        }
        break;
      }
      case 'splatter': {
        this.ctx.globalAlpha = clamp(op.alpha, 0.02, 1);
        stampPath(this.ctx, [first], this.spec, widthPx, { rng: rng.next });
        const droplets = Math.round(6 + op.wetness * 40);
        for (let i = 0; i < droplets; i++) {
          const angle = rng.range(0, Math.PI * 2);
          // thrown a little way clear of the blob: a splat, not a spray of dust
          const distance = widthPx * rng.range(1.05, 1.5 + op.wetness * 1.1);
          const radius = Math.max(MIN_MARK_PX, widthPx * rng.range(0.1, 0.28));
          const x = first.x * this.spec.width + Math.cos(angle) * distance;
          const y = first.y * this.spec.height + Math.sin(angle) * distance;
          this.ctx.globalAlpha = clamp(op.alpha * rng.range(0.35, 1), 0.02, 1);
          this.ctx.beginPath();
          this.ctx.arc(x, y, radius, 0, Math.PI * 2);
          this.ctx.fill();
        }
        break;
      }
      case 'streak': {
        washAlong(this.ctx, op.points, this.spec, widthPx, op.alpha, op.wetness, op.rampTo, rng);
        this.ctx.globalAlpha = clamp(op.alpha, 0.02, 1);
        stampPath(this.ctx, op.points, this.spec, widthPx, { taper: 0.42, wobble: 0.12, rng: rng.next, rampTo: op.rampTo });
        break;
      }
      case 'curve': {
        washAlong(this.ctx, op.points, this.spec, widthPx, op.alpha, op.wetness, op.rampTo, rng);
        this.ctx.globalAlpha = clamp(op.alpha, 0.02, 1);
        stampPath(this.ctx, op.points, this.spec, widthPx, { taper: 0.3, wobble: 0.22, rng: rng.next, spacing: 0.18, rampTo: op.rampTo });
        break;
      }
      case 'pool': {
        drawInkBody(this.ctx, { center: first, radius: widthPx, color: op.color, alpha: op.alpha, wetness: op.wetness, spec: this.spec, rng, lobes: 3 });
        break;
      }
      case 'drag': {
        washAlong(this.ctx, op.points, this.spec, widthPx, op.alpha, op.wetness, op.rampTo, rng);
        this.ctx.globalAlpha = clamp(op.alpha, 0.02, 1);
        stampPath(this.ctx, op.points, this.spec, widthPx, { taper: 0.1, wobble: 0.35, rng: rng.next, spacing: 0.14, rampTo: op.rampTo });
        // trailing rake marks perpendicular to the drag
        const [from, to] = [op.points[0]!, op.points[op.points.length - 1]!];
        const dx = (to.x - from.x) * this.spec.width;
        const dy = (to.y - from.y) * this.spec.height;
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length;
        const ny = dx / length;
        const rakes = Math.round(4 + op.wetness * 10);
        for (let i = 0; i < rakes; i++) {
          const t = rng.next();
          const offset = rng.range(-widthPx, widthPx);
          const x = from.x * this.spec.width + dx * t + nx * offset;
          const y = from.y * this.spec.height + dy * t + ny * offset;
          this.ctx.globalAlpha = clamp(op.alpha * rng.range(0.15, 0.5), 0.02, 1);
          this.ctx.beginPath();
          this.ctx.arc(x, y, Math.max(MIN_MARK_PX, widthPx * rng.range(0.12, 0.36)), 0, Math.PI * 2);
          this.ctx.fill();
        }
        break;
      }
      case 'spray': {
        // more wetness buys fatter spatter rather than more of it: a thousand
        // pinpricks is dust, and dust is not what a blot is made of
        const dots = Math.round(40 + op.wetness * 80);
        for (let i = 0; i < dots; i++) {
          const angle = rng.range(0, Math.PI * 2);
          // sqrt keeps the scatter even instead of crowded at the centre
          const distance = Math.sqrt(rng.next()) * widthPx;
          const x = first.x * this.spec.width + Math.cos(angle) * distance;
          const y = first.y * this.spec.height + Math.sin(angle) * distance;
          this.ctx.globalAlpha = clamp(op.alpha * rng.range(0.15, 0.8), 0.02, 1);
          this.ctx.beginPath();
          // the scatter's dots scale with the spray: a fat spray leaves fat spatter
          this.ctx.arc(x, y, Math.max(MIN_MARK_PX, widthPx * rng.range(0.045, 0.1)), 0, Math.PI * 2);
          this.ctx.fill();
        }
        break;
      }
      case 'backrun': {
        // lifting pigment back toward the paper: paint paper colour softly
        this.ctx.fillStyle = PAPER_COLOR;
        drawPool(this.ctx, first, this.spec, widthPx * 1.4, PAPER_COLOR, clamp(op.alpha * (0.35 + op.wetness * 0.4), 0.02, 0.85));
        break;
      }
      default:
        stampPath(this.ctx, op.points, this.spec, widthPx, { rng: rng.next });
    }
    this.ctx.restore();
  }

  /**
   * Single interactive drop, for hand painting.
   *
   * One gesture is one mark. This used to be drawn through the recipe's own
   * `splatter` op, which throws a ring of up to forty droplets clear of the blob:
   * a click of the brush came out as a spray of circles where the user aimed
   * once. It goes through the engine's own ink body now - the same wash, edge
   * and density a generated mark gets - with the spatter switched off, so the
   * wetness goes into how far the pigment creeps past its own edge rather than
   * into how many marks there are.
   */
  paintDrop(u: number, v: number, opt: DropOptions, seed = 1): void {
    const radiusPx = clampDropRadius(opt.radius);
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';
    // The dab is drawn by the same hand the engine's own marks are, so a
    // hand-painted blot and a generated one are the same medium - but its
    // spatter is off: one gesture is one mark, and edge droplets here are the
    // "lot of circles" a brush click used to leave behind.
    drawInkBody(this.ctx, {
      center: { x: u, y: v },
      radius: radiusPx,
      color: opt.color,
      alpha: 0.92,
      wetness: opt.wetness,
      spec: this.spec,
      rng: createRng(seed),
      lobes: 2,
      grit: 0,
    });
    this.ctx.restore();
  }

  /**
   * Commits a fold: the moving flap is mirrored about the crease and printed
   * onto the far side. With multiply blending the overlap deepens, exactly like
   * wet ink transferring to the facing half.
   */
  commitFold(fold: Fold): void {
    const geometry = foldGeometry(fold);
    const { width, height } = this.spec;
    const sx = geometry.source.x * width;
    const sy = geometry.source.y * height;
    const sw = Math.max(1, Math.round(geometry.source.w * width));
    const sh = Math.max(1, Math.round(geometry.source.h * height));

    const snapshot = document.createElement('canvas');
    snapshot.width = sw;
    snapshot.height = sh;
    const snapCtx = snapshot.getContext('2d')!;
    snapCtx.drawImage(this.canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const targetX = geometry.dest.x * width;
    const targetY = geometry.dest.y * height;
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'multiply';
    this.ctx.globalAlpha = 0.96;
    this.ctx.translate(
      geometry.dest.flipX ? targetX + sw : targetX,
      geometry.dest.flipY ? targetY + sh : targetY,
    );
    this.ctx.scale(geometry.dest.flipX ? -1 : 1, geometry.dest.flipY ? -1 : 1);
    this.ctx.drawImage(snapshot, 0, 0);
    this.ctx.restore();
  }

  /** PNG data URI, for the OpenRouter vision payload. */
  toDataUri(type = 'image/png', quality = 0.92): string {
    return this.canvas.toDataURL(type, quality);
  }

  /** Encoded PNG for fal storage upload. */
  toBlob(type = 'image/png', quality = 0.92): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no blob'))),
        type,
        quality,
      );
    });
  }
}
