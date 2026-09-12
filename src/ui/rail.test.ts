import { describe, it, expect } from 'vitest';
import { blotCard, renderRail } from './rail';
import type { BlotView, StudioView } from '../studio/studio';
import type { PaintFrame } from '../ink/paintReel';

/** Enough of an element for a renderer: `renderRail` only writes markup. */
function root(): HTMLElement {
  return { innerHTML: '' } as unknown as HTMLElement;
}

const frames: PaintFrame[] = [
  { kind: 'ink', label: 'inking the paper', holdMs: 260, at: 0, uri: 'data:image/jpeg;base64,first' },
  { kind: 'ink', label: '', holdMs: 260, at: 260, uri: 'data:image/jpeg;base64,second' },
  { kind: 'fold-guide', label: 'folding the paper', holdMs: 440, at: 520, uri: 'data:image/jpeg;base64,crease' },
  { kind: 'settle', label: '', holdMs: 320, at: 960, uri: 'data:image/jpeg;base64,last' },
];

function blot(overrides: Partial<BlotView> = {}): BlotView {
  return {
    id: 'blot-1',
    state: 'rendered',
    handmade: false,
    seed: 42,
    thumb: 'data:image/jpeg;base64,thumb',
    paint: null,
    painting: false,
    subject: null,
    prompt: null,
    url: null,
    angles: [],
    ...overrides,
  };
}

const railView = (blots: BlotView[]): StudioView => ({ current: null, rail: blots } as StudioView);

describe('blotCard', () => {
  it('shows the painting, frame by frame, while it is playing', () => {
    const card = blotCard(blot({ paint: frames, painting: true }), null);
    expect(card).toMatch(/class="blot painting\b/);
    expect(card).toContain('<span class="chip state-invented">painting</span>');
    // the finished picture is under the reel: the last frame hands over to it
    expect(card).toContain('data:image/jpeg;base64,thumb');
    expect(card).toContain('class="paint-frame" src="data:image/jpeg;base64,first"');
    expect(card).toContain('--at:520ms;--hold:440ms');
    expect(card).toContain('class="paint-note" style="--at:520ms;--hold:440ms">folding the paper</span>');
  });

  it('does not caption the frames that are only ink arriving', () => {
    const card = blotCard(blot({ paint: [frames[1]!], painting: true }), null);
    expect(card).not.toContain('paint-note');
  });

  it('settles on the finished picture and the real state once the show is over', () => {
    const card = blotCard(blot({ state: 'uploaded' }), null);
    expect(card).not.toContain('paint-frame');
    expect(card).toMatch(/class="blot uploaded\b/);
    expect(card).toContain('<span class="chip state-uploaded">hosted</span>');
  });
});

describe('renderRail', () => {
  it('leaves a playing painting alone, then paints the state it reached', () => {
    const el = root();
    renderRail(el, railView([blot({ paint: frames, painting: true })]));
    const playing = el.innerHTML;
    expect(playing).toContain('paint-frame');

    // the blot is being hosted behind its own show: that must not restart it
    renderRail(el, railView([blot({ paint: frames, painting: true, state: 'uploaded', subject: 'a slow tide' })]));
    expect(el.innerHTML).toBe(playing);

    // the show is over, so the card catches up in one write
    renderRail(el, railView([blot({ state: 'uploaded', subject: 'a slow tide' })]));
    expect(el.innerHTML).not.toContain('paint-frame');
    expect(el.innerHTML).toContain('a slow tide');
  });

  it('writes when a new blot joins the rail mid-show', () => {
    const el = root();
    renderRail(el, railView([blot({ paint: frames, painting: true })]));
    const playing = el.innerHTML;
    renderRail(el, railView([blot({ paint: frames, painting: true }), blot({ id: 'blot-2' })]));
    expect(el.innerHTML).not.toBe(playing);
    expect(el.innerHTML).toContain('2 on the rail');
  });

  it('counts the blots and names an empty rail', () => {
    const el = root();
    renderRail(el, railView([]));
    expect(el.innerHTML).toContain('The rail fills as soon as a run starts');
    renderRail(el, railView([blot({}), blot({ id: 'blot-2' })]));
    expect(el.innerHTML).toContain('2 on the rail');
    expect(el.innerHTML).not.toContain('The rail fills');
  });
});
