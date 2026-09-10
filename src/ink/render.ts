import { Paper } from './paper';
import type { CanvasSpec, InkRecipe } from './types';

export interface RenderedBlot {
  /** Full-size PNG for hosting on fal; this is what the model sees. */
  blob: Blob;
  /** Small preview for the rail. */
  thumbDataUri: string;
  /** Compact data URI for the vision model. */
  visionDataUri: string;
}

export interface RenderBlotOptions {
  thumbEdge?: number;
  visionEdge?: number;
}

const DEFAULT_THUMB_EDGE = 256;
const DEFAULT_VISION_EDGE = 768;

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
 * Paints a recipe and returns it in the three sizes the app needs: the hosted
 * PNG the video model fetches, a rail thumbnail, and a small JPEG for the
 * vision call. Sending a full-size PNG to the vision model would cost far more
 * tokens for no extra information.
 */
export async function renderBlot(
  recipe: InkRecipe,
  options: RenderBlotOptions = {},
): Promise<RenderedBlot> {
  const paper = new Paper(recipe.canvas);
  // Paper.render replays the recipe's op log, folds and grain in one pass
  paper.render(recipe);
  return {
    blob: await paper.toBlob(),
    thumbDataUri: downscale(paper.canvas, options.thumbEdge ?? DEFAULT_THUMB_EDGE, 'image/jpeg', 0.72),
    visionDataUri: downscale(paper.canvas, options.visionEdge ?? DEFAULT_VISION_EDGE, 'image/jpeg', 0.82),
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

export function canvasSpecKey(spec: CanvasSpec): string {
  return `${spec.width}x${spec.height}`;
}
