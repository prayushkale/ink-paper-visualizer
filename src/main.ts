import { loadSettings, saveSettings, type Phase, type Settings, type Fold, type DropOptions } from './state';
import { Paper } from './ink/paper';
import { InkScene } from './three/scene';
import { wirePainting } from './three/interact';
import { renderPanel } from './ui/panels';

const settings: Settings = loadSettings();
let phase: Phase = 'paint';
const folds: Fold[] = [];
let dropOptions: DropOptions = { radius: 40, color: '#1a1a2e', wetness: 0.5 };

const paper = new Paper();
const container = document.getElementById('stage')!;
const scene = new InkScene(paper, container);

wirePainting(scene, paper, () => dropOptions);

function renderLoop(): void {
  scene.render();
  requestAnimationFrame(renderLoop);
}
renderLoop();

/** Shared mutable app singleton other modules read/write. */
export const app = {
  get phase(): Phase { return phase; },
  set phase(p: Phase) { phase = p; },
  get settings(): Settings { return settings; },
  folds,
  dropOptions,
  paper,
  scene,
  setDrop(d: DropOptions): void { dropOptions = d; },
  saveSettings(): void { saveSettings(settings); },
};

renderPanel();

// health banner if keys missing
fetch('/api/health').then((r) => r.json()).then((h: { openrouter: boolean; fal: boolean }) => {
  if (!h.openrouter || !h.fal) {
    const b = document.createElement('div');
    b.className = 'hint';
    b.style.cssText = 'padding:10px;background:#55333c;border-radius:8px;margin:10px 0';
    b.textContent = !h.openrouter && !h.fal
      ? 'Server .env missing OPENROUTER_API_KEY and FAL_KEY - set them and restart npm run dev.'
      : `Server .env missing ${!h.openrouter ? 'OPENROUTER_API_KEY' : 'FAL_KEY'} - set it and restart.`;
    document.getElementById('panel')!.prepend(b);
  }
}).catch(() => { /* server not running yet */ });
