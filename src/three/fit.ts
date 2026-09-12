/** Half-height of the paper plane in world units; the sheet is two units tall. */
export const PAPER_HALF_HEIGHT = 1;

/** How much empty stage is left around the paper, as a multiple of its size. */
export const FIT_MARGIN = 1.12;

export interface PaperFrame {
  halfWidth: number;
  halfHeight: number;
}

/**
 * World-space half-extents for a canvas of this shape.
 *
 * The sheet is always one unit tall and as wide as the canvas is, so a 16:9
 * canvas becomes a 3.56 x 2 world plane. Matching the plane to the canvas is
 * what keeps a painted drop round on screen — a square plane would stretch the
 * film's frame, and every stroke with it, into an ellipse.
 */
export function paperFrame(canvas: { width: number; height: number }): PaperFrame {
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  return { halfWidth: Math.max(0.05, aspect) * PAPER_HALF_HEIGHT, halfHeight: PAPER_HALF_HEIGHT };
}

/**
 * How far the camera has to sit from the paper for the whole sheet to be in
 * frame, whatever shape the stage is.
 *
 * The paper faces the camera, so the frustum only has to clear the sheet's
 * half-height vertically and its half-width horizontally — the latter divided
 * by the stage aspect, since a narrow stage shows less world per pixel across.
 * The larger of the two is the answer: that is what keeps a wide blot uncropped
 * on a wide screen and a tall one uncropped on a phone.
 */
export function paperFitDistance(
  fovDegrees: number,
  stageAspect: number,
  paperHalfWidth: number = PAPER_HALF_HEIGHT,
  margin: number = FIT_MARGIN,
): number {
  const halfFov = Math.tan((fovDegrees * Math.PI) / 360);
  const fitHeight = (PAPER_HALF_HEIGHT * margin) / halfFov;
  const fitWidth = (paperHalfWidth * margin) / (halfFov * Math.max(0.05, stageAspect));
  return Math.max(fitHeight, fitWidth);
}

/** Half-height of the frustum at `distance`, in world units. */
export function visibleHalfHeight(distance: number, fovDegrees: number): number {
  return distance * Math.tan((fovDegrees * Math.PI) / 360);
}
