import { renderOps } from './recipe';
import type { Fold, InkRecipe } from './types';

/**
 * How long each beat of a painting is held on the rail, in milliseconds.
 *
 * A blot is painted in one pass in a few milliseconds, which shows a viewer
 * nothing but a finished picture appearing out of nowhere. These beats are the
 * same painting replayed a step at a time - one frame per tool, one per fold,
 * then the grain - so the ink can actually be watched arriving.
 */
export const INK_BEAT_MS = 260;
/** The crease alone, held long enough to read as a fold rather than a jump. */
export const FOLD_GUIDE_MS = 440;
/** The mirrored print landing on the far half. */
export const FOLD_PRINT_MS = 320;
export const GRAIN_BEAT_MS = 300;
/**
 * The finished blot, held before the next one is invented. The rail paces its
 * inventions by each painting's own show, so this beat is what separates one
 * blot from the next.
 */
export const SETTLE_BEAT_MS = 320;

export type PaintBeatKind = 'ink' | 'fold-guide' | 'fold-print' | 'grain' | 'settle';

export interface PaintBeat {
  kind: PaintBeatKind;
  /** What is happening, in the rail's own words. Empty means no caption. */
  label: string;
  holdMs: number;
  /** The crease this beat is about: the guide that draws it, and the print that runs it. */
  fold?: Fold;
}

export interface PaintFrame extends PaintBeat {
  /** The painting as it stood when this beat ended. */
  uri: string;
  /** When the frame appears, measured from the start of the show. */
  at: number;
}

/**
 * The steps one blot's painting is shown in, derived from its recipe.
 *
 * Pure and derived rather than recorded: the beats a viewer watches and the ops
 * the paper replays come from this one list, so a show can never describe a
 * painting that was not the one made.
 */
export function paintBeats(recipe: InkRecipe): PaintBeat[] {
  const opCount = Math.max(1, renderOps(recipe).length);
  const beats: PaintBeat[] = [];
  for (let i = 0; i < opCount; i++) {
    // only the first frame is captioned: after that the ink is the caption
    beats.push({ kind: 'ink', label: i === 0 ? 'inking the paper' : '', holdMs: INK_BEAT_MS });
  }
  for (const fold of recipe.folds) {
    beats.push({ kind: 'fold-guide', label: 'folding the paper', holdMs: FOLD_GUIDE_MS, fold });
    beats.push({ kind: 'fold-print', label: '', holdMs: FOLD_PRINT_MS, fold });
  }
  beats.push({ kind: 'grain', label: 'pressing the grain in', holdMs: GRAIN_BEAT_MS });
  beats.push({ kind: 'settle', label: '', holdMs: SETTLE_BEAT_MS });
  return beats;
}

/** Beats with their frames attached and their start times laid out. Pure. */
export function paintFrames(beats: readonly PaintBeat[], uris: readonly string[]): PaintFrame[] {
  let at = 0;
  let previous = '';
  return beats.map((beat, index) => {
    const uri = uris[index] ?? previous;
    previous = uri;
    const frame: PaintFrame = { ...beat, uri, at };
    at += beat.holdMs;
    return frame;
  });
}

/** How long one blot's painting is on the rail, settle beat included. */
export function paintShowMs(frames: readonly PaintFrame[]): number {
  const last = frames[frames.length - 1];
  return last ? last.at + last.holdMs : 0;
}
