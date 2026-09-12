/** Shared ink vocabulary. Kept dependency-free so presets can import it. */

export type Axis = 'vertical' | 'horizontal';
/** which half folds over: left/right for vertical, top/bottom for horizontal */
export type Direction = 'left' | 'right' | 'top' | 'bottom';

export interface Fold {
  axis: Axis;
  direction: Direction;
  /** crease position along the folded axis, 0..1. Default 0.5 (centre fold). */
  at?: number;
}

export interface DropOptions {
  radius: number;   // px on the canvas, 10-120
  color: string;    // CSS color
  wetness: number;  // 0-1, how far the blot splatters
}

export interface UV {
  x: number;
  y: number;
}

export type InkToolId =
  | 'drop'      // a single pooling blob
  | 'splatter'  // a blob with lobes and droplets
  | 'streak'    // a fast tapered stroke
  | 'curve'     // a slow wandering stroke
  | 'pool'      // a large soft bloom
  | 'drag'      // a wet blob smeared along a line
  | 'spray'     // a fine scatter of droplets
  | 'backrun';  // clear a channel back through wet ink

export const INK_TOOLS: readonly InkToolId[] = [
  'drop', 'splatter', 'streak', 'curve', 'pool', 'drag', 'spray', 'backrun',
];

/** One deterministic painting instruction, in UV space (origin top-left). */
export interface InkOp {
  tool: InkToolId;
  /** 1+ control points; a single point for radial tools. */
  points: UV[];
  /** Characteristic size in UV units (0..1 of the short edge). */
  width: number;
  color: string;
  alpha: number;
  /** 0-1, drives droplet spread and edge bleed. */
  wetness: number;
  /**
   * Width at the far end of a stroke, as a multiplier of `width`.
   *
   * A limb of ink thins as it is pulled away from the body it grew out of, and
   * a stroke that keeps its full width all the way to its tip reads as a bar
   * rather than as ink. Undefined leaves the mark's own symmetric taper to
   * decide, which is what a mark that is not a limb wants.
   */
  rampTo?: number;
  /** per-op randomness so a re-render is identical without sharing the RNG */
  seed: number;
}

export interface CanvasSpec {
  width: number;
  height: number;
}

/** A replayable description of one painting. Seed + parameters == the image. */
export interface InkRecipe {
  version: 1;
  seed: number;
  canvas: CanvasSpec;
  /** Ink colours, chosen from in order of appearance. */
  palette: string[];
  /** Tools the engine may reach for. */
  tools: InkToolId[];
  /** How many strokes/drops make up the blot. */
  blotCount: number;
  /** Global wetness 0-1; rides on top of each op's own variation. */
  wetness: number;
  /** Global bleed 0-1: how far the pigment creeps past the stroke edge. */
  bleed: number;
  /** Folds applied after the paint dries, in order. */
  folds: Fold[];
  /** Optional paper grain amount, 0-1. */
  grain: number;
}

/** Aspect ratios the stream supports, and the canvas each one implies. */
export type AspectRatio = '16:9' | '9:16' | '1:1';

/** Longest edge of a rendered blot. Matches the 768p tier of the model family. */
export const BLOT_LONG_EDGE = 1024;

export function canvasForAspect(aspect: AspectRatio, longEdge = BLOT_LONG_EDGE): CanvasSpec {
  switch (aspect) {
    case '16:9':
      return { width: longEdge, height: Math.round((longEdge * 9) / 16) };
    case '9:16':
      return { width: Math.round((longEdge * 9) / 16), height: longEdge };
    case '1:1':
    default:
      return { width: longEdge, height: longEdge };
  }
}
