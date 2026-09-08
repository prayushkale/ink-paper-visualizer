import type { Fold } from '../state';

export interface UV { x: number; y: number; }

/**
 * Where does a point land after this fold? The moving half (named by
 * `direction`) flips over the center line onto the stationary half.
 * For vertical folds the mirror is always x -> 1-x (either direction);
 * for horizontal folds y -> 1-y. Direction matters for the 3D animation
 * (which half rotates) and blit order (which half overwrites which),
 * NOT for point mapping.
 */
export function mirrorPoint(p: UV, fold: Fold): UV {
  if (fold.axis === 'vertical') return { x: 1 - p.x, y: p.y };
  return { x: p.x, y: 1 - p.y };
}

/** Apply folds in order: fold 1 first, its result feeds fold 2, etc. */
export function mapPointThroughFolds(p: UV, folds: Fold[]): UV {
  return folds.reduce((acc, f) => mirrorPoint(acc, f), p);
}

/** The folds list IS the unfold map (kept as named helper for clarity). */
export function foldsToFullUnfold(folds: Fold[]): Fold[] {
  return folds;
}
