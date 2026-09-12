import { describe, it, expect } from 'vitest';
import {
  FIT_MARGIN,
  PAPER_HALF_HEIGHT,
  paperFitDistance,
  paperFrame,
  visibleHalfHeight,
} from './fit';

const FOV = 50;

/** Stage shapes a browser actually produces, phone portrait to ultrawide. */
const STAGES = [0.35, 0.5, 0.75, 1, 1.28, 1.6, 2.4, 3.5];

/** Canvas shapes the paper actually takes: the film's three aspect ratios. */
const CANVASES = [
  { width: 1024, height: 1024 },
  { width: 1024, height: 576 },
  { width: 576, height: 1024 },
];

describe('paperFrame', () => {
  it('keeps the canvas aspect, so a painted drop stays round on screen', () => {
    for (const canvas of CANVASES) {
      const frame = paperFrame(canvas);
      // pixels per world unit, horizontally and vertically
      const perX = canvas.width / (frame.halfWidth * 2);
      const perY = canvas.height / (frame.halfHeight * 2);
      expect(perX).toBeCloseTo(perY, 9);
    }
  });

  it('falls back to a square rather than dividing by nothing', () => {
    expect(paperFrame({ width: 0, height: 0 }).halfWidth).toBe(PAPER_HALF_HEIGHT);
  });
});

describe('paperFitDistance', () => {
  it('keeps the whole sheet inside the frustum on every stage and canvas shape', () => {
    for (const stage of STAGES) {
      for (const canvas of CANVASES) {
        const frame = paperFrame(canvas);
        const distance = paperFitDistance(FOV, stage, frame.halfWidth);
        const halfHeight = visibleHalfHeight(distance, FOV);
        const halfWidth = halfHeight * stage;
        expect(halfHeight).toBeGreaterThanOrEqual(frame.halfHeight);
        expect(halfWidth).toBeGreaterThanOrEqual(frame.halfWidth);
      }
    }
  });

  it('leaves the paper as large as the binding axis allows, never smaller', () => {
    for (const stage of STAGES) {
      for (const canvas of CANVASES) {
        const frame = paperFrame(canvas);
        const distance = paperFitDistance(FOV, stage, frame.halfWidth);
        const halfHeight = visibleHalfHeight(distance, FOV);
        const halfWidth = halfHeight * stage;
        const binding = Math.min(halfHeight / frame.halfHeight, halfWidth / frame.halfWidth);
        // the tight axis sits exactly on the margin: nearer and the sheet would
        // be cropped, further and it would shrink for no reason
        expect(binding).toBeCloseTo(FIT_MARGIN, 9);
      }
    }
  });

  it('sits on the height alone until the stage is narrower than the sheet', () => {
    // a square sheet: everything from 1:1 up is bound by the height, so the
    // camera does not creep back as the window widens
    const square = paperFitDistance(FOV, 1);
    expect(paperFitDistance(FOV, 2.4)).toBeCloseTo(square, 9);
    expect(paperFitDistance(FOV, 16)).toBeCloseTo(square, 9);
    // below 1:1 the width takes over, and halving it doubles the distance
    expect(paperFitDistance(FOV, 0.5)).toBeCloseTo(square * 2, 9);
  });

  it('backs the camera off as a wide sheet runs out of stage', () => {
    const sheet = 16 / 9;
    const framed = paperFitDistance(FOV, sheet, sheet);
    expect(paperFitDistance(FOV, 3.5, sheet)).toBeCloseTo(framed, 9);
    const square = paperFitDistance(FOV, 1, sheet);
    expect(square).toBeGreaterThan(framed);
    // square stage to a stage half that wide, for a sheet twice as wide as tall
    expect(paperFitDistance(FOV, 0.5, sheet)).toBeCloseTo(square * 2, 9);
  });
});
