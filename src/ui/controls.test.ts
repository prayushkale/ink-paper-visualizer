import { describe, it, expect } from 'vitest';
import { renderControls } from './controls';
import { SECTION_IDS } from './sections';
import { defaultSettings } from '../state';
import type { StudioView } from '../studio/studio';
import type { ControlActions } from './controls';

/** The renderer only sets innerHTML, so this is all the element it needs. */
function root(): HTMLElement {
  return { innerHTML: '' } as unknown as HTMLElement;
}

const actions = {} as ControlActions;

function idleView(): StudioView {
  return {
    status: 'idle',
    current: null,
    music: { status: 'idle', resolvedUrl: null },
  } as unknown as StudioView;
}

describe('renderControls', () => {
  it('writes every sidebar section closed', () => {
    const el = root();
    renderControls(el, idleView(), defaultSettings(), actions);
    const sections = el.innerHTML.match(/<details[^>]*>/g) ?? [];
    expect(sections).toHaveLength(SECTION_IDS.length);
    expect(sections.every((tag) => tag.includes('data-section='))).toBe(true);
    expect(el.innerHTML).not.toContain('<details open>');
    expect(el.innerHTML).not.toContain(' open>');
  });

  it('carries the section ids the layout store keys on', () => {
    const el = root();
    renderControls(el, idleView(), defaultSettings(), actions);
    for (const id of SECTION_IDS) expect(el.innerHTML).toContain(`data-section="${id}"`);
  });
});
