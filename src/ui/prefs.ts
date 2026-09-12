/**
 * What the page itself remembers.
 *
 * Run settings (quality, mood, camera, budget, prompts) live in `state.ts` and
 * travel in a share link. This is the other half: the choices that belong to
 * the person at the keyboard and mean nothing to anyone else - which view they
 * were in, the brush they left the painting mode on, whether the film was
 * muted, whether they were watching it without the panels.
 *
 * A refresh throws away the DOM and every closure built over it, so none of
 * this can survive in memory: it is read back once at boot.
 */

import { isTheme, type Theme } from './theme';

export type AppMode = 'studio' | 'manual';

export interface BrushPrefs {
  /** Empty means no colour chosen yet, so the painting mode opens on a random pigment. */
  color: string;
  radius: number;
  wetness: number;
}

export interface UiPrefs {
  mode: AppMode;
  brush: BrushPrefs;
  muted: boolean;
  /**
   * Spectator mode. The URL hash is the louder signal on load (a `#watch=1`
   * link always opens watched); this is only the fallback.
   */
  watch: boolean;
  /** Light or dark. A first visit opens light; see `defaultPrefs`. */
  theme: Theme;
}

const LS_KEY = 'inkfilm.prefs.v1';

/**
 * What the page opens on with nothing stored. The theme is the one preference
 * that has to be answered before the user has chosen, and the answer is the
 * page's own default rather than the operating system's: the app is a sheet of
 * paper in a studio, so it opens on paper. Someone who wants the dark palette
 * says so once and the store keeps it. Injectable for the sake of tests that
 * must not depend on the machine they run on.
 */
export function defaultPrefs(theme: Theme = 'light'): UiPrefs {
  return {
    mode: 'studio',
    brush: { color: '', radius: 40, wetness: 0.5 },
    muted: false,
    watch: false,
    theme,
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads the stored preferences, keeping only values of the expected shape.
 * A hand-edited radius outside the slider's own range is the one thing that
 * would make the UI lie about itself, so the numbers are clamped here.
 */
export function loadPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): UiPrefs {
  const prefs = defaultPrefs();
  if (!storage) return prefs;
  try {
    const raw = storage.getItem(LS_KEY);
    if (!raw) return prefs;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return prefs;
    if (parsed.mode === 'studio' || parsed.mode === 'manual') prefs.mode = parsed.mode;
    if (typeof parsed.muted === 'boolean') prefs.muted = parsed.muted;
    if (typeof parsed.watch === 'boolean') prefs.watch = parsed.watch;
    if (isTheme(parsed.theme)) prefs.theme = parsed.theme;
    if (isPlainObject(parsed.brush)) {
      const brush = parsed.brush;
      if (typeof brush.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(brush.color)) {
        prefs.brush.color = brush.color;
      }
      if (typeof brush.radius === 'number' && Number.isFinite(brush.radius)) {
        prefs.brush.radius = clamp(Math.round(brush.radius), 10, 120);
      }
      if (typeof brush.wetness === 'number' && Number.isFinite(brush.wetness)) {
        prefs.brush.wetness = clamp(brush.wetness, 0, 1);
      }
    }
  } catch {
    /* corrupt payload, private mode: the defaults are the answer */
  }
  return prefs;
}

export function savePrefs(prefs: UiPrefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* quota or private mode: the page simply does not remember */
  }
}

export interface UiPrefsStore {
  state(): UiPrefs;
  set<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void;
  /** The brush moves three values at once; they are written as one payload. */
  setBrush(patch: Partial<BrushPrefs>): void;
}

/**
 * One store for the running page: read once, written through on every change.
 *
 * There is exactly one of these per page on purpose - two stores over the same
 * key would each hold their own snapshot, and the second write would put the
 * first one's stale fields back.
 */
export function createPrefsStore(storage: Storage | null = safeStorage()): UiPrefsStore {
  let current = loadPrefs(storage);
  const write = (next: UiPrefs): void => {
    current = next;
    savePrefs(current, storage);
  };
  return {
    state: () => current,
    set<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
      if (current[key] === value) return;
      write({ ...current, [key]: value });
    },
    setBrush(patch: Partial<BrushPrefs>): void {
      const next = { ...current.brush, ...patch };
      if (next.color === current.brush.color && next.radius === current.brush.radius && next.wetness === current.brush.wetness) {
        return;
      }
      write({ ...current, brush: next });
    },
  };
}
