import {
  CHUNK_SECONDS,
  DEFAULT_STUDIO_PROMPT,
  DIRECTOR_RATE,
  estimateRun,
  minutesLabel,
  usd,
  type Settings,
} from '../state';
import { CAMERA_MOVES, CAMERA_MOVE_IDS, type CameraConfig, type CameraMoveId } from '../presets/camera';
import { MOODS, MOOD_IDS, type MoodId } from '../presets/moods';
import { MUSIC_IDS, MUSIC_PRESETS, musicById, type MusicId } from '../presets/music';
import { INK_PALETTES, PALETTE_IDS } from '../ink/recipe';
import { renderOps } from '../ink/recipe';
import { orbitDiagram } from './rail';
import type { StudioView } from '../studio/studio';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ControlActions {
  setMood(id: MoodId): void;
  setMoodStrength(value: number): void;
  setPalette(id: string): void;
  setSeed(value: string): void;
  reroll(): void;
  setMusic(id: MusicId): void;
  setMusicMode(mode: 'pinned' | 'generated'): void;
  setMusicUrl(url: string): void;
  setMusicFile(file: File): void;
  setCamera(patch: Partial<CameraConfig>): void;
  setStream(patch: Partial<Settings['stream']>): void;
  setBudget(patch: Partial<Settings['budget']>): void;
  setStudioPrompt(prompt: string): void;
  setVisionModel(model: string): void;
  setProxyToken(token: string): void;
  setResolution(resolution: Settings['stream']['resolution']): void;
  releaseCurrent(): void;
  paintThisOne(): void;
}

/** Everything the user can configure, grouped so a phone can scroll it. */
export function renderControls(
  root: HTMLElement,
  view: StudioView,
  settings: Settings,
  actions: ControlActions,
): void {
  const camera = settings.camera;
  const mood = MOODS[settings.moodId];
  const music = musicById(settings.music.musicId);
  const live = view.status === 'live' || view.status === 'connecting' || view.status === 'chaining' || view.status === 'paused';
  const lockedNote = live ? '<p class="muted small">Locked while a session is open — restart to change.</p>' : '';

  root.innerHTML = `
    <details open>
      <summary>Stream</summary>
      <div class="pad">
        ${lockedNote}
        <label>Resolution
          <select data-change="stream.resolution" ${live ? 'disabled' : ''}>
            ${(['480p', '768p', '1080p'] as const).map((option) => `
              <option value="${option}" ${settings.stream.resolution === option ? 'selected' : ''}>
                ${option}${option === '480p' ? ' · cheapest, good for a test run' : option === '768p' ? ' · the tier the model was tuned for' : ''}
              </option>`).join('')}
          </select>
        </label>
        <label>Frame
          <select data-change="stream.aspectRatio" ${live ? 'disabled' : ''}>
            ${(['16:9', '9:16', '1:1'] as const).map((option) => `
              <option value="${option}" ${settings.stream.aspectRatio === option ? 'selected' : ''}>${option}</option>`).join('')}
          </select>
        </label>
        <p class="muted small">The blot canvas is rendered at this ratio, because the orbit takes inherit it.</p>

        <label>Memory <span class="muted">${settings.stream.memory} prior beats</span>
          <input type="range" min="1" max="50" value="${settings.stream.memory}" data-input="stream.memory" />
        </label>
        <p class="muted small">Higher memory holds a longer story; lower lets the film turn harder on each direction.</p>

        <label>How a blot arrives
          <select data-change="stream.arrivalMode">
            <option value="hard" ${settings.stream.arrivalMode === 'hard' ? 'selected' : ''}>land exactly on it (the beat resolves into the blot)</option>
            <option value="soft" ${settings.stream.arrivalMode === 'soft' ? 'selected' : ''}>describe it only (gentler, looser)</option>
          </select>
        </label>

        <label class="check">
          <input type="checkbox" data-change="stream.autoChain" ${settings.stream.autoChain ? 'checked' : ''} />
          Keep going by chaining new sessions
        </label>
        <p class="muted small">A session is not resumable, so a long film is a chain. The next one opens on the last frame, or on another angle of the same blot.</p>

        <label>Proxy token <input type="text" data-input="proxyToken" value="${esc(settings.proxyToken)}" placeholder="only if the server sets PROXY_AUTH_TOKEN" /></label>
        <label>Seed <input type="text" value="${settings.ink.seed}" data-input="ink.seed" placeholder="any number or word" /></label>
        <div class="row">
          <button class="secondary" data-action="reroll">New seed</button>
          <button class="secondary" data-action="paint">Paint one myself</button>
        </div>
      </div>
    </details>

    <details open>
      <summary>Mood</summary>
      <div class="pad">
        <div class="chips">
          ${MOOD_IDS.map((id) => `
            <button class="chip-button ${id === settings.moodId ? 'on' : ''}" data-action="mood" data-value="${id}">
              ${MOODS[id].label}
            </button>`).join('')}
        </div>
        <p class="muted small">${esc(mood.lead)}</p>
        <label>Mood pressure <span class="muted">${settings.moodStrength.toFixed(2)}</span>
          <input type="range" min="0" max="1" step="0.05" value="${settings.moodStrength}" data-input="moodStrength" />
        </label>
        <p class="muted small">At 1 the mood colours every frame; at 0 the film keeps its own momentum. Changing mood mid-film sends a direction, never a new session.</p>
        <label>Ink palette
          <select data-change="palette">
            ${PALETTE_IDS.map((id) => `
              <option value="${id}" ${sameColors(INK_PALETTES[id]!, settings.ink.palette) ? 'selected' : ''}>${id}</option>`).join('')}
          </select>
        </label>
        <div class="swatches">
          ${settings.ink.palette.map((color) => `<span class="swatch" style="background:${esc(color)}" title="${esc(color)}"></span>`).join('')}
        </div>
      </div>
    </details>

    <details>
      <summary>Music</summary>
      <div class="pad">
        <div class="segmented">
          <button class="${settings.music.mode === 'pinned' ? 'on' : ''}" data-action="music-mode" data-value="pinned">Pin a track</button>
          <button class="${settings.music.mode === 'generated' ? 'on' : ''}" data-action="music-mode" data-value="generated">Model scores it</button>
        </div>
        <p class="muted small">${settings.music.mode === 'pinned'
          ? 'The track is handed to the model as conditioning audio: every chunk is generated against the next window of it, and its PCM is what plays. That replaces the model\'s own dialogue and foley.'
          : 'The genre shapes the beat prompts and the model writes the sound in the same pass as the picture.'}</p>
        <div class="chips">
          ${MUSIC_IDS.map((id) => `
            <button class="chip-button ${id === settings.music.musicId ? 'on' : ''}" data-action="music" data-value="${id}">
              ${MUSIC_PRESETS[id].label}
            </button>`).join('')}
        </div>
        <p class="muted small">${esc(music.brief)} · ${music.bpm} BPM</p>
        <label>Track URL <input type="text" data-input="music.customUrl" value="${esc(settings.music.customUrl ?? '')}" placeholder="https://… or leave blank to use the bundled file" /></label>
        <label class="file">Or drop an audio file
          <input type="file" accept="audio/*" data-input="music.file" />
        </label>
        <p class="muted small">Status: ${esc(view.music.status)}${view.music.resolvedUrl ? ` · hosted ✓${view.music.durationSeconds ? ` ${Math.round(view.music.durationSeconds)}s` : ''}` : ''}</p>
      </div>
    </details>

    <details open>
      <summary>Camera (Multi Angle)</summary>
      <div class="pad">
        <label class="check">
          <input type="checkbox" data-change="camera.enabled" ${camera.enabled ? 'checked' : ''} />
          Orbit each blot before moving on
        </label>
        <p class="muted small">The film arrives at the blot, then at other viewpoints of the same blot, so it reads as one object explored in 3D rather than a slideshow.</p>
        <div class="chips">
          ${CAMERA_MOVE_IDS.map((id) => `
            <button class="chip-button ${camera.moves.includes(id) ? 'on' : ''}" data-action="camera-move" data-value="${id}">
              ${CAMERA_MOVES[id].label}
            </button>`).join('')}
        </div>
        ${orbitDiagram(camera.moves)}
        <label>Angles per blot <span class="muted">${camera.anglesPerBlot}</span>
          <input type="range" min="0" max="4" value="${camera.anglesPerBlot}" data-input="camera.anglesPerBlot" />
        </label>
        <label>Orbit resolution
          <select data-change="camera.resolution">
            ${(['480P', '768P', '1080P'] as const).map((option) => `
              <option value="${option}" ${camera.resolution === option ? 'selected' : ''}>${option}${option === '1080P' ? ' · upscaled from 768p' : ''}</option>`).join('')}
          </select>
        </label>
        <label>Orbit length <span class="muted">${camera.duration}s</span>
          <input type="range" min="5" max="15" value="${camera.duration}" data-input="camera.duration" />
        </label>
        <label class="check">
          <input type="checkbox" data-change="camera.repeatAngleCycle" ${camera.repeatAngleCycle ? 'checked' : ''} />
          Circle a blot twice before moving on
        </label>
        <label>At a handover, start the next session on
          <select data-change="camera.handoff">
            <option value="continue" ${camera.handoff === 'continue' ? 'selected' : ''}>the last frame — invisible seam</option>
            <option value="turn" ${camera.handoff === 'turn' ? 'selected' : ''}>a different angle — a deliberate cut</option>
          </select>
        </label>
        <button class="secondary" data-action="release" ${view.current ? '' : 'disabled'}>Move on from this blot</button>
      </div>
    </details>

    <details>
      <summary>Budget</summary>
      <div class="pad">
        <label>Session cap <span class="muted">${usd(settings.budget.sessionCapUsd)}</span>
          <input type="range" min="1" max="40" step="0.5" value="${settings.budget.sessionCapUsd}" data-input="budget.sessionCapUsd" />
        </label>
        <label>Daily cap <span class="muted">${usd(settings.budget.dailyCapUsd)}</span>
          <input type="range" min="1" max="200" step="1" value="${settings.budget.dailyCapUsd}" data-input="budget.dailyCapUsd" />
        </label>
        <label>Session length <span class="muted">${minutesLabel(settings.budget.sessionCapSeconds)}</span>
          <input type="range" min="60" max="900" step="30" value="${settings.budget.sessionCapSeconds}" data-input="budget.sessionCapSeconds" />
        </label>
        <label class="check">
          <input type="checkbox" data-change="budget.dryRun" ${settings.budget.dryRun ? 'checked' : ''} />
          Dry run — rehearse the whole pipeline, spend nothing
        </label>
        <p class="muted small">
          Director bills $${DIRECTOR_RATE.promo.toFixed(2)}/s during the launch discount and $${DIRECTOR_RATE.list.toFixed(2)}/s after,
          with a ${DIRECTOR_RATE.minBilledSeconds}s minimum per session. The film stops itself at these caps.
        </p>
        <div class="estimate">${esc(estimateLine(settings))}</div>
      </div>
    </details>

    <details>
      <summary>Vision &amp; prompts</summary>
      <div class="pad">
        <label>Vision model (OpenRouter)
          <input type="text" data-input="openrouterModel" value="${esc(settings.openrouterModel)}" />
        </label>
        <label>How a blot becomes a beat
          <textarea rows="12" data-input="studioPrompt">${esc(settings.studioPrompt)}</textarea>
        </label>
        <button class="secondary" data-action="reset-studio-prompt">Reset this prompt</button>
        <p class="muted small">${renderOps(settings.ink).length} strokes make the current blot · ${CHUNK_SECONDS}s per destination.</p>
      </div>
    </details>`;
}

function estimateLine(settings: Settings): string {
  const estimate = estimateRun({
    seconds: settings.budget.sessionCapSeconds,
    sessionCapSeconds: settings.budget.sessionCapSeconds,
    anglesPerBlot: settings.camera.enabled ? settings.camera.anglesPerBlot : 0,
    angleSeconds: settings.camera.duration,
    angleResolution: settings.camera.resolution,
  });
  return `One full session of ${minutesLabel(settings.budget.sessionCapSeconds)}: ${estimate.beats} destinations over ${estimate.blots} blot${estimate.blots === 1 ? '' : 's'}, `
    + `${estimate.angleTakes} orbit takes ≈ ${usd(estimate.totalUsd)} (Director ${usd(estimate.directorUsd)} + orbits ${usd(estimate.angleUsd)}).`;
}

function sameColors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((color, index) => color === b[index]);
}

export { DEFAULT_STUDIO_PROMPT };
