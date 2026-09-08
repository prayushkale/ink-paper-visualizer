import type { InkScene } from './scene';
import type { DropOptions } from '../state';
import type { Paper } from '../ink/paper';

/** Click/drag on the paper paints a drop at that spot. */
export function wirePainting(scene: InkScene, paper: Paper, getDrop: () => DropOptions): void {
  const el = scene.renderer.domElement;
  let dragging = false;
  const paintAt = (ev: PointerEvent, radiusScale = 1): void => {
    const uv = scene.pointerToUV(ev);
    if (!uv) return;
    const d = getDrop();
    paper.paintDrop(uv.u, uv.v, { ...d, radius: Math.max(10, d.radius * radiusScale) });
    scene.refresh();
  };
  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    paintAt(ev);
  });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('pointerleave', () => { dragging = false; });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    paintAt(ev, 0.4);
  });
}
