import { describe, it, expect } from 'vitest';
import { blotViewerMarkup, posterViewerMarkup, renderViewer } from './viewer';
import type { BlotView } from '../studio/studio';

function root(): HTMLElement {
  return { innerHTML: '', hidden: true } as unknown as HTMLElement;
}

function blot(overrides: Partial<BlotView> = {}): BlotView {
  return {
    id: 'blot-1',
    state: 'ready',
    handmade: false,
    seed: 42,
    thumb: 'data:image/jpeg;base64,thumb',
    imagined: null,
    inkHeld: false,
    subject: 'a slow tide',
    prompt: 'The tide crosses the paper and gathers into ridges.',
    url: 'https://fal.media/42.png',
    angles: [{ id: 'angle-1', move: 'orbit-right', label: 'Orbit right', state: 'ready' }],
    ...overrides,
  };
}

describe('blotViewerMarkup', () => {
  it('opens the hosted painting rather than the thumbnail', () => {
    const markup = blotViewerMarkup(blot());
    expect(markup).toContain('https://fal.media/42.png');
    expect(markup).not.toContain('data:image/jpeg;base64,thumb');
  });

  it('shows the photograph the imagining made of the blot beside the ink', () => {
    const markup = blotViewerMarkup(blot({ imagined: 'https://fal.media/scene.png' }));
    expect(markup).toContain('https://fal.media/scene.png');
    expect(markup).toContain('what the film is made of');
    // and it keeps saying whose ink it was drawn from
    expect(markup).toContain('the ink it was painted as');
  });

  it('says nothing about an imagining that never happened', () => {
    expect(blotViewerMarkup(blot())).not.toContain('what the film is made of');
  });

  it('falls back to the thumbnail for a blot that was never hosted', () => {
    expect(blotViewerMarkup(blot({ url: null }))).toContain('data:image/jpeg;base64,thumb');
  });

  it('carries what the run knows: state, seed, reading and camera takes', () => {
    const markup = blotViewerMarkup(blot());
    expect(markup).toContain('<span class="chip state-ready">ready</span>');
    expect(markup).toContain('#42');
    expect(markup).toContain('a slow tide');
    expect(markup).toContain('gathers into ridges');
    expect(markup).toContain('Orbit right');
  });

  it('says bluntly when a blot was never imagined', () => {
    const markup = blotViewerMarkup(blot({ subject: null, prompt: null, state: 'rendered' }));
    expect(markup).toContain('never imagined');
    expect(markup).not.toContain('a slow tide');
  });

  it('escapes the reading, so a model reply cannot inject markup', () => {
    const markup = blotViewerMarkup(blot({ subject: '<img src=x onerror=alert(1)>' }));
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x');
  });
});

describe('posterViewerMarkup', () => {
  it('shows the composed poster and offers the save inside it', () => {
    const markup = posterViewerMarkup({ url: 'blob:poster', filename: 'ink-film-poster-42.png' });
    expect(markup).toContain('src="blob:poster"');
    expect(markup).toContain('data-action="download-poster"');
    expect(markup).toContain('ink-film-poster-42.png');
  });

  it('says plainly that nothing has been written yet', () => {
    expect(posterViewerMarkup({ url: 'blob:poster', filename: 'p.png' })).toContain('Nothing has been saved yet');
  });

  it('still closes, and escapes a filename that came out of the settings', () => {
    const markup = posterViewerMarkup({ url: 'blob:p', filename: '<script>x</script>' });
    expect(markup).toContain('data-action="close-viewer"');
    expect(markup).not.toContain('<script>');
  });
});

describe('renderViewer', () => {
  it('fills the overlay with a blot, and empties it when there is nothing', () => {
    const el = root();
    renderViewer(el, { kind: 'blot', blot: blot() });
    expect(el.hidden).toBe(false);
    expect(el.innerHTML).toContain('viewer-card');

    renderViewer(el, null);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });

  it('fills the overlay with the poster instead of a blot', () => {
    const el = root();
    renderViewer(el, { kind: 'poster', url: 'blob:poster', filename: 'p.png' });
    expect(el.hidden).toBe(false);
    expect(el.innerHTML).toContain('blob:poster');
    expect(el.innerHTML).not.toContain('viewer-subject">a slow tide');
  });
});
