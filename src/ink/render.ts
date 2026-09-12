import { Paper } from './paper';
import { creaseLine } from './fold-math';
import { paintBeats, paintFrames, type PaintFrame } from './paintReel';
import type { Fold, InkRecipe } from './types';

export interface RenderedBlot {
  /** Full-size PNG for hosting on fal; this is what the model sees. */
  blob: Blob;
  /** Small preview for the rail. */
  thumbDataUri: string;
  /** Compact data URI for the vision model. */
  visionDataUri: string;
  /**
   * The painting, a beat at a time, for the rail to show while it happens.
   * Optional: a port that only has to produce a picture can leave it out.
   */
  paint?: PaintFrame[];
}

export interface RenderBlotOptions {
  thumbEdge?: number;
  visionEdge?: number;
  /** Longest edge of a paint-reel frame. The rail shows them at thumbnail size. */
  paintEdge?: number;
}

const DEFAULT_THUMB_EDGE = 256;
const DEFAULT_VISION_EDGE = 768;
const DEFAULT_PAINT_EDGE = 176;
const PAINT_FRAME_QUALITY = 0.7;

function downscale(source: HTMLCanvasElement, maxEdge: number, type: string, quality: number): string {
  const longest = Math.max(source.width, source.height);
  if (longest <= maxEdge) return source.toDataURL(type, quality);
  const scale = maxEdge / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return source.toDataURL(type, quality);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality);
}

/**
 * The painting as it stood, with the crease drawn across it as a guide.
 *
 * The crease is drawn on a copy because it is what the fold *is*, not pigment:
 * printing the guide into the real blot would leave a ruled line on the paper
 * the vision model is then asked to read. It is stroked twice, a pale line with
 * the dark crease over it, so it stays legible over both bare paper and wet ink
 * - and at thumbnail size, where a single hairline disappears.
 */
function guideFrame(canvas: HTMLCanvasElement, fold: Fold, maxEdge: number): string {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(canvas, 0, 0);
  const [from, to] = creaseLine(fold);
  // A crease has to survive a 176px frame shown at thumbnail size: a hairline
  // and a fine dash both vanish there, so the line is thick, widely dashed, and
  // backed by a pale halo to hold it apart from whatever ink it crosses.
  const lineWidth = Math.max(3, canvas.width * 0.01);
  ctx.beginPath();
  ctx.moveTo(from.x * copy.width, from.y * copy.height);
  ctx.lineTo(to.x * copy.width, to.y * copy.height);
  // the sheet is white, so the halo that keeps the crease legible over ink is white too
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = lineWidth * 2.6;
  ctx.stroke();
  ctx.setLineDash([canvas.width * 0.045, canvas.width * 0.028]);
  ctx.strokeStyle = 'rgba(26, 21, 32, 0.85)';
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  return downscale(copy, maxEdge, 'image/jpeg', PAINT_FRAME_QUALITY);
}

/**
 * Paints a recipe and returns it in the three sizes the app needs: the hosted
 * PNG the video model fetches, a rail thumbnail, and a small JPEG for the
 * vision call. Sending a full-size PNG to the vision model would cost far more
 * tokens for no extra information.
 *
 * The frames of the painting come out of the same pass, so the picture the
 * model reads and the picture the rail shows being made are one and the same.
 */
export async function renderBlot(
  recipe: InkRecipe,
  options: RenderBlotOptions = {},
): Promise<RenderedBlot> {
  const paper = new Paper(recipe.canvas);
  const edge = options.paintEdge ?? DEFAULT_PAINT_EDGE;
  const reel: string[] = [];
  paper.renderInStages(recipe, (beat) => {
    reel.push(beat.kind === 'fold-guide' && beat.fold
      ? guideFrame(paper.canvas, beat.fold, edge)
      : downscale(paper.canvas, edge, 'image/jpeg', PAINT_FRAME_QUALITY));
  });
  return {
    blob: await paper.toBlob(),
    thumbDataUri: downscale(paper.canvas, options.thumbEdge ?? DEFAULT_THUMB_EDGE, 'image/jpeg', 0.72),
    visionDataUri: downscale(paper.canvas, options.visionEdge ?? DEFAULT_VISION_EDGE, 'image/jpeg', 0.82),
    paint: paintFrames(paintBeats(recipe), reel),
  };
}

/** Renders straight onto an existing paper, for the hand-painted path. */
export function snapshotPaper(paper: Paper, options: RenderBlotOptions = {}): Omit<RenderedBlot, 'blob'> & { blob: Promise<Blob> } {
  return {
    blob: paper.toBlob(),
    thumbDataUri: downscale(paper.canvas, options.thumbEdge ?? DEFAULT_THUMB_EDGE, 'image/jpeg', 0.72),
    visionDataUri: downscale(paper.canvas, options.visionEdge ?? DEFAULT_VISION_EDGE, 'image/jpeg', 0.82),
  };
}
