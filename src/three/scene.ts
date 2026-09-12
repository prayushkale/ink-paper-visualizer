import * as THREE from 'three';
import { Paper } from '../ink/paper';
import type { Fold } from '../state';
import { stageColor, THEME_EVENT } from '../ui/theme';
import { paperFitDistance, paperFrame } from './fit';

export class InkScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private scene = new THREE.Scene();
  private paperMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private texture: THREE.CanvasTexture;
  private foldMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private foldPivot: THREE.Group | null = null;
  private animating = false;
  private resizeObserver: ResizeObserver;
  /** Half-extents of the sheet in world units; the plane matches the canvas. */
  private frame: ReturnType<typeof paperFrame>;

  constructor(private paper: Paper, container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 3);
    // the backdrop belongs to the page, so it is taken from the theme rather
    // than fixed here: a canvas cannot read a custom property on its own
    this.scene.background = new THREE.Color(stageColor());
    this.texture = new THREE.CanvasTexture(paper.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // the frame is the film's, not a square: see paperFrame
    this.frame = paperFrame(paper.spec);
    const geo = new THREE.PlaneGeometry(this.frame.halfWidth * 2, this.frame.halfHeight * 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture });
    this.paperMesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.paperMesh);
    window.addEventListener('resize', () => this.resize(container));
    window.addEventListener(THEME_EVENT, () => {
      this.scene.background = new THREE.Color(stageColor());
      this.render();
    });
    // the stage also changes size without the window moving — switching modes
    // in and out of the editor is the common case — so watch the box itself
    this.resizeObserver = new ResizeObserver(() => this.resize(container));
    this.resizeObserver.observe(container);
    this.resize(container);
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth, h = container.clientHeight;
    // a hidden container measures 0x0; sizing the renderer to that would leave
    // a blank canvas behind on the way back in
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // Pull the camera back until both axes fit with a margin, so the blot stays
    // centred and fills as much of the stage as its shape allows, phone or desk
    this.camera.position.z = paperFitDistance(this.camera.fov, this.camera.aspect, this.frame.halfWidth);
    this.camera.updateProjectionMatrix();
  }

  /** Flip the texture (canvas changed underneath). */
  refresh(): void {
    this.texture.needsUpdate = true;
  }

  /**
   * Animate a fold over `ms`, then commit pixels and clean up.
   * The overlay half-plane rotates 180 deg around the center crease line.
   */
  fold(fold: Fold, ms = 1200): Promise<void> {
    return new Promise((resolve) => {
      if (this.animating) return resolve();
      this.animating = true;
      const { halfWidth, halfHeight } = this.frame;
      const vertical = fold.axis === 'vertical';
      // the flap is exactly half the sheet, hinged on the crease line
      const w = vertical ? halfWidth : halfWidth * 2;
      const h = vertical ? halfHeight * 2 : halfHeight;
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, side: THREE.DoubleSide,
      });
      this.foldMesh = new THREE.Mesh(geo, mat);
      const restPos = vertical
        ? new THREE.Vector3(fold.direction === 'left' ? -halfWidth / 2 : halfWidth / 2, 0, 0)
        : new THREE.Vector3(0, fold.direction === 'top' ? halfHeight / 2 : -halfHeight / 2, 0);
      this.foldMesh.position.copy(restPos);
      this.foldPivot = new THREE.Group();
      this.scene.add(this.foldPivot);
      this.foldPivot.add(this.foldMesh);
      const start = performance.now();
      const tick = (): void => {
        const t = Math.min(1, (performance.now() - start) / ms);
        const eased = t * t * (3 - 2 * t); // smoothstep
        const angle = eased * Math.PI;
        // the flap swings about the crease, so its centre traces a half circle
        // of the flap's own half-width (or half-height) around the pivot
        const swing = (vertical ? halfWidth : halfHeight) / 2;
        if (vertical) {
          this.foldPivot!.rotation.y = angle * (fold.direction === 'left' ? 1 : -1);
          this.foldMesh!.position.x = restPos.x * Math.cos(angle);
          this.foldMesh!.position.z = Math.sin(angle) * swing;
        } else {
          this.foldPivot!.rotation.x = angle * (fold.direction === 'top' ? -1 : 1);
          this.foldMesh!.position.y = restPos.y * Math.cos(angle);
          this.foldMesh!.position.z = Math.sin(angle) * swing;
        }
        this.renderer.render(this.scene, this.camera);
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          this.scene.remove(this.foldPivot!);
          this.foldMesh = null;
          this.foldPivot = null;
          this.animating = false;
          this.paper.commitFold(fold);   // authoritative pixel commit
          this.refresh();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** UV for a pointer event; null if outside the paper. u,v in [0,1], v top-down. */
  pointerToUV(ev: PointerEvent): { u: number; v: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = ray.intersectObject(this.paperMesh)[0];
    if (!hit || !hit.uv) return null;
    return { u: hit.uv.x, v: 1 - hit.uv.y };
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
