import { clamp } from './rng';
import type { Fold, UV } from './types';

/** Default crease: dead centre. */
export const CENTRE = 0.5;

/** Sanity-bounded crease position so a fold can never be degenerate. */
export function creaseAt(fold: Fold): number {
  return clamp(fold.at ?? CENTRE, 0.05, 0.95);
}

/**
 * Where a point on the folded flap lands, in the SAME unfolded frame.
 * Direction does not change the mirror - it decides which pixels win.
 */
export function mirrorPoint(p: UV, fold: Fold): UV {
  const a = creaseAt(fold);
  if (fold.axis === 'vertical') return { x: 2 * a - p.x, y: p.y };
  return { x: p.x, y: 2 * a - p.y };
}

/** Apply folds in order: fold 1 first, its result feeds fold 2. */
export function mapPointThroughFolds(p: UV, folds: Fold[]): UV {
  return folds.reduce((acc, fold) => mirrorPoint(acc, fold), p);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FoldGeometry {
  axis: Fold['axis'];
  /** crease position along the folded axis, 0..1 */
  at: number;
  /** the moving flap, in UV */
  source: Rect;
  /** destination blit parameters, in UV */
  dest: {
    /** left edge of the source flap's mirror image */
    x: number;
    y: number;
    /** draw the flap flipped on this axis */
    flipX: boolean;
    flipY: boolean;
  };
}

/**
 * Geometry for committing a fold: which flap moves, and where its mirror lands.
 *
 * A fold about the line `a` maps x to 2a - x. The flap on the moving side is
 * mirrored onto the far side, so an off-centre crease produces an off-centre
 * symmetry - and any overhang is clipped by the canvas.
 */
export function foldGeometry(fold: Fold): FoldGeometry {
  const at = creaseAt(fold);
  if (fold.axis === 'vertical') {
    const fromLeft = fold.direction === 'left';
    // flap: left of the crease, or right of it
    const source: Rect = fromLeft
      ? { x: 0, y: 0, w: at, h: 1 }
      : { x: at, y: 0, w: 1 - at, h: 1 };
    // mirror about x = at: source left edge lands at 2a - sourceX
    const destX = fromLeft ? at : at - source.w;
    return { axis: 'vertical', at, source, dest: { x: destX, y: 0, flipX: true, flipY: false } };
  }
  const fromTop = fold.direction === 'top';
  const source: Rect = fromTop
    ? { x: 0, y: 0, w: 1, h: at }
    : { x: 0, y: at, w: 1, h: 1 - at };
  const destY = fromTop ? at : at - source.h;
  return { axis: 'horizontal', at, source, dest: { x: 0, y: destY, flipX: false, flipY: true } };
}

/** UV of the crease line, as a pair of points, for drawing a guide. */
export function creaseLine(fold: Fold): [UV, UV] {
  const a = creaseAt(fold);
  return fold.axis === 'vertical'
    ? [{ x: a, y: 0 }, { x: a, y: 1 }]
    : [{ x: 0, y: a }, { x: 1, y: a }];
}
