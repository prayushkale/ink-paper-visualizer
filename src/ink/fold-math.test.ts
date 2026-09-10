import { describe, it, expect } from 'vitest';
import { creaseAt, creaseLine, foldGeometry, mapPointThroughFolds, mirrorPoint } from './fold-math';
import type { Fold } from './types';

const v = (direction: Fold['direction'], at?: number): Fold => ({ axis: 'vertical', direction, at });
const h = (direction: Fold['direction'], at?: number): Fold => ({ axis: 'horizontal', direction, at });

describe('creaseAt', () => {
  it('defaults to a centre crease', () => {
    expect(creaseAt(v('left'))).toBe(0.5);
  });
  it('keeps a sane off-centre crease', () => {
    expect(creaseAt(v('left', 0.4))).toBeCloseTo(0.4);
  });
  it('clamps degenerate creases away from the edges', () => {
    expect(creaseAt(v('left', 0))).toBeCloseTo(0.05);
    expect(creaseAt(v('left', 1))).toBeCloseTo(0.95);
    expect(creaseAt(v('left', -3))).toBeCloseTo(0.05);
  });
});

describe('mirrorPoint', () => {
  it('folds left onto right and right onto left about the centre', () => {
    expect(mirrorPoint({ x: 0.25, y: 0.7 }, v('left')).x).toBeCloseTo(0.75);
    expect(mirrorPoint({ x: 0.25, y: 0.7 }, v('left')).y).toBeCloseTo(0.7);
    expect(mirrorPoint({ x: 0.8, y: 0.1 }, v('right')).x).toBeCloseTo(0.2);
  });
  it('folds top onto bottom and bottom onto top about the centre', () => {
    expect(mirrorPoint({ x: 0.4, y: 0.2 }, h('top')).y).toBeCloseTo(0.8);
    expect(mirrorPoint({ x: 0.4, y: 0.9 }, h('bottom')).y).toBeCloseTo(0.1);
  });
  it('mirrors about an off-centre crease', () => {
    expect(mirrorPoint({ x: 0.2, y: 0.5 }, v('left', 0.4)).x).toBeCloseTo(0.6);
    expect(mirrorPoint({ x: 0.5, y: 0.1 }, h('top', 0.25)).y).toBeCloseTo(0.4);
  });
  it('holds any point on the crease fixed, wherever the crease is', () => {
    for (const at of [0.1, 0.25, 0.5, 0.66, 0.9]) {
      expect(mirrorPoint({ x: at, y: 0.3 }, v('left', at)).x).toBeCloseTo(at);
      expect(mirrorPoint({ x: 0.3, y: at }, h('bottom', at)).y).toBeCloseTo(at);
    }
  });
  it('is its own inverse', () => {
    const fold = v('right', 0.37);
    const once = mirrorPoint({ x: 0.11, y: 0.82 }, fold);
    const back = mirrorPoint(once, fold);
    expect(back.x).toBeCloseTo(0.11);
    expect(back.y).toBeCloseTo(0.82);
  });
  it('does not depend on which half is said to move', () => {
    const p = { x: 0.22, y: 0.61 };
    expect(mirrorPoint(p, v('left', 0.4))).toEqual(mirrorPoint(p, v('right', 0.4)));
  });
});

describe('mapPointThroughFolds', () => {
  it('is identity with no folds', () => {
    expect(mapPointThroughFolds({ x: 0.3, y: 0.4 }, [])).toEqual({ x: 0.3, y: 0.4 });
  });
  it('composes two centre folds into a point reflection', () => {
    const folded = mapPointThroughFolds({ x: 0.2, y: 0.3 }, [v('left'), h('top')]);
    expect(folded.x).toBeCloseTo(0.8);
    expect(folded.y).toBeCloseTo(0.7);
  });
  it('composes off-centre folds in order', () => {
    const folds = [v('left', 0.5), v('left', 0.3)];
    // 0.5 -> 0.5 (on crease) -> 0.1
    expect(mapPointThroughFolds({ x: 0.5, y: 0 }, folds).x).toBeCloseTo(0.1);
  });
});

describe('foldGeometry', () => {
  it('moves the left half onto the right for a centre fold', () => {
    const g = foldGeometry(v('left'));
    expect(g.source).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(g.dest).toEqual({ x: 0.5, y: 0, flipX: true, flipY: false });
  });
  it('moves the right half onto the left for a centre fold', () => {
    const g = foldGeometry(v('right'));
    expect(g.source).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(g.dest).toEqual({ x: 0, y: 0, flipX: true, flipY: false });
  });
  it('maps the destination so the flap mirrors onto the far side', () => {
    // mirror of [0, 0.4] about 0.4 is [0.4, 0.8]
    const left = foldGeometry(v('left', 0.4));
    expect(left.dest.x).toBeCloseTo(0.4);
    expect(left.dest.x + left.source.w).toBeCloseTo(0.8);
    // mirror of [0.3, 1] about 0.3 is [-0.4, 0.3]
    const right = foldGeometry(v('right', 0.3));
    expect(right.source).toEqual({ x: 0.3, y: 0, w: 0.7, h: 1 });
    expect(right.dest.x).toBeCloseTo(-0.4);
    expect(right.dest.x + right.source.w).toBeCloseTo(0.3);
  });
  it('handles horizontal folds, including off centre', () => {
    expect(foldGeometry(h('top')).source).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(foldGeometry(h('top')).dest).toEqual({ x: 0, y: 0.5, flipX: false, flipY: true });
    const bottom = foldGeometry(h('bottom', 0.6));
    expect(bottom.source).toEqual({ x: 0, y: 0.6, w: 1, h: 0.4 });
    expect(bottom.dest.y).toBeCloseTo(0.2);
  });
  it('always describes a flap whose outer edge lands exactly where the mirror says', () => {
    for (const fold of [v('left', 0.2), v('right', 0.75), h('top', 0.35), h('bottom', 0.8)]) {
      const g = foldGeometry(fold);
      const nearSide = fold.direction === 'left' || fold.direction === 'top';
      // the flap's OUTER edge is the one furthest from the crease
      const outer = nearSide ? 0 : 1;
      const mirrored = fold.axis === 'vertical'
        ? mirrorPoint({ x: outer, y: 0.5 }, fold).x
        : mirrorPoint({ x: 0.5, y: outer }, fold).y;
      // dest is the LEFT/TOP edge of the mirrored image
      const drawnFarEdge = nearSide
        ? (fold.axis === 'vertical' ? g.dest.x + g.source.w : g.dest.y + g.source.h)
        : (fold.axis === 'vertical' ? g.dest.x : g.dest.y);
      expect(mirrored, `${fold.axis}/${fold.direction}`).toBeCloseTo(drawnFarEdge);
    }
  });
});

describe('creaseLine', () => {
  it('draws the crease across the whole canvas', () => {
    expect(creaseLine(v('left', 0.4))).toEqual([{ x: 0.4, y: 0 }, { x: 0.4, y: 1 }]);
    expect(creaseLine(h('top'))).toEqual([{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]);
  });
});
