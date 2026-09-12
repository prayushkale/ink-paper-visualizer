import { describe, it, expect } from 'vitest';
import { renderPaintingStage } from './paint';
import type { PaintFrame } from '../ink/paintReel';

/** Enough of an element for a renderer: this one writes markup and `hidden`. */
function root(): HTMLElement {
  return { innerHTML: '', hidden: false } as unknown as HTMLElement;
}

const frames: PaintFrame[] = [
  { kind: 'ink', label: 'inking the paper', holdMs: 260, at: 0, uri: 'data:image/jpeg;base64,first' },
  { kind: 'fold-guide', label: 'folding the paper', holdMs: 440, at: 260, uri: 'data:image/jpeg;base64,crease' },
  { kind: 'settle', label: '', holdMs: 320, at: 700, uri: 'data:image/jpeg;base64,last' },
];

describe('renderPaintingStage', () => {
  it('plays the painting large, captions included', () => {
    const el = root();
    renderPaintingStage(el, { id: 'blot-1', paint: frames });
    expect(el.hidden).toBe(false);
    expect(el.innerHTML).toContain('class="paint-frame" src="data:image/jpeg;base64,first"');
    expect(el.innerHTML).toContain('--at:260ms;--hold:440ms');
    expect(el.innerHTML).toContain('folding the paper');
  });

  it('leaves a show that is already playing alone', () => {
    const el = root();
    renderPaintingStage(el, { id: 'blot-1', paint: frames });
    const drawn = el.innerHTML;
    // the same show arriving again (a heartbeat) must not restart the animation
    renderPaintingStage(el, { id: 'blot-1', paint: frames });
    expect(el.innerHTML).toBe(drawn);

    // a second blot's painting is a different show, and does start
    const next: PaintFrame[] = [
      { kind: 'ink', label: 'inking the paper', holdMs: 260, at: 0, uri: 'data:image/jpeg;base64,next' },
    ];
    renderPaintingStage(el, { id: 'blot-2', paint: next });
    expect(el.innerHTML).toContain('base64,next');
    expect(el.hidden).toBe(false);
  });

  it('takes the painting off the stage when nothing is being painted', () => {
    const el = root();
    renderPaintingStage(el, { id: 'blot-1', paint: frames });
    renderPaintingStage(el, null);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
    renderPaintingStage(el, { id: 'blot-1', paint: [] });
    expect(el.hidden).toBe(true);
  });
});
