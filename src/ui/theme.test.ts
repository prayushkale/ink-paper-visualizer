import { describe, it, expect } from 'vitest';
import { applyTheme, isTheme, otherTheme, stageColor, systemTheme, THEME_COLORS, THEME_EVENT } from './theme';

/**
 * The document element, as much of it as the module touches. There is no jsdom in
 * this repo, so the stub is the test's own business.
 */
function fakeRoot(): { root: HTMLElement; meta: { content: string } } {
  const meta = { content: '' };
  const root = {
    dataset: {} as DOMStringMap,
    querySelector: () => ({ setAttribute: (_name: string, value: string) => void (meta.content = value) }),
  } as unknown as HTMLElement;
  return { root, meta };
}

describe('theme', () => {
  it('recognises the two themes and nothing else', () => {
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dusk')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('toggles to the other one', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });

  it('falls back to dark where there is no system to ask', () => {
    expect(systemTheme()).toBe('dark');
  });

  it('writes the attribute the stylesheet reads, and the chrome tint with it', () => {
    const { root, meta } = fakeRoot();
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    expect(meta.content).toBe(THEME_COLORS.light);
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    expect(meta.content).toBe(THEME_COLORS.dark);
  });

  it('survives a document with no theme-color meta to write to', () => {
    const root = { dataset: {} as DOMStringMap, querySelector: () => null } as unknown as HTMLElement;
    expect(() => applyTheme('light', root)).not.toThrow();
    expect(root.dataset.theme).toBe('light');
  });

  it('reads the stage colour off the stylesheet, and has one for outside a browser', () => {
    expect(stageColor()).toMatch(/^#|rgb/);
  });

  it('names an event for the canvases that cannot see a variable', () => {
    expect(THEME_EVENT).toBe('inkfilm:theme');
  });
});
