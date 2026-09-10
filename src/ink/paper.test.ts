import { describe, it, expect } from 'vitest';
import { CANVAS_SIZE, PAPER_COLOR, clampDropRadius, uvToPixels } from './paper';
import { canvasForAspect } from './types';

describe('clampDropRadius', () => {
  it('clamps to [10, 120]', () => {
    expect(clampDropRadius(5)).toBe(10);
    expect(clampDropRadius(999)).toBe(120);
    expect(clampDropRadius(50)).toBe(50);
  });
});

describe('uvToPixels', () => {
  it('scales a UV width against the short edge', () => {
    const landscape = canvasForAspect('16:9', CANVAS_SIZE);
    expect(uvToPixels(0.5, landscape)).toBeCloseTo(0.5 * landscape.height);
    const square = canvasForAspect('1:1', CANVAS_SIZE);
    expect(uvToPixels(0.25, square)).toBeCloseTo(0.25 * CANVAS_SIZE);
  });
});

describe('paper constants', () => {
  it('keeps the legacy 1024 canvas default and a warm paper tone', () => {
    expect(CANVAS_SIZE).toBe(1024);
    expect(PAPER_COLOR).toBe('#f4efe6');
  });
});
