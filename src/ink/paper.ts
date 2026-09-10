import { foldGeometry } from './fold-math';
import { renderOps } from './recipe';
import { createRng, clamp } from './rng';
import type { CanvasSpec, DropOptions, Fold, InkOp, InkRecipe, UV } from './types';

export const CANVAS_SIZE = 1024;
export const PAPER_COLOR = '#f4efe6';

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
  points: UV[],
  spec: CanvasSpec,
  widthPx: number,
  options: { taper?: number; wobble?: number; rng?: () => number; spacing?: number } = {},
): void {
  const taper = options.taper ?? 0.35;
  const wobble = options.wobble ?? 0;
  const rng = options.rng ?? (() => 0.5);
  const spacing = options.spacing ?? 0.25;
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
    const steps = Math.max(1, Math.ceil(segment / Math.max(1, widthPx * spacing)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      travelled += segment / steps;
      const progress = travelled / total;
      // fat in the middle, thin at the ends unless taper is 0
      const profile = taper === 0 ? 1 : 1 - taper * Math.abs(progress * 2 - 1) ** 1.4;
      const jitter = wobble === 0 ? 0 : (rng() - 0.5) * wobble * widthPx;
      const radius = Math.max(0.4, widthPx * profile * (1 - wobble / 2) + jitter);
      ctx.beginPath();
      ctx.arc(x + jitter * 0.5, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A soft-edged bloom: pigment sitting in a wet pool. */
function drawPool(ctx: CanvasRenderingContext2D, center: UV, spec: CanvasSpec, radiusPx: number, color: string, alpha: number): void {
  const x = center.x * spec.width;
  const y = center.y * spec.height;
  const gradient = ctx.createRadialGradient(x, y, radiusPx * 0.1, x, y, radiusPx);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.62, color);
  gradient.addColorStop(1, 'rgba(244,239,230,0)');
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
  ctx.fillStyle = '#cfc7b6';
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
    this.clear();
    this.applyOps(renderOps(recipe));
    for (const fold of recipe.folds) this.commitFold(fold);
    drawGrain(this.ctx, this.spec, recipe.grain, recipe.seed);
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
        stampPath(this.ctx, [first], this.spec, widthPx * rng.range(0.85, 1.15), { rng: rng.next });
        // a couple of satellite lobes so the edge is never a perfect circle
        for (let i = 0; i < 3; i++) {
          const angle = rng.range(0, Math.PI * 2);
          const distance = widthPx * rng.range(0.5, 0.95);
          const lobe = { x: first.x + (Math.cos(angle) * distance) / this.spec.width, y: first.y + (Math.sin(angle) * distance) / this.spec.height };
          this.ctx.globalAlpha = clamp(op.alpha * 0.7, 0.02, 1);
          stampPath(this.ctx, [lobe], this.spec, widthPx * rng.range(0.25, 0.5), { rng: rng.next });
        }
        break;
      }
      case 'splatter': {
        this.ctx.globalAlpha = clamp(op.alpha, 0.02, 1);
        stampPath(this.ctx, [first], this.spec, widthPx, { rng: rng.next });
        const droplets = Math.round(6 + op.wetness * 40);
        for (let i = 0; i < droplets; i++) {
          const angle = rng.range(0, Math.PI * 2);
          const distance = widthPx * rng.range(1.05, 1.6 + op.wetness * 2.4);
          const radius = Math.max(0.5, widthPx * rng.range(0.03, 0.2) * (1 - op.wetness * 0.3));
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
        stampPath(this.ctx, op.points, this.spec, widthPx, { taper: 0.55, wobble: 0.12, rng: rng.next });
        break;
      }
      case 'curve': {
        stampPath(this.ctx, op.points, this.spec, widthPx, { taper: 0.3, wobble: 0.22, rng: rng.next, spacing: 0.18 });
        // a wet curve leaves a halo
        if (op.wetness > 0.35) {
          this.ctx.globalAlpha = clamp(op.alpha * 0.25, 0.02, 1);
          stampPath(this.ctx, op.points, this.spec, widthPx * (1.6 + op.wetness), { taper: 0.4, rng: rng.next });
        }
        break;
      }
      case 'pool': {
        drawPool(this.ctx, first, this.spec, widthPx, op.color, clamp(op.alpha, 0.02, 1));
        break;
      }
      case 'drag': {
        stampPath(this.ctx, op.points, this.spec, widthPx, { taper: 0.1, wobble: 0.35, rng: rng.next, spacing: 0.14 });
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
          this.ctx.arc(x, y, Math.max(0.5, widthPx * rng.range(0.05, 0.22)), 0, Math.PI * 2);
          this.ctx.fill();
        }
        break;
      }
      case 'spray': {
        const dots = Math.round(40 + op.wetness * 160);
        for (let i = 0; i < dots; i++) {
          const angle = rng.range(0, Math.PI * 2);
          // sqrt keeps the scatter even instead of crowded at the centre
          const distance = Math.sqrt(rng.next()) * widthPx;
          const x = first.x * this.spec.width + Math.cos(angle) * distance;
          const y = first.y * this.spec.height + Math.sin(angle) * distance;
          this.ctx.globalAlpha = clamp(op.alpha * rng.range(0.15, 0.8), 0.02, 1);
          this.ctx.beginPath();
          this.ctx.arc(x, y, Math.max(0.4, rng.range(0.5, 2.6)), 0, Math.PI * 2);
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

  /** Single interactive drop, for hand painting. */
  paintDrop(u: number, v: number, opt: DropOptions): void {
    this.applyOp({
      tool: 'splatter',
      points: [{ x: u, y: v }],
      width: clampDropRadius(opt.radius) / Math.min(this.spec.width, this.spec.height),
      color: opt.color,
      alpha: 0.92,
      wetness: opt.wetness,
      seed: Math.floor(Math.random() * 0xffffffff),
    });
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
