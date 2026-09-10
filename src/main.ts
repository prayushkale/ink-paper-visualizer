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
import { api, type HealthResponse } from './api/client';
import { readShareFromHash } from './share/recipe';
import { InkStudio } from './studio/studio';
import { createRuntimePorts } from './studio/ports';
import { setProxyToken } from './fal';
import { StudioShell, type ShellElements } from './ui/shell';
import { mountManual } from './ui/manual';
import type { Paper } from './ink/paper';
import type { InkScene } from './three/scene';

const settings: Settings = loadSettings();
// the proxy only requires this when the server sets PROXY_AUTH_TOKEN
setProxyToken(settings.proxyToken || null);
let health: HealthResponse | null = null;
let mode: 'studio' | 'manual' = 'studio';

const dropOptions: DropOptions = {
  radius: 40,
  color: settings.ink.palette[0] ?? '#141821',
  wetness: 0.5,
};

// ------------------------------------------------------------- lazy paper

/**
 * three.js is only needed for the hand-painted editor, so it is loaded on
 * demand: the studio opens on the film, not on a 600 KB 3D engine.
 */
let paper: Paper | null = null;
let scene: InkScene | null = null;
let loadingPaper: Promise<void> | null = null;

async function ensurePaper(): Promise<void> {
  if (paper && scene) return;
  if (loadingPaper) return loadingPaper;
  loadingPaper = (async () => {
    const [{ InkScene: Scene }, { Paper: PaperClass }, { wirePainting }] = await Promise.all([
      import('./three/scene'),
      import('./ink/paper'),
      import('./three/interact'),
    ]);
    const host = document.getElementById('paper')!;
    const created = new PaperClass(canvasForAspect(settings.stream.aspectRatio));
    const view = new Scene(created, host);
    wirePainting(view, created, () => dropOptions);
    paper = created;
    scene = view;
  })();
  return loadingPaper;
}

function renderLoop(): void {
  if (mode === 'manual' && scene) scene.render();
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
// the stream carries native audio, and by the time anything arrives the user
// has already pressed Start, so playback is permitted: do not start muted
player.muted = false;
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

let manual: ReturnType<typeof mountManual> | null = null;

function setMode(next: 'studio' | 'manual'): void {
  mode = next;
  const app = elements.app;
  if (next === 'manual') {
    app.dataset.mode = 'manual';
    void ensurePaper().then(() => {
      const host = document.getElementById('paper')!;
      scene?.resize(host);
      if (!manual) {
        manual = mountManual({
          container: elements.controlBody,
          getPaper: () => {
            if (!paper) throw new Error('the paper is still loading');
            return paper;
          },
          getScene: () => {
            if (!scene) throw new Error('the paper is still loading');
            return scene;
          },
          settings,
          dropOptions,
          save: () => saveSettings(settings),
          onHandoff: (blob, thumbDataUri, recipe) => {
            studio.enqueueHandmade(recipe, blob, thumbDataUri);
            setMode('studio');
          },
          onExit: () => setMode('studio'),
        });
      } else {
        manual.rerender();
      }
    });
    return;
  }
  app.dataset.mode = 'studio';
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
    setProxyToken: (token) => {
      setProxyToken(token || null);
      studio.updateSettings({ proxyToken: token });
    },
    setResolution: (resolution) => studio.updateSettings({ stream: { ...settings.stream, resolution } }),
    releaseCurrent: () => studio.releaseCurrent(),
    paintThisOne: () => setMode('manual'),
  },
  () => settings,
  () => health,
);

void player.addEventListener('volumechange', () => {
  settings.music.volume = player.volume;
  saveSettings(settings);
});

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
    elements.app.dataset.mode = 'studio';
    // #watch=1 drops the configuration so the film can sit on a screen
    shell.setWatch(/[#&?]watch(=1)?\b/.test(window.location.hash + window.location.search));
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
