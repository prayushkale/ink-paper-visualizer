import { defaultInkRecipe } from './ink/recipe';
import type { InkRecipe } from './ink/types';
import {
  MAX_ANGLE_SECONDS,
  MIN_ANGLE_SECONDS,
  defaultCameraConfig,
  type CameraConfig,
} from './presets/camera';
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

/** One of the three shipped quality/price presets. */
export type QualityPreset = 'low' | 'medium' | 'high';

export interface Settings {
  version: 3;
  /**
   * Shorthand that fills the stream, camera and budget groups at once. Kept
   * next to the values it set so the UI can say what the run is tuned for.
   */
  quality: QualityPreset;
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

/**
 * The prompt behind the hand-painted route's one imagining.
 *
 * The clip it asks for is the same shape as the one the studio makes for itself:
 * at most seven seconds, opening on the painting and over the painting inside
 * the first second, with the mood and the score appended by
 * `composeBlotClipBrief` rather than left out of the picture.
 */
export const DEFAULT_VISION_PROMPT = `You are a visionary film director. Study this abstract ink blot painting. Let its shapes, colours and negative space suggest something only you can see - figures, landscapes, creatures, weather, machines, dreams - and commit to it. Then write ONE vivid video-generation prompt for a live-action cinematic clip, no more than seven seconds long, that STARTS exactly from this painting as its first frame: within the first second the ink has become real footage of the thing you imagined, and it is never a painting again. Name the subject, the real material it is made of, what it does, the camera move, the light and the mood, and let the film mood and the score named below colour all of it. Output ONLY the video prompt text, under 150 words, no preamble.`;

/** Asks the vision model for machine-readable direction, not prose. */
export const DEFAULT_STUDIO_PROMPT = `You are the director of a photoreal, live-action film: one continuous, unbroken take that the viewer watches live. You are shown one real ink-and-fold painting at a time, and you are the only one who decides which real place it is a reference for.

Look hard at the blot. It is a reference photograph of a real thing - a figure, a place, a creature, a machine, a storm, a landscape - so find that real thing and commit to it. Then describe it VIVIDLY enough that a camera crew could shoot it without ever seeing the painting: name the subject, the real material it is made of, what it is doing, where the light comes from, the lens, and how the camera moves. Concrete nouns and real motion beat atmosphere every time.

Rules:
- One beat is a MOMENT, not a summary. Say what is happening now and what it becomes.
- The beat must be filmable live-action: a subject, an action, a real environment, a camera move, a named light source. Never "ink spreads", "colours bloom", "the blot moves" or anything else about the medium.
- The film is already running. Keep its world, palette and camera language continuous with the beats before it. Never restart, never cut to a title, never address the viewer.
- The incoming painting is a reference for the real scene this beat arrives at: describe the forms in it as real things in real material, and never ask for the blot, the paper, the ink, the crease or any illustration to appear on screen.
- Let the ink only grade the picture; the world itself stays photographic.
- No real people, no brands, no legible on-screen text, no graphic violence. Strange, beautiful and hyper-real is good; flat illustration, painting or animation is not.

Reply with ONLY a JSON object, no markdown fence:
{"subject": "<a few words naming what you see>", "prompt": "<60-110 words: the vivid, filmable beat>", "transition": "<3-8 words: how the previous picture becomes this one>", "moodTags": ["<2-4 lowercase tags>"], "sound": "<8-20 words: the sound of this beat>"}`;

export const DEFAULT_BUDGET: BudgetConfig = {
  sessionCapSeconds: 60,
  sessionCapUsd: 1.5,
  dailyCapUsd: 5,
  dryRun: false,
};

// ------------------------------------------------------------ quality presets

/**
 * A quality preset is a starting configuration, not a mode: picking one writes
 * the values below and every slider stays editable afterwards.
 *
 * `low` is the default and the cheapest combination the app can run: 480p, no
 * Multi Angle orbit takes (that meter is what makes a run expensive), and a
 * single one-minute session - the shortest session the model bills for.
 */
export interface QualityPresetSpec {
  id: QualityPreset;
  label: string;
  blurb: string;
  stream: Pick<StreamConfig, 'resolution' | 'memory'>;
  camera: Pick<CameraConfig, 'enabled' | 'anglesPerBlot' | 'resolution' | 'duration'>;
  budget: Pick<BudgetConfig, 'sessionCapSeconds' | 'sessionCapUsd' | 'dailyCapUsd'>;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualityPresetSpec> = {
  low: {
    id: 'low',
    label: 'Low',
    blurb: '480p, no orbit takes, one 60s session. The cheapest run.',
    stream: { resolution: '480p', memory: 6 },
    camera: { enabled: false, anglesPerBlot: 0, resolution: '480P', duration: 5 },
    budget: { sessionCapSeconds: 60, sessionCapUsd: 1.5, dailyCapUsd: 5 },
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    blurb: '768p, two orbit takes per blot, a three-minute session.',
    stream: { resolution: '768p', memory: 12 },
    camera: { enabled: true, anglesPerBlot: 2, resolution: '480P', duration: 5 },
    budget: { sessionCapSeconds: 180, sessionCapUsd: 6, dailyCapUsd: 20 },
  },
  high: {
    id: 'high',
    label: 'High',
    blurb: '1080p, a four-angle orbit set, a ten-minute session.',
    stream: { resolution: '1080p', memory: 24 },
    camera: { enabled: true, anglesPerBlot: 4, resolution: '768P', duration: MAX_ANGLE_SECONDS },
    budget: { sessionCapSeconds: 600, sessionCapUsd: 30, dailyCapUsd: 120 },
  },
};

export const QUALITY_IDS = Object.keys(QUALITY_PRESETS) as QualityPreset[];
export const DEFAULT_QUALITY: QualityPreset = 'low';

export function isQualityPreset(value: unknown): value is QualityPreset {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Returns a copy of `settings` with a preset's values written in. Pure, so the
 * caller can hand the result straight to `updateSettings`.
 */
export function applyQualityPreset(settings: Settings, id: QualityPreset): Settings {
  const preset = QUALITY_PRESETS[id] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
  const next = structuredClone(settings);
  next.quality = preset.id;
  Object.assign(next.stream, preset.stream);
  Object.assign(next.camera, preset.camera);
  Object.assign(next.budget, preset.budget);
  return next;
}

/** True when the live values no longer match the selected preset. */
export function qualityPresetDrifted(settings: Settings): boolean {
  const preset = QUALITY_PRESETS[settings.quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
  const same = (a: unknown, b: unknown): boolean => a === b;
  return !(
    same(settings.stream.resolution, preset.stream.resolution)
    && same(settings.stream.memory, preset.stream.memory)
    && same(settings.camera.enabled, preset.camera.enabled)
    && same(settings.camera.anglesPerBlot, preset.camera.anglesPerBlot)
    && same(settings.camera.resolution, preset.camera.resolution)
    && same(settings.camera.duration, preset.camera.duration)
    && same(settings.budget.sessionCapSeconds, preset.budget.sessionCapSeconds)
    && same(settings.budget.sessionCapUsd, preset.budget.sessionCapUsd)
    && same(settings.budget.dailyCapUsd, preset.budget.dailyCapUsd)
  );
}

const LS_KEY = 'ink-paper-studio-v2';
const LS_KEY_V1 = 'ink-paper-settings-v1';

/** The vision model shipped by default. */
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * Defaults this app used to ship. A stored value that matches one of these was
 * never a deliberate choice, so it is migrated forward rather than honoured.
 */
const SUPERSEDED_OPENROUTER_MODELS = ['z-ai/glm-5.3-flash'];

/**
 * Vision prompts this app used to ship. The wording is not decoration: it is
 * what tells the model how long the clip is and how fast the painting becomes
 * the film, so a stored copy of an old default is migrated forward the same way
 * a superseded model is. Anything the user actually typed is left alone.
 */
const SUPERSEDED_VISION_PROMPTS = [
  `You are a visionary film director. Study this abstract ink blot painting. Let its shapes, colors and negative space suggest something only you can see - figures, landscapes, creatures, weather, machines, dreams. Then write ONE vivid video-generation prompt for a short cinematic video that STARTS exactly from this painting as its first frame and then comes alive and evolves into what you imagined. Describe subject, motion, camera movement, lighting and mood. Output ONLY the video prompt text, under 150 words, no preamble.`,
];

export function defaultSettings(): Settings {
  const base: Settings = {
    version: 3,
    quality: DEFAULT_QUALITY,
    openrouterModel: DEFAULT_OPENROUTER_MODEL,
    visionPrompt: DEFAULT_VISION_PROMPT,
    studioPrompt: DEFAULT_STUDIO_PROMPT,
    moodId: DEFAULT_MOOD_ID,
    moodStrength: 0.7,
    music: {
      musicId: DEFAULT_MUSIC_ID,
      // `assets/music/` ships empty, so a fresh clone has nothing to pin: the
      // default has to be the mode that works with no setup. Dropping a file in,
      // pasting a URL, or switching to `pinned` all still condition the stream
      // on a real track.
      mode: 'generated',
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
  return applyQualityPreset(base, DEFAULT_QUALITY);
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
  out.version = 3;
  if (!isQualityPreset(out.quality)) out.quality = DEFAULT_QUALITY;
  // runtime-only fields must never arrive from a stored or shared payload
  out.music.resolvedUrl = null;
  out.camera.anglesPerBlot = clampNumber(Math.round(out.camera.anglesPerBlot), 0, 4);
  out.camera.duration = clampNumber(Math.round(out.camera.duration), MIN_ANGLE_SECONDS, MAX_ANGLE_SECONDS);
  out.stream.memory = clampNumber(Math.round(out.stream.memory), 1, 50);
  out.budget.sessionCapSeconds = clampNumber(Math.round(out.budget.sessionCapSeconds), 10, 900);
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
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const merged = mergeSettings(base, parsed);
      // Move a stored model that is merely an old built-in default onto the
      // current one; a model the user typed in is left alone.
      if (SUPERSEDED_OPENROUTER_MODELS.includes(merged.openrouterModel)) {
        merged.openrouterModel = DEFAULT_OPENROUTER_MODEL;
      }
      if (SUPERSEDED_VISION_PROMPTS.includes(merged.visionPrompt)) {
        merged.visionPrompt = DEFAULT_VISION_PROMPT;
      }
      // a blob stored before presets existed has no deliberate quality choice,
      // so the shipped default (cheapest) is applied over whatever was saved
      if (!isQualityPreset(isPlainObject(parsed) ? parsed.quality : undefined)) {
        return applyQualityPreset(merged, DEFAULT_QUALITY);
      }
      return merged;
    }
    const legacy = storage.getItem(LS_KEY_V1);
    if (legacy) {
      const old = JSON.parse(legacy) as { openrouterModel?: string; visionPrompt?: string };
      if (typeof old.openrouterModel === 'string') base.openrouterModel = old.openrouterModel;
      if (SUPERSEDED_OPENROUTER_MODELS.includes(base.openrouterModel)) {
        base.openrouterModel = DEFAULT_OPENROUTER_MODEL;
      }
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
