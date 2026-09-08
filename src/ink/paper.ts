import type { DropOptions, Fold } from '../state';

export const CANVAS_SIZE = 1024;

export interface Halves {
  sourceX: number; sourceY: number;  // top-left of source half (UV)
  targetX: number; targetY: number;  // top-left of target half (UV)
  width: number; height: number;     // half size (UV)
}

/** Which half moves (source) and which is printed onto (target). */
export function foldHalves(fold: Fold): Halves {
  if (fold.axis === 'vertical') {
    const src = fold.direction === 'left' ? 0 : 0.5;
    const tgt = fold.direction === 'left' ? 0.5 : 0;
    return { sourceX: src, sourceY: 0, targetX: tgt, targetY: 0, width: 0.5, height: 1 };
  }
  const src = fold.direction === 'top' ? 0 : 0.5;
  const tgt = fold.direction === 'top' ? 0.5 : 0;
  return { sourceX: 0, sourceY: src, targetX: 0, targetY: tgt, width: 1, height: 0.5 };
}

export function clampDropRadius(r: number): number {
  return Math.min(120, Math.max(10, r));
}

const INK_ALPHA = 0.92;

export class Paper {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.clear();
  }

  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#f4efe6';          // warm paper
    this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  /**
   * Drop ink at UV (0-1, origin top-left). Main blob + wetness splatter.
   */
  paintDrop(u: number, v: number, opt: DropOptions): void {
    const x = u * CANVAS_SIZE;
    const y = v * CANVAS_SIZE;
    const r = clampDropRadius(opt.radius);
    this.ctx.globalAlpha = INK_ALPHA;
    this.ctx.fillStyle = opt.color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.6 + Math.random() * 0.5);
      const rr = r * (0.25 + Math.random() * 0.4);
      this.ctx.beginPath();
      this.ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rr, 0, Math.PI * 2);
      this.ctx.fill();
    }
    if (opt.wetness > 0) {
      const n = Math.floor(4 + opt.wetness * 24);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = r * (1.2 + Math.random() * (1 + opt.wetness * 2));
        const rr = 1 + Math.random() * r * 0.15;
        this.ctx.beginPath();
        this.ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rr, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
    this.ctx.globalAlpha = 1;
  }

  /**
   * Commit a fold: blit the source half mirrored onto the target half.
   * Snapshot first so the target cannot partially overwrite the source.
   */
  commitFold(fold: Fold): void {
    const h = foldHalves(fold);
    const S = CANVAS_SIZE;
    const sx = h.sourceX * S, sy = h.sourceY * S;
    const tx = h.targetX * S, ty = h.targetY * S;
    const w = h.width * S, hh = h.height * S;
    const snap = document.createElement('canvas');
    snap.width = w; snap.height = hh;
    const sctx = snap.getContext('2d')!;
    sctx.drawImage(this.canvas, sx, sy, w, hh, 0, 0, w, hh);
    this.ctx.save();
    if (fold.axis === 'vertical') {
      this.ctx.translate(tx + w, ty);
      this.ctx.scale(-1, 1);
      this.ctx.drawImage(snap, 0, 0);
    } else {
      this.ctx.translate(tx, ty + hh);
      this.ctx.scale(1, -1);
      this.ctx.drawImage(snap, 0, 0);
    }
    this.ctx.restore();
  }

  /** PNG data URI for OpenRouter vision + FAL image_url. */
  toDataUri(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Decoded blob size in bytes (must stay < 5MB for FAL data URIs). */
  async byteSize(): Promise<number> {
    const blob = await new Promise<Blob>((res) => this.canvas.toBlob(res, 'image/png')!);
    return blob.size;
  }
}
