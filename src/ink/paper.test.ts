import { describe, it, expect } from 'vitest';
import { foldHalves, clampDropRadius } from './paper';

describe('foldHalves', () => {
  it('vertical fold-left: source = left half, target = right half', () => {
    const h = foldHalves({ axis: 'vertical', direction: 'left' });
    expect(h.sourceX).toBe(0);
    expect(h.targetX).toBe(0.5);
    expect(h.sourceY).toBe(0);
    expect(h.targetY).toBe(0);
  });
  it('vertical fold-right: source = right half, target = left', () => {
    const h = foldHalves({ axis: 'vertical', direction: 'right' });
    expect(h.sourceX).toBe(0.5);
    expect(h.targetX).toBe(0);
  });
  it('horizontal fold-top: source = top half, target = bottom', () => {
    const h = foldHalves({ axis: 'horizontal', direction: 'top' });
    expect(h.sourceY).toBe(0);
    expect(h.targetY).toBe(0.5);
    expect(h.sourceX).toBe(0);
    expect(h.targetX).toBe(0);
  });
  it('horizontal fold-bottom: source = bottom half, target = top', () => {
    const h = foldHalves({ axis: 'horizontal', direction: 'bottom' });
    expect(h.sourceY).toBe(0.5);
    expect(h.targetY).toBe(0);
  });
});

describe('clampDropRadius', () => {
  it('clamps to [10, 120]', () => {
    expect(clampDropRadius(5)).toBe(10);
    expect(clampDropRadius(999)).toBe(120);
    expect(clampDropRadius(50)).toBe(50);
  });
});
