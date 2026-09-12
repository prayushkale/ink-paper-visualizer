/**
 * Light and dark.
 *
 * The palette lives in `styles.css` as custom properties, so switching themes is
 * one attribute on <html> rather than a pass over every rendered view. Two
 * consumers cannot read a custom property - the `<meta name="theme-color">` that
 * tints the browser chrome, and the WebGL stage the painting mode draws on - so
 * both are handed a resolved colour from here.
 *
 * The choice belongs to the person at the keyboard, so it is remembered with the
 * other page preferences (`prefs.ts`, key `inkfilm.prefs.v1`). `index.html`
 * carries a small copy of the read, because the module bundle runs after the
 * browser has already painted once and a late theme is a visible flash.
 */

export type Theme = 'dark' | 'light';

/**
 * Fired after the attribute is set. A canvas has no way to notice a stylesheet
 * change, so the WebGL stage listens for this instead of polling.
 */
export const THEME_EVENT = 'inkfilm:theme';

/** The browser-chrome tint: the same value as `--bg` in each theme. */
export const THEME_COLORS: Record<Theme, string> = { dark: '#0d0c10', light: '#f6f3ec' };

/** What the stage behind the paper falls back to when the stylesheet cannot be read. */
const STAGE_FALLBACK = '#1a1a1e';

export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/**
 * Puts the theme on the document, where the stylesheet is listening, and tells
 * the canvases that can only read their colours back off the computed style.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  const meta = root.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
  }
}

/**
 * The colour the painting canvas clears to, read back off the stylesheet instead
 * of repeated here so the two cannot drift apart. It is its own variable rather
 * than `--stage-bg`: the film wants a true black, a sheet of paper does not.
 */
export function stageColor(): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return STAGE_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--paper-stage-bg').trim();
  return value === '' ? STAGE_FALLBACK : value;
}
