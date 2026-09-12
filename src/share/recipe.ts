import { MAX_FOLDS } from '../ink/recipe';
import { clamp, clamp01, parseSeed } from '../ink/rng';
import { canvasForAspect, type AspectRatio, type InkRecipe, type InkToolId } from '../ink/types';
import { CAMERA_MOVE_IDS, type CameraMoveId } from '../presets/camera';
import { MOOD_IDS, type MoodId } from '../presets/moods';
import { MUSIC_IDS, type MusicId } from '../presets/music';

export const SHARE_VERSION = 2;

export interface SharedSettings {
  seed: number;
  recipe: InkRecipe;
  moodId: MoodId;
  moodStrength: number;
  musicId: MusicId;
  musicMode: 'pinned' | 'generated';
  camera: {
    enabled: boolean;
    moves: CameraMoveId[];
    anglesPerBlot: number;
    resolution: '480P' | '768P' | '1080P';
    duration: number;
    handoff: 'continue' | 'turn';
    repeatAngleCycle: boolean;
  };
  stream: {
    resolution: '480p' | '768p' | '1080p';
    aspectRatio: AspectRatio;
    memory: number;
    arrivalMode: 'hard' | 'soft';
  };
  sessionCapSeconds: number;
}

const MAX_CODE_LENGTH = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArrayOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return fallback;
  const picked = value.filter((item): item is T => typeof item === 'string' && (allowed as readonly string[]).includes(item));
  return picked.length > 0 ? [...new Set(picked)] : fallback;
}

function asIn<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/** base64url without padding, so a code survives being pasted anywhere. */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string | null {
  try {
    const padded = code.replace(/-/g, '+').replace(/_/g, '/');
    const binary = typeof atob === 'function'
      ? atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
      : Buffer.from(padded, 'base64').toString('binary');
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeShare(shared: SharedSettings): string {
  return toBase64Url(JSON.stringify(shared));
}

/**
 * Reads a share code. Everything is clamped and whitelisted against the current
 * presets, because a code is user input and half of it may be stale.
 */
export function decodeShare(code: string, fallbackRecipe: InkRecipe): SharedSettings | null {
  if (typeof code !== 'string' || code === '' || code.length > MAX_CODE_LENGTH) return null;
  const text = fromBase64Url(code.trim());
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // a share code must at least carry the seed it was generated from; an empty
  // object is a malformed link, not a request for defaults
  if (typeof parsed.seed !== 'number' || !Number.isFinite(parsed.seed)) return null;
  const recipe = isRecord(parsed.recipe) ? parsed.recipe : {};
  const camera = isRecord(parsed.camera) ? parsed.camera : {};
  const stream = isRecord(parsed.stream) ? parsed.stream : {};
  const aspect = asIn(stream.aspectRatio, ['16:9', '9:16', '1:1'] as const, fallbackRecipe.canvas.width >= fallbackRecipe.canvas.height ? '16:9' : '9:16');
  const tools = Array.isArray(recipe.tools)
    ? recipe.tools.filter((tool): tool is InkToolId => typeof tool === 'string')
    : fallbackRecipe.tools;
  return {
    seed: asNumber(parsed.seed, fallbackRecipe.seed, 0, 0xffffffff),
    recipe: {
      version: 1,
      seed: asNumber(recipe.seed, fallbackRecipe.seed, 0, 0xffffffff),
      canvas: canvasForAspect(aspect, Math.max(fallbackRecipe.canvas.width, 512)),
      palette: Array.isArray(recipe.palette) && recipe.palette.length > 0
        ? recipe.palette.filter((color): color is string => typeof color === 'string').slice(0, 8)
        : fallbackRecipe.palette,
      tools: tools.length > 0 ? tools : fallbackRecipe.tools,
      blotCount: Math.round(asNumber(recipe.blotCount, fallbackRecipe.blotCount, 1, 24)),
      wetness: asNumber(recipe.wetness, fallbackRecipe.wetness, 0, 1),
      bleed: asNumber(recipe.bleed, fallbackRecipe.bleed, 0, 1),
      folds: Array.isArray(recipe.folds)
        ? recipe.folds
          .filter(isRecord)
          .slice(0, MAX_FOLDS)
          .map((fold) => ({
            axis: fold.axis === 'horizontal' ? 'horizontal' as const : 'vertical' as const,
            direction: asIn(fold.direction, ['left', 'right', 'top', 'bottom'] as const, 'left'),
            at: fold.at === undefined ? undefined : clamp01(Number(fold.at) || 0.5),
          }))
        : fallbackRecipe.folds,
      grain: asNumber(recipe.grain, fallbackRecipe.grain, 0, 1),
    },
    moodId: asIn(parsed.moodId, MOOD_IDS, 'dreamlike'),
    moodStrength: asNumber(parsed.moodStrength, 0.7, 0, 1),
    musicId: asIn(parsed.musicId, MUSIC_IDS, 'ambient'),
    musicMode: asIn(parsed.musicMode, ['pinned', 'generated'] as const, 'pinned'),
    camera: {
      enabled: camera.enabled !== false,
      moves: asArrayOf(camera.moves, CAMERA_MOVE_IDS, ['orbit-right', 'push-in', 'crane-up']),
      anglesPerBlot: Math.round(asNumber(camera.anglesPerBlot, 2, 0, 4)),
      resolution: asIn(camera.resolution, ['480P', '768P', '1080P'] as const, '480P'),
      duration: Math.round(asNumber(camera.duration, 5, 5, 15)),
      handoff: asIn(camera.handoff, ['continue', 'turn'] as const, 'continue'),
      repeatAngleCycle: camera.repeatAngleCycle === true,
    },
    stream: {
      resolution: asIn(stream.resolution, ['480p', '768p', '1080p'] as const, '768p'),
      aspectRatio: aspect,
      memory: Math.round(asNumber(stream.memory, 12, 1, 50)),
      arrivalMode: asIn(stream.arrivalMode, ['hard', 'soft'] as const, 'hard'),
    },
    sessionCapSeconds: Math.round(asNumber(parsed.sessionCapSeconds, 120, 10, 900)),
  };
}

export function shareUrl(shared: SharedSettings, location: { origin: string; pathname: string } = globalThis.location): string {
  return `${location.origin}${location.pathname}#s=${encodeShare(shared)}`;
}

export function readShareFromHash(hash: string, fallbackRecipe: InkRecipe): SharedSettings | null {
  const match = /[#&]s=([^&]+)/.exec(hash ?? '');
  if (!match) return null;
  return decodeShare(match[1]!, fallbackRecipe);
}

/** A short human-readable label for a shared run. */
export function describeShare(shared: SharedSettings): string {
  return `blot #${shared.seed} · ${shared.moodId} · ${shared.musicId} · ${shared.camera.anglesPerBlot} angles`;
}
