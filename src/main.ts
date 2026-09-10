import {
  canvasForAspect,
  loadSettings,
  saveSettings,
  type DropOptions,
  type Settings,
} from './state';
import { MOODS, type MoodId } from './presets/moods';
import type { MusicId } from './presets/music';
import { INK_PALETTES } from './ink/recipe';
import { parseSeed } from './ink/rng';
import { Paper } from './ink/paper';
import { InkScene } from './three/scene';
import { wirePainting } from './three/interact';
import { api, type HealthResponse } from './api/client';
import { readShareFromHash } from './share/recipe';
import { InkStudio } from './studio/studio';
import { createRuntimePorts } from './studio/ports';
import { StudioShell, type ShellElements } from './ui/shell';
import { mountManual } from './ui/manual';

const settings: Settings = loadSettings();
let health: HealthResponse | null = null;
let mode: 'studio' | 'manual' = 'studio';

// --------------------------------------------------------------- the paper

const paperHost = document.getElementById('paper')!;
const paper = new Paper(canvasForAspect(settings.stream.aspectRatio));
const scene = new InkScene(paper, paperHost);
const dropOptions: DropOptions = {
  radius: 40,
  color: settings.ink.palette[0] ?? '#141821',
  wetness: 0.5,
};
wirePainting(scene, paper, () => dropOptions);

function renderLoop(): void {
  if (mode === 'manual') scene.render();
  requestAnimationFrame(renderLoop);
}
renderLoop();

// ------------------------------------------------------------- the studio

const player = document.getElementById('player') as HTMLVideoElement;

const studio = new InkStudio({
  settings,
  save: (next) => saveSettings(next),
  health,
  ...createRuntimePorts(),
  onView: (view) => shell.render(view),
});

studio.setVideoElement(player);
player.volume = settings.music.volume;

const elements: ShellElements = {
  app: document.getElementById('app')!,
  topbar: document.getElementById('topbar')!,
  rail: document.getElementById('rail')!,
  filmstrip: document.getElementById('filmstrip')!,
  hud: document.getElementById('hud')!,
  controls: document.getElementById('controls')!,
  controlBody: document.getElementById('control-body')!,
  telemetry: document.getElementById('telemetry')!,
  preflight: document.getElementById('notes')!,
};

const manual = mountManual({
  container: elements.controlBody,
  getPaper: () => paper,
  getScene: () => scene,
  settings,
  dropOptions,
  save: () => saveSettings(settings),
  onHandoff: (blob, thumbDataUri, recipe) => {
    studio.enqueueHandmade(recipe, blob, thumbDataUri);
    setMode('studio');
  },
  onExit: () => setMode('studio'),
});

function setMode(next: 'studio' | 'manual'): void {
  mode = next;
  if (next === 'manual') {
    document.getElementById('app')!.dataset.mode = 'manual';
    scene.resize(paperHost);
    manual.rerender();
    return;
  }
  document.getElementById('app')!.dataset.mode = 'studio';
  shell.refresh();
}

const shell: StudioShell = new StudioShell(
  elements,
  studio,
  {
    start: () => {
      void studio.start().then((result) => {
        if (!result.ok && result.error) shell.showNote(result.error);
      });
    },
    stop: () => void studio.stop(),
    pauseRecording: () => studio.pauseRecording(),
    resumeRecording: () => studio.resumeRecording(),
    enterManual: () => setMode('manual'),

    setMood: (id: MoodId) => {
      studio.updateSettings({
        moodId: id,
        ink: { ...settings.ink, palette: [...MOODS[id].palette] },
      });
    },
    setMoodStrength: (value) => studio.updateSettings({ moodStrength: value }),
    setPalette: (id) => {
      const palette = INK_PALETTES[id];
      if (palette) studio.updateSettings({ ink: { ...settings.ink, palette: [...palette] } });
    },
    setSeed: (raw) => studio.updateSettings({ ink: { ...settings.ink, seed: parseSeed(raw) } }),
    reroll: () => studio.updateSettings({ ink: { ...settings.ink, seed: parseSeed(null) } }),
    setMusic: (id: MusicId) => void studio.setMusic({ musicId: id }),
    setMusicMode: (next) => void studio.setMusic({ mode: next }),
    setMusicUrl: (url) => void studio.setMusic({ customUrl: url.trim() === '' ? null : url.trim() }),
    setMusicFile: (file) => void studio.setMusicFile(file),
    setCamera: (patch) => studio.updateSettings({ camera: { ...settings.camera, ...patch } }),
    setStream: (patch) => studio.updateSettings({ stream: { ...settings.stream, ...patch } }),
    setBudget: (patch) => studio.updateSettings({ budget: { ...settings.budget, ...patch } }),
    setStudioPrompt: (prompt) => studio.updateSettings({ studioPrompt: prompt }),
    setVisionModel: (model) => studio.updateSettings({ openrouterModel: model }),
    setResolution: (resolution) => studio.updateSettings({ stream: { ...settings.stream, resolution } }),
    releaseCurrent: () => studio.releaseCurrent(),
    paintThisOne: () => setMode('manual'),
  },
  () => settings,
  () => health,
);

// ------------------------------------------------------------------- boot

void api
  .health()
  .then((response) => {
    health = response;
  })
  .catch(() => {
    health = null;
  })
  .finally(() => {
    const shared = readShareFromHash(window.location.hash, settings.ink);
    if (shared) studio.applyShare(shared);
    document.getElementById('app')!.dataset.mode = 'studio';
    shell.refresh();
    const missing: string[] = [];
    if (!health) missing.push('the local server is not reachable (start it with npm run dev)');
    else {
      if (!health.fal) missing.push('FAL_KEY');
      if (!health.openrouter) missing.push('OPENROUTER_API_KEY');
    }
    if (missing.length > 0) shell.showNote(`Not ready: ${missing.join(' and ')}. Add them to .env and restart.`);
  });

window.addEventListener('beforeunload', () => {
  saveSettings(settings);
  studio.dispose();
});
