import { describe, it, expect } from 'vitest';
import { estimateCost, DEFAULT_SETTINGS } from './state';

describe('estimateCost', () => {
  it('prices 768P at $0.04/s', () => {
    expect(estimateCost({ ...DEFAULT_SETTINGS.video, resolution: '768P', duration: 5 })).toBeCloseTo(0.2);
  });
  it('prices 480P at $0.025/s', () => {
    expect(estimateCost({ ...DEFAULT_SETTINGS.video, resolution: '480P', duration: 8 })).toBeCloseTo(0.2);
  });
});
