import { loadSettings, saveSettings, type Phase, type Settings, type DropOptions, type Fold } from './state';
import { Paper } from './ink/paper';
import { canvasForAspect } from './ink/types';
import { InkScene } from './three/scene';
import { wirePainting } from './three/interact';
import { renderPanel } from './ui/panels';
import { api } from './api/client';

const settings: Settings = loadSettings();
let phase: Phase = 'paint';
const folds: Fold[] = [];
let dropOptions: DropOptions = { radius: 40, color: '#1a1a2e', wetness: 0.5 };

const paper = new Paper(canvasForAspect(settings.stream.aspectRatio));
const container = document.getElementById('stage')!;
const scene = new InkScene(paper, container);
wirePainting(scene, paper, () => dropOptions);

function renderLoop(): void {
  scene.render();
  requestAnimationFrame(renderLoop);
}
renderLoop();

export interface HandoffRequest {
  text: string | undefined;
  target: 'film' | 'angle';
}

/** Shared mutable app singleton the UI modules read and write. */
export const app = {
  get phase(): Phase { return phase; },
  set phase(next: Phase) { phase = next; },
  get settings(): Settings { return settings; },
  folds,
  dropOptions,
  paper,
  scene,
  saveSettings(): void { saveSettings(settings); },
  /** Replaces the paper when the stream aspect ratio changes. */
  resizePaper(width: number, height: number): void {
    // Paper dimensions are fixed for the life of a canvas; the studio swaps in
    // a new Paper when the user changes aspect ratio before going live.
    void width;
    void height;
  },
  /** Set by the live studio so the hand-painted flow can hand over a blot. */
  handoff(request: HandoffRequest): void {
    void request;
    window.lastError = 'the live studio is not wired up yet';
    app.phase = 'review';
    renderPanel();
  },
  exitManualMode(): void {
    app.phase = 'paint';
    renderPanel();
  },
};

renderPanel();

void api.health().then((health) => {
  const missing: string[] = [];
  if (!health.openrouter) missing.push('OPENROUTER_API_KEY');
  if (!health.fal) missing.push('FAL_KEY');
  if (missing.length === 0) return;
  const banner = document.createElement('div');
  banner.className = 'banner error';
  banner.textContent = `Server .env is missing ${missing.join(' and ')} — set it and restart npm run dev.`;
  document.getElementById('panel')!.prepend(banner);
}).catch(() => {
  /* the dev server is not up yet */
});
