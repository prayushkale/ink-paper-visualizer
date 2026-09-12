import type { InkScene } from './scene';
import type { DropOptions } from '../state';
import type { Paper } from '../ink/paper';

/**
 * Click/drag on the paper paints a drop at that spot.
 *
 * A press always dabs. A drag only dabs once the pointer has actually travelled:
 * a click is not a still pointer, and the pixel or two of movement between press
 * and release used to land a second, smaller drop on top of the first - so one
 * aim read as a cluster of marks. The threshold scales with the brush, so a wide
 * drag is still a trail rather than a dotted line.
 */
export function wirePainting(scene: InkScene, paper: Paper, getDrop: () => DropOptions): void {
  const el = scene.renderer.domElement;
  let dragging = false;
  /** Where the last dab landed, in paper pixels; null while no drag is running. */
  let last: { x: number; y: number } | null = null;
  const paintAt = (ev: PointerEvent, radiusScale = 1): void => {
    const uv = scene.pointerToUV(ev);
    if (!uv) return;
    const d = getDrop();
    const radius = Math.max(10, d.radius * radiusScale);
    const at = { x: uv.u * paper.spec.width, y: uv.v * paper.spec.height };
    if (dragging && last && Math.hypot(at.x - last.x, at.y - last.y) < Math.max(6, radius * 0.4)) return;
    last = at;
    // the seed is the dab's own address on the sheet, so two clicks in the same
    // spot are one mark and two clicks anywhere else are two different ones
    paper.paintDrop(uv.u, uv.v, { ...d, radius }, (Math.round(at.x) * 73856093) ^ (Math.round(at.y) * 19349663));
    scene.refresh();
  };
  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    last = null;
    paintAt(ev);
  });
  el.addEventListener('pointerup', () => { dragging = false; last = null; });
  el.addEventListener('pointerleave', () => { dragging = false; last = null; });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    paintAt(ev, 0.4);
  });
}
