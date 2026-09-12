import {
  applyQualityPreset,
  canvasForAspect,
  loadSettings,
  saveSettings,
  type DropOptions,
  type Settings,
} from './state';
import type { MoodId } from './presets/moods';
import type { MusicId } from './presets/music';
import { INK_COLOR_RANGE } from './ink/recipe';
import { parseSeed } from './ink/rng';
import { api, type HealthResponse } from './api/client';
import { readShareFromHash } from './share/recipe';
import { InkStudio } from './studio/studio';
import { createRuntimePorts } from './studio/ports';
import { setProxyToken } from './fal';
import { StudioShell, type ShellElements } from './ui/shell';
import { createPrefsStore } from './ui/prefs';
import { applyTheme } from './ui/theme';
import { mountManual } from './ui/manual';
import type { Paper } from './ink/paper';
import type { InkScene } from './three/scene';

const settings: Settings = loadSettings();
/**
 * What the page remembers about itself: the view you were in, the brush, the
 * mute button, spectator mode. Run settings are separate (see `loadSettings`),
 * because those are worth sharing and these are not.
 */
const prefs = createPrefsStore();
// index.html already set this before the first paint; putting it back through
// the module makes the store the authority rather than the copy in the shell
applyTheme(prefs.state().theme);
// the proxy only requires this when the server sets PROXY_AUTH_TOKEN
setProxyToken(settings.proxyToken || null);
let health: HealthResponse | null = null;
let mode: 'studio' | 'manual' = 'studio';

/** 10-120 px: the whole span the size slider exposes. */
function randomRadius(): number {
  return 10 + Math.floor(Math.random() * 111);
}

/**
 * 0.25-0.8, in the slider's own 0.05 steps. The band is the one the automatic
 * engine rolls its blots from, so a hand-painted drop opens in the middle of
 * that range rather than at a bone-dry or a sopping extreme.
 */
function randomWetness(): number {
  return Math.round((0.25 + Math.random() * 0.55) * 20) / 20;
}

const storedBrush = prefs.state().brush;
/**
 * A stored colour is the only proof the brush was ever touched, so an empty one
 * means there is nothing to come back to. The shipped 40 px / 0.50 then read as
 * choices somebody made, so a first visit rolls all three at random instead.
 */
const freshBrush = storedBrush.color === '';
const dropOptions: DropOptions = {
  radius: freshBrush ? randomRadius() : storedBrush.radius,
  // the brush opens on the pigment it was left on; a first visit has none, so
  // it picks one at random (the colour can still be changed)
  color: storedBrush.color || INK_COLOR_RANGE[Math.floor(Math.random() * INK_COLOR_RANGE.length)] || '#141821',
  wetness: freshBrush ? randomWetness() : storedBrush.wetness,
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
    // CSS sizes the phone's stage off the sheet's shape; the camera fit keeps
    // the sheet centred inside it either way
    document.documentElement.style.setProperty(
      '--paper-aspect', String(created.spec.width / created.spec.height),
    );
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
// has already pressed Start, so playback is permitted: a fresh visit starts
// unmuted, and a later one starts the way the mute button was left
player.muted = prefs.state().muted;
player.volume = settings.music.volume;

const elements: ShellElements = {
  app: document.getElementById('app')!,
  topbar: document.getElementById('topbar')!,
  rail: document.getElementById('rail')!,
  filmstrip: document.getElementById('filmstrip')!,
  hud: document.getElementById('hud')!,
  film: document.getElementById('film')!,
  painting: document.getElementById('painting')!,
  viewer: document.getElementById('viewer')!,
  preparing: document.getElementById('preparing')!,
  controls: document.getElementById('controls')!,
  controlBody: document.getElementById('control-body')!,
  telemetry: document.getElementById('telemetry')!,
  preflight: document.getElementById('notes')!,
  toasts: document.getElementById('toasts')!,
};

let manual: ReturnType<typeof mountManual> | null = null;

function setMode(next: 'studio' | 'manual'): void {
  mode = next;
  // the view survives a refresh; the paper under it does not, so a restored
  // painting session opens on a clean sheet rather than pretending otherwise
  prefs.set('mode', next);
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
          onBrushChanged: (drop) => prefs.setBrush({ color: drop.color, radius: drop.radius, wetness: drop.wetness }),
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
    clearSession: () => void studio.clearSession(),
    pauseFilm: () => studio.pauseFilm(),
    resumeFilm: () => studio.resumeFilm(),
    enterManual: () => setMode('manual'),

    setQuality: (id) => studio.updateSettings(applyQualityPreset(settings, id)),
    setMood: (id: MoodId) => studio.updateSettings({ moodId: id }),
    setMoodStrength: (value) => studio.updateSettings({ moodStrength: value }),
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
  prefs,
);

void player.addEventListener('volumechange', () => {
  settings.music.volume = player.volume;
  prefs.set('muted', player.muted);
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
    // the studio was built before this resolved, so hand it the answer
    studio.setHealth(health);
    const shared = readShareFromHash(window.location.hash, settings.ink);
    if (shared) studio.applyShare(shared);
    elements.app.dataset.mode = 'studio';
    // #watch=1 drops the configuration so the film can sit on a screen; the URL
    // is the louder signal, and the stored preference carries a reload of it
    const watched = /[#&?]watch(=1)?\b/.test(window.location.hash + window.location.search);
    shell.setWatch(watched || prefs.state().watch);
    shell.refresh();
    // A shared run is a studio run, and a watched screen has no controls to put
    // the painting mode into, so only a plain visit reopens where it was left.
    if (!shell.watchOnly && !shared && prefs.state().mode === 'manual') setMode('manual');
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
