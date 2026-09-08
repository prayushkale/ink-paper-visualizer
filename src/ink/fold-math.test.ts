import { describe, it, expect } from 'vitest';
import { mirrorPoint, mapPointThroughFolds, foldsToFullUnfold } from './fold-math';

describe('mirrorPoint', () => {
  it('folds left half onto right (vertical, fold left)', () => {
    expect(mirrorPoint({ x: 0.25, y: 0.7 }, { axis: 'vertical', direction: 'left' }))
      .toEqual({ x: 0.75, y: 0.7 });
  });
  it('folds top half onto bottom (horizontal, fold top)', () => {
    expect(mirrorPoint({ x: 0.4, y: 0.2 }, { axis: 'horizontal', direction: 'top' }))
      .toEqual({ x: 0.4, y: 0.8 });
  });
  it('folds bottom onto top', () => {
    expect(mirrorPoint({ x: 0.4, y: 0.9 }, { axis: 'horizontal', direction: 'bottom' }))
      .toEqual(expect.objectContaining({ x: 0.4, y: expect.closeTo(0.1) }));
  });
  it('folds right onto left', () => {
    expect(mirrorPoint({ x: 0.8, y: 0.1 }, { axis: 'vertical', direction: 'right' }))
      .toEqual(expect.objectContaining({ x: expect.closeTo(0.2), y: 0.1 }));
  });
  it('point on fold line is fixed', () => {
    expect(mirrorPoint({ x: 0.5, y: 0.3 }, { axis: 'vertical', direction: 'left' }))
      .toEqual({ x: 0.5, y: 0.3 });
  });
});

describe('mapPointThroughFolds', () => {
  it('sequence of 2 folds mirrors twice', () => {
    const p = mapPointThroughFolds({ x: 0.2, y: 0.3 }, [
      { axis: 'vertical', direction: 'left' },
      { axis: 'horizontal', direction: 'top' },
    ]);
    expect(p).toEqual({ x: 0.8, y: 0.7 });
  });
  it('empty folds is identity', () => {
    expect(mapPointThroughFolds({ x: 0.3, y: 0.4 }, [])).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe('foldsToFullUnfold', () => {
  it('returns the fold list unchanged', () => {
    const folds = [{ axis: 'vertical', direction: 'left' } as const];
    expect(foldsToFullUnfold(folds)).toEqual(folds);
  });
});
