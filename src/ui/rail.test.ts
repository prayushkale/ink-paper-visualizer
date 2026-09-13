import { describe, it, expect } from 'vitest';
import { blotCard, renderRail } from './rail';
import type { BlotView, StudioView } from '../studio/studio';

/** Enough of an element for a renderer: `renderRail` only writes markup. */
function root(): HTMLElement {
  return { innerHTML: '' } as unknown as HTMLElement;
}

function blot(overrides: Partial<BlotView> = {}): BlotView {
  return {
    id: 'blot-1',
    state: 'rendered',
    handmade: false,
    seed: 42,
    thumb: 'data:image/jpeg;base64,ink',
    imagined: null,
    inkHeld: false,
    subject: null,
    prompt: null,
    url: null,
    angles: [],
    ...overrides,
  };
}

const railView = (blots: BlotView[]): StudioView => ({ current: null, rail: blots } as StudioView);

describe('blotCard', () => {
  it('shows the ink blot itself while its hold is still running', () => {
    const card = blotCard(blot({ inkHeld: true, imagined: 'https://fal.media/scene.png' }), null);
    expect(card).toContain('src="data:image/jpeg;base64,ink"');
    expect(card).not.toContain('https://fal.media/scene.png');
    // nothing to hand over to yet stays the blot's own picture
    expect(card).not.toContain('ink-ref');
  });

  it('hands the card over to the photograph once the hold is over', () => {
    const card = blotCard(blot({ state: 'ready', imagined: 'https://fal.media/scene.png' }), null);
    expect(card).toContain('src="https://fal.media/scene.png"');
    // the ink stays as a reference, because it is what the film was drawn from
    expect(card).toContain('class="ink-ref" src="data:image/jpeg;base64,ink"');
  });

  it('keeps the blot on the card while no photograph exists', () => {
    const card = blotCard(blot({ state: 'uploaded', imagined: null }), null);
    expect(card).toContain('src="data:image/jpeg;base64,ink"');
    expect(card).not.toContain('ink-ref');
    expect(card).toContain('<span class="chip state-uploaded">hosted</span>');
  });

  it('names the realised state in the rail\'s own words', () => {
    expect(blotCard(blot({ state: 'imagined', imagined: 'https://fal.media/s.png' }), null))
      .toContain('<span class="chip state-imagined">realised</span>');
  });

  it('does not paint a reel over the picture', () => {
    expect(blotCard(blot({ state: 'ready', imagined: 'https://fal.media/s.png' }), null))
      .not.toContain('paint-frame');
  });
});

describe('renderRail', () => {
  it('leaves a card alone while its ink hold is running', () => {
    const el = root();
    renderRail(el, railView([blot({ inkHeld: true })]));
    const held = el.innerHTML;

    // the blot is being hosted behind its own hold: that must not rewrite it
    renderRail(el, railView([blot({ inkHeld: true, state: 'uploaded', subject: 'a slow tide' })]));
    expect(el.innerHTML).toBe(held);

    // the hold is over, so the card catches up in one write
    renderRail(el, railView([blot({ state: 'uploaded', subject: 'a slow tide' })]));
    expect(el.innerHTML).toContain('a slow tide');
  });

  it('writes when a new blot joins the rail mid-hold', () => {
    const el = root();
    renderRail(el, railView([blot({ inkHeld: true })]));
    const held = el.innerHTML;
    renderRail(el, railView([blot({ inkHeld: true }), blot({ id: 'blot-2' })]));
    expect(el.innerHTML).not.toBe(held);
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
