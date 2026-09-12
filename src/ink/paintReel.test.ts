import { describe, it, expect } from 'vitest';
import {
  FOLD_GUIDE_MS,
  FOLD_PRINT_MS,
  GRAIN_BEAT_MS,
  INK_BEAT_MS,
  SETTLE_BEAT_MS,
  paintBeats,
  paintFrames,
  paintShowMs,
} from './paintReel';
import { inkRecipeFromSeed, renderOps } from './recipe';

type RecipeOptions = Parameters<typeof inkRecipeFromSeed>[0];

const recipe = (overrides: Partial<RecipeOptions> = {}) =>
  inkRecipeFromSeed({ seed: 4242, canvas: { width: 320, height: 180 }, folds: [], ...overrides });

describe('paintBeats', () => {
  it('shows one frame per tool, then the grain and the settle', () => {
    const source = recipe({ blotCount: 5 });
    const beats = paintBeats(source);
    expect(beats.filter((beat) => beat.kind === 'ink')).toHaveLength(renderOps(source).length);
    expect(beats.map((beat) => beat.kind)).toEqual(['ink', 'ink', 'ink', 'ink', 'ink', 'grain', 'settle']);
    expect(beats.every((beat) => beat.holdMs > 0)).toBe(true);
  });

  it('captions the first frame and nothing else until a fold happens', () => {
    const beats = paintBeats(recipe({ blotCount: 3 }));
    expect(beats[0]!.label).toMatch(/inking/);
    expect(beats.slice(1, 3).every((beat) => beat.label === '')).toBe(true);
  });

  it('folds a fold at a time: the crease first, then the print', () => {
    const source = recipe({
      folds: [{ axis: 'vertical', direction: 'left' }, { axis: 'horizontal', direction: 'top' }],
    });
    const beats = paintBeats(source);
    const kinds = beats.map((beat) => beat.kind);
    const firstFold = kinds.indexOf('fold-guide');
    expect(kinds.slice(firstFold, firstFold + 4)).toEqual(['fold-guide', 'fold-print', 'fold-guide', 'fold-print']);
    expect(beats[firstFold]!.fold).toEqual({ axis: 'vertical', direction: 'left' });
    expect(beats[firstFold]!.label).toMatch(/fold/);
  });

  it('always ends on a settle beat, even for a blot with no folds', () => {
    const beats = paintBeats(recipe({ blotCount: 1, folds: [] }));
    expect(beats.map((beat) => beat.kind)).toEqual(['ink', 'grain', 'settle']);
  });

  it('holds a crease longer than it holds a stroke', () => {
    const beats = paintBeats(recipe({ folds: [{ axis: 'vertical', direction: 'left' }] }));
    const guide = beats.find((beat) => beat.kind === 'fold-guide')!;
    expect(guide.holdMs).toBe(FOLD_GUIDE_MS);
    expect(guide.holdMs).toBeGreaterThan(INK_BEAT_MS);
    expect(beats.find((beat) => beat.kind === 'fold-print')!.holdMs).toBe(FOLD_PRINT_MS);
    expect(beats.find((beat) => beat.kind === 'grain')!.holdMs).toBe(GRAIN_BEAT_MS);
    expect(beats[beats.length - 1]!.holdMs).toBe(SETTLE_BEAT_MS);
  });
});

describe('paintFrames', () => {
  it('starts each frame where the one before it ran out, in order', () => {
    const beats = paintBeats(recipe({ blotCount: 2, folds: [{ axis: 'vertical', direction: 'left' }] }));
    const frames = paintFrames(beats, beats.map((_, index) => `data:image/jpeg;base64,frame-${index}`));
    let at = 0;
    for (const [index, frame] of frames.entries()) {
      expect(frame.at).toBe(at);
      expect(frame.uri).toContain(`frame-${index}`);
      at += beats[index]!.holdMs;
    }
  });

  it('keeps the last frame when an encoder hands back nothing', () => {
    const beats = paintBeats(recipe({ blotCount: 3 }));
    const frames = paintFrames(beats, ['data:image/jpeg;base64,only']);
    expect(frames.every((frame) => frame.uri === 'data:image/jpeg;base64,only')).toBe(true);
  });
});

describe('paintShowMs', () => {
  it('is the whole show, settle included', () => {
    const beats = paintBeats(recipe({ blotCount: 4 }));
    const frames = paintFrames(beats, beats.map(() => 'data:image/jpeg;base64,x'));
    expect(paintShowMs(frames)).toBe(beats.reduce((sum, beat) => sum + beat.holdMs, 0));
  });

  it('is zero when there is nothing to show', () => {
    expect(paintShowMs([])).toBe(0);
  });
});
