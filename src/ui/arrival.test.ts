import { describe, it, expect } from 'vitest';
import { renderArrivalCard } from './arrival';

/** Enough of an element for this renderer: it writes markup and `hidden`. */
function root(): HTMLElement {
  return { innerHTML: '', hidden: false } as unknown as HTMLElement;
}

describe('renderArrivalCard', () => {
  it('holds a still over the stage', () => {
    const el = root();
    renderArrivalCard(el, { id: 'blot-1', image: 'https://fal.media/ink.png' });
    expect(el.hidden).toBe(false);
    expect(el.innerHTML).toContain('src="https://fal.media/ink.png"');
  });

  it('leaves the same still alone, and takes a different one', () => {
    const el = root();
    renderArrivalCard(el, { id: 'blot-1', image: 'https://fal.media/ink.png' });
    const drawn = el.innerHTML;
    renderArrivalCard(el, { id: 'blot-1', image: 'https://fal.media/ink.png' });
    expect(el.innerHTML).toBe(drawn);

    renderArrivalCard(el, { id: 'blot-2', image: 'https://fal.media/scene.png' });
    expect(el.innerHTML).toContain('https://fal.media/scene.png');
  });

  it('takes the still off the stage when the hold is over', () => {
    const el = root();
    renderArrivalCard(el, { id: 'blot-1', image: 'https://fal.media/ink.png' });
    renderArrivalCard(el, null);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });

  it('escapes the source, so a model reply cannot inject markup', () => {
    const el = root();
    renderArrivalCard(el, { id: 'b', image: 'https://fal.media/x.png" onerror="alert(1)' });
    expect(el.innerHTML).not.toContain('onerror="alert(1)"');
    expect(el.innerHTML).toContain('&quot;');
  });
});
