import { defaultInkRecipe } from './ink/recipe';
import type { InkRecipe } from './ink/types';
import { defaultCameraConfig, type CameraConfig } from './presets/camera';
import { DEFAULT_MOOD_ID, type MoodId } from './presets/moods';
import { DEFAULT_MUSIC_ID, type MusicId } from './presets/music';

export type { CameraConfig, CameraMoveId } from './presets/camera';
export type { MoodId, MoodPreset } from './presets/moods';
export type { MusicId, MusicPreset } from './presets/music';
export type { InkRecipe } from './ink/types';
export { INK_TOOLS, canvasForAspect, BLOT_LONG_EDGE } from './ink/types';
export type { AspectRatio, CanvasSpec, Fold, InkOp, InkToolId, UV } from './ink/types';

// ------------------------------------------------------------------ manual

/** Phases of the hand-painted one-clip mode ("Direct it yourself"). */
export type Phase = 'paint' | 'folding' | 'reveal' | 'interpreting' | 'review';

/** Lifecycle of a Director session chain, including chaining seams. */
export type StudioStatus =
  | 'idle'
  | 'preflight'
  | 'connecting'
  | 'live'
  | 'paused'
  | 'chaining'
  | 'stopping'
  | 'ended'
  | 'failed';

export interface DropOptions {
  radius: number;   // px on the canvas, 10-120
  color: string;    // CSS color
  wetness: number;  // 0-1, how far the blot splatters
}

export interface StreamConfig {
  falModel: string;
  /** Immutable for the life of a session; changing it requires a restart. */
  resolution: '480p' | '768p' | '1080p';
  aspectRatio: '16:9' | '9:16' | '1:1';
  /** Prior segment prompts kept as context. 1-50, default 12. */
  memory: number;
  seed: number | null;
  /**
   * 'hard' sends each blot as an exact final frame (`end_image_url`);
   * 'soft' describes it in the prompt only, for a gentler evolution.
   */
  arrivalMode: 'hard' | 'soft';
  /** Open a fresh session when the server ends one, continuing the picture. */
  autoChain: boolean;
}

export interface BudgetConfig {
  /** Hard ceiling of Director video seconds before the stream stops itself. */
  sessionCapSeconds: number;
  sessionCapUsd: number;
  dailyCapUsd: number;
  /** Run the whole pipeline against a fake transport. Costs nothing. */
  dryRun: boolean;
}

export interface MusicConfig {
  musicId: MusicId;
  /**
   * 'pinned' hands the track to the model as `audio_url`, so every chunk is
   * conditioned on it and its PCM is what plays. 'generated' leaves the score
   * to Director via the prompt.
   */
  mode: 'pinned' | 'generated';
  /** A user-supplied track URL; wins over the preset's bundled path. */
  customUrl: string | null;
  /** Uploaded fal URL for the resolved track. Runtime state, never persisted. */
  resolvedUrl: string | null;
  volume: number; // 0-1, playback gain only
}

export interface Settings {
  version: 2;
  /** Vision model that imagines what each blot could be. */
  openrouterModel: string;
  /** Prompt for the manual-mode single-blot interpretation. */
  visionPrompt: string;
  /** Prompt for the live studio: how a blot becomes a stream direction. */
  studioPrompt: string;
  moodId: MoodId;
  /** 0 = hold the current film, 1 = commit fully to the mood. */
  moodStrength: number;
  music: MusicConfig;
  camera: CameraConfig;
  stream: StreamConfig;
  budget: BudgetConfig;
  /** Defaults used when the ink engine invents a new blot. */
  ink: InkRecipe;
  /** Keep the hand-painted route available next to the automatic one. */
  manualModeEnabled: boolean;
  /**
   * Mirrors the server's PROXY_AUTH_TOKEN, when one is set. Runtime-only: it is
   * deliberately absent from share payloads.
   */
  proxyToken: string;
}

// ------------------------------------------------------------- pricing

/** Rates verified 2026-09-08; the H3 Max family is 75% off until this date. */
export const PROMO_ENDS = new Date('2026-09-14T00:00:00Z');

export const DIRECTOR_RATE = { promo: 0.02, list: 0.08, minBilledSeconds: 60 };
export const MULTI_ANGLE_RATE = {
  '480P': { promo: 0.0125, list: 0.05 },
  '768P': { promo: 0.02, list: 0.08 },
  '1080P': { promo: 0.04, list: 0.16 },
} as const;

export type AngleResolution = keyof typeof MULTI_ANGLE_RATE;

export function isPromo(now: Date = new Date()): boolean {
  return now.getTime() < PROMO_ENDS.getTime();
}

export function directorRate(now: Date = new Date()): number {
  return isPromo(now) ? DIRECTOR_RATE.promo : DIRECTOR_RATE.list;
}

export function multiAngleRate(resolution: AngleResolution, now: Date = new Date()): number {
  const tier = MULTI_ANGLE_RATE[resolution] ?? MULTI_ANGLE_RATE['480P'];
  return isPromo(now) ? tier.promo : tier.list;
}

/** Director generates in 10 s chunks; one destination lands per dispatched chunk. */
export const CHUNK_SECONDS = 10;

/** How many blot destinations a run produces, given the angle-per-blot choice. */
export function planDestinations(
  seconds: number,
  anglesPerBlot: number,
): { beats: number; blots: number; beatsPerBlot: number } {
  const beatsPerBlot = Math.max(1, Math.round(anglesPerBlot) + 1);
  const beats = Math.floor(Math.max(0, seconds) / CHUNK_SECONDS);
  const blots = beats === 0 ? 0 : Math.max(1, Math.floor(beats / beatsPerBlot));
  return { beats, beatsPerBlot, blots };
}

export interface RunEstimate {
  sessions: number;
  directorSeconds: number;
  directorUsd: number;
  angleTakes: number;
  angleSeconds: number;
  angleUsd: number;
  totalUsd: number;
  beats: number;
  blots: number;
  beatsPerBlot: number;
}

/**
 * Cost of a planned run. Every session bills at least 60 s of generated video,
 * so a short run split across sessions costs more, not less.
 */
export function estimateRun(
  input: {
    seconds: number;
    sessionCapSeconds: number;
    anglesPerBlot: number;
    angleSeconds: number;
    angleResolution: AngleResolution;
  },
  now: Date = new Date(),
): RunEstimate {
  const seconds = Math.max(0, input.seconds);
  const sessionCap = Math.max(1, input.sessionCapSeconds);
  const sessions = Math.max(1, Math.ceil(seconds / sessionCap));
  let directorSeconds = 0;
  let remaining = seconds;
  for (let i = 0; i < sessions; i++) {
    const slice = Math.min(sessionCap, remaining);
    directorSeconds += Math.max(DIRECTOR_RATE.minBilledSeconds, slice);
    remaining -= slice;
  }
  const rate = directorRate(now);
  const angleRate = multiAngleRate(input.angleResolution, now);
  const { beats, blots, beatsPerBlot } = planDestinations(seconds, input.anglesPerBlot);
  const angleTakes = Math.round(blots * Math.max(0, input.anglesPerBlot));
  const angleSeconds = angleTakes * Math.max(0, input.angleSeconds);
  return {
    sessions,
    directorSeconds,
    directorUsd: directorSeconds * rate,
    angleTakes,
    angleSeconds,
    angleUsd: angleSeconds * angleRate,
    totalUsd: directorSeconds * rate + angleSeconds * angleRate,
    beats,
    blots,
    beatsPerBlot,
  };
}

export function minutesLabel(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// --------------------------------------------------------------- defaults

export const DEFAULT_VISION_PROMPT = `You are a visionary film director. Study this abstract ink blot painting. Let its shapes, colors and negative space suggest something only you can see - figures, landscapes, creatures, weather, machines, dreams. Then write ONE vivid video-generation prompt for a short cinematic video that STARTS exactly from this painting as its first frame and then comes alive and evolves into what you imagined. Describe subject, motion, camera movement, lighting and mood. Output ONLY the video prompt text, under 150 words, no preamble.`;

/** Asks the vision model for machine-readable direction, not prose. */
export const DEFAULT_STUDIO_PROMPT = `You are the director of a single continuous, unbroken film that the viewer watches live. You are shown one abstract ink blot at a time. The blot is real: it is a genuine ink-and-fold painting, not a render.

Read the blot's shapes, colours and negative space and decide what ONLY YOU can see in it. Then translate that into the next beat of the film.

Rules:
- One beat is a MOMENT, not a summary. Say what is happening now and what it becomes.
- Keep the film's world, palette and camera language continuous with the beats before it. Never restart, never cut to a title, never address the viewer.
- The closing frame of your beat must be able to land exactly on this blot, so describe the blot's own composition as the thing the moment resolves into.
- Abstract and painterly is preferred. Never name a real person, a brand, or legible on-screen text.
- Describe sound as part of the beat.

Reply with ONLY a JSON object, no markdown fence:
{"subject": "<a few words naming what you see>", "prompt": "<40-90 words: the beat>", "transition": "<3-8 words: how the previous picture becomes this one>", "moodTags": ["<2-4 lowercase tags>"], "sound": "<8-20 words: the sound of this beat>"}`;

export const DEFAULT_BUDGET: BudgetConfig = {
  sessionCapSeconds: 120,
  sessionCapUsd: 5,
  dailyCapUsd: 20,
  dryRun: false,
};

const LS_KEY = 'ink-paper-studio-v2';
const LS_KEY_V1 = 'ink-paper-settings-v1';

export function defaultSettings(): Settings {
  return {
    version: 2,
    openrouterModel: 'z-ai/glm-5.3-flash',
    visionPrompt: DEFAULT_VISION_PROMPT,
    studioPrompt: DEFAULT_STUDIO_PROMPT,
    moodId: DEFAULT_MOOD_ID,
    moodStrength: 0.7,
    music: {
      musicId: DEFAULT_MUSIC_ID,
      mode: 'pinned',
      customUrl: null,
      resolvedUrl: null,
      volume: 0.6,
    },
    camera: defaultCameraConfig(),
    stream: {
      falModel: 'minimax/h3-max/director',
      resolution: '768p',
      aspectRatio: '16:9',
      memory: 12,
      seed: null,
      arrivalMode: 'hard',
      autoChain: true,
    },
    budget: { ...DEFAULT_BUDGET },
    ink: defaultInkRecipe(),
    manualModeEnabled: true,
    proxyToken: '',
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function merge(target: object, patch: unknown): void {
  if (!isPlainObject(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    const current = (target as Record<string, unknown>)[key];
    if (isPlainObject(current)) {
      // Config objects only ever merge. A scalar or null here is a hostile or
      // stale payload trying to erase a required section, so it is ignored.
      if (isPlainObject(value)) merge(current, value);
      continue;
    }
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

/** Tolerant merge that survives partial, older or hostile payloads. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const out = structuredClone(base);
  merge(out, patch);
  out.version = 2;
  // runtime-only fields must never arrive from a stored or shared payload
  out.music.resolvedUrl = null;
  out.camera.anglesPerBlot = clampNumber(Math.round(out.camera.anglesPerBlot), 0, 4);
  out.stream.memory = clampNumber(Math.round(out.stream.memory), 1, 50);
  out.budget.sessionCapSeconds = clampNumber(Math.round(out.budget.sessionCapSeconds), 60, 900);
  out.moodStrength = clampNumber(out.moodStrength, 0, 1);
  out.music.volume = clampNumber(out.music.volume, 0, 1);
  return out;
}

/** Reads v2, else migrates the v1 blob (model + prompt only), else defaults. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  const base = defaultSettings();
  if (!storage) return base;
  try {
    const raw = storage.getItem(LS_KEY);
    if (raw) return mergeSettings(base, JSON.parse(raw));
    const legacy = storage.getItem(LS_KEY_V1);
    if (legacy) {
      const old = JSON.parse(legacy) as { openrouterModel?: string; visionPrompt?: string };
      if (typeof old.openrouterModel === 'string') base.openrouterModel = old.openrouterModel;
      if (typeof old.visionPrompt === 'string') base.visionPrompt = old.visionPrompt;
    }
  } catch {
    /* corrupt payload: fall through to defaults */
  }
  return base;
}

export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* quota or private mode: settings simply do not persist */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
