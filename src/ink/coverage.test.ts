import { describe, it, expect } from 'vitest';
import { MAX_OP_WIDTH, MIN_INK_COVERAGE, fitToInkFloor, inkComponents, inkCoverage } from './coverage';
import { canvasForAspect, type InkOp } from './types';

const canvas = canvasForAspect('16:9');

function op(overrides: Partial<InkOp> = {}): InkOp {
  return {
    tool: 'pool',
    points: [{ x: 0.5, y: 0.5 }],
    width: 0.25,
    color: '#101010',
    alpha: 0.8,
    wetness: 0.4,
    seed: 1,
    ...overrides,
  };
}

describe('inkCoverage', () => {
  it('is nothing at all for a log that inks nothing', () => {
    expect(inkCoverage([], canvas)).toBe(0);
    // a backrun lifts pigment out of the sheet, so it can never add paper
    expect(inkCoverage([op({ tool: 'backrun' })], canvas)).toBe(0);
  });

  it('counts a mark once, however many times it is laid down', () => {
    const single = inkCoverage([op()], canvas);
    expect(single).toBeGreaterThan(0.05);
    expect(inkCoverage([op(), op({ seed: 99 }), op({ seed: 100 })], canvas)).toBe(single);
  });

  it('reads more pigment where the ink is heavier', () => {
    // a tool whose marks wet most of their footprint beats one that leaves dots
    const spray = inkCoverage([op({ tool: 'spray', width: 0.3 })], canvas);
    const pool = inkCoverage([op({ tool: 'pool', width: 0.3 })], canvas);
    expect(pool).toBeGreaterThan(spray);
  });

  it('reads a stroke as a capsule along its whole path, not as a dot', () => {
    const dot = inkCoverage([op({ tool: 'curve', width: 0.06 })], canvas);
    const stroke = inkCoverage([op({ tool: 'curve', points: [{ x: 0.2, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }], width: 0.06 })], canvas);
    expect(stroke).toBeGreaterThan(dot * 3);
  });

  it('covers less of a wide sheet than of a square one with the same mark', () => {
    const square = inkCoverage([op({ width: 0.3 })], canvasForAspect('1:1'));
    expect(square).toBeGreaterThan(inkCoverage([op({ width: 0.3 })], canvas));
  });
});

describe('inkComponents', () => {
  it('reads one mark as one piece of ink and two far-apart marks as two', () => {
    expect(inkComponents([op()], canvas)).toBe(1);
    expect(inkComponents([op({ points: [{ x: 0.15, y: 0.15 }] }), op({ points: [{ x: 0.85, y: 0.85 }] })], canvas)).toBe(2);
  });

  it('reads marks that overlap as the one mass they make on the sheet', () => {
    // two pools leaning on each other are one piece of ink; the same two drawn
    // a width apart are two, which is the whole difference between a blot and a
    // scatter of blots
    const apart = inkComponents([
      op({ points: [{ x: 0.3, y: 0.5 }], width: 0.1 }),
      op({ points: [{ x: 0.7, y: 0.5 }], width: 0.1 }),
    ], canvas);
    const together = inkComponents([
      op({ points: [{ x: 0.3, y: 0.5 }], width: 0.1 }),
      op({ points: [{ x: 0.36, y: 0.5 }], width: 0.1 }),
    ], canvas);
    expect(apart).toBe(2);
    expect(together).toBe(1);
  });

  it('counts a stroke that grew out of a body as the one piece it is', () => {
    const joined = inkComponents([
      op({ points: [{ x: 0.5, y: 0.5 }], width: 0.12 }),
      op({ tool: 'streak', points: [{ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.3 }], width: 0.08 }),
    ], canvas);
    expect(joined).toBe(1);
  });

  it('is nothing at all for a log that inks nothing', () => {
    expect(inkComponents([], canvas)).toBe(0);
    expect(inkComponents([op({ tool: 'backrun' })], canvas)).toBe(0);
  });
});

describe('fitToInkFloor', () => {
  it('leaves a log that already covers the sheet exactly as it was', () => {
    const log = [op({ width: 0.5 })];
    expect(inkCoverage(log, canvas)).toBeGreaterThanOrEqual(MIN_INK_COVERAGE);
    expect(fitToInkFloor(log, canvas)).toEqual(log);
  });

  it('grows a speck in the corner into a blot, without inventing marks', () => {
    const speck = [op({ tool: 'drop', points: [{ x: 0.94, y: 0.92 }], width: 0.02 })];
    const grown = fitToInkFloor(speck, canvas);
    expect(grown).toHaveLength(1);
    expect(inkCoverage(grown, canvas)).toBeGreaterThanOrEqual(MIN_INK_COVERAGE);
  });

  it('never widens a mark past the ceiling or walks a point off the sheet', () => {
    for (let seed = 0; seed < 120; seed++) {
      const speck = [op({ tool: 'splatter', points: [{ x: 0.98, y: 0.02 }], width: 0.02, seed })];
      for (const grown of fitToInkFloor(speck, canvas)) {
        expect(grown.width).toBeLessThanOrEqual(MAX_OP_WIDTH);
        for (const point of grown.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(1);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('has nothing to grow when every mark lifts pigment instead of adding it', () => {
    const log = [op({ tool: 'backrun', points: [{ x: 0.3, y: 0.3 }], width: 0.05 })];
    expect(fitToInkFloor(log, canvas)).toEqual(log);
  });

  it('is deterministic: the same log grows to the same blot', () => {
    const speck = [op({ tool: 'drag', points: [{ x: 0.4, y: 0.4 }, { x: 0.45, y: 0.44 }], width: 0.03 })];
    expect(fitToInkFloor(speck, canvas)).toEqual(fitToInkFloor(speck, canvas));
  });
});
