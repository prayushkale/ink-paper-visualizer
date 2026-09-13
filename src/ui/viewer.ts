import { CAMERA_MOVES } from '../presets/camera';
import type { BlotView } from '../studio/studio';
import { BLOT_STATE_LABEL } from './rail';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * What the overlay is showing: one blot with what the run knows about it, or the
 * poster this run composes.
 *
 * Both are pictures the run produced and neither is worth looking at at
 * thumbnail size, so they share the one overlay rather than growing a second
 * full-screen surface that would need its own close button, its own Escape
 * handling and its own z-index.
 */
export type ViewerModel =
  | { kind: 'blot'; blot: BlotView }
  | { kind: 'poster'; url: string; filename: string };

/**
 * One blot, full screen, with what the run knows about it.
 *
 * The rail shows a 256px thumbnail beside three lines of text, which is enough
 * to see *that* a blot is interesting and not enough to look at one. This is the
 * same picture at the size the stage would give it, plus the reading and the
 * camera takes that the card can only compress - the hosted PNG where there is
 * one, because it is the full-size painting the vision model was handed.
 *
 * The photograph the imagining made of it is shown beside it: that is the
 * picture the film itself is made of, and the ink blot is only ever the reference
 * it was drawn from.
 */
export function blotViewerMarkup(blot: BlotView): string {
  const label = BLOT_STATE_LABEL[blot.state] ?? blot.state;
  const image = blot.url ?? blot.thumb;
  const angles = blot.angles
    .map((angle) => `
      <span class="angle ${angle.state}" title="${esc(angle.label)} - ${esc(angle.state)}">
        ${esc(CAMERA_MOVES[angle.move]?.label ?? angle.move)}
      </span>`)
    .join('');
  return `
    <div class="viewer-backdrop" data-action="close-viewer"></div>
    <figure class="viewer-card" role="dialog" aria-modal="true" aria-label="Blot #${blot.seed}">
      <div class="viewer-pictures">
        <div class="viewer-picture">
          ${image ? `<img class="viewer-image" src="${esc(image)}" alt="ink blot #${blot.seed}" />` : '<div class="viewer-frame"></div>'}
          <span class="viewer-tag">the ink it was painted as</span>
        </div>
        ${blot.imagined ? `
          <div class="viewer-picture">
            <img class="viewer-image" src="${esc(blot.imagined)}" alt="blot #${blot.seed} as the imagining made it" />
            <span class="viewer-tag">what the film is made of</span>
          </div>` : ''}
      </div>
      <figcaption class="viewer-body">
        <div class="viewer-head">
          <span class="chip state-${blot.state}">${esc(label)}</span>
          ${blot.handmade ? '<span class="chip handmade">hand-painted</span>' : ''}
          <span class="seed">#${blot.seed}</span>
          <button class="ghost viewer-close" data-action="close-viewer" title="Close (Esc)">Close</button>
        </div>
        <p class="viewer-subject">
          ${blot.subject
            ? esc(blot.subject)
            : '<span class="muted">never imagined - the run ended before the vision model read this blot</span>'}
        </p>
        ${blot.prompt ? `<p class="viewer-prompt">${esc(blot.prompt)}</p>` : ''}
        ${angles ? `<div class="angles">${angles}</div>` : ''}
        ${blot.error ? `<p class="blot-error">${esc(blot.error)}</p>` : ''}
      </figcaption>
    </figure>`;
}

/**
 * The poster, at the size it was composed, before anything reaches the disk.
 *
 * The poster was a download button: the only way to find out what this run's
 * still looked like was to save a file and open it somewhere else. It is a
 * picture of the run, so it is shown like one, and the save became a button
 * inside the viewer - which is now the only thing that writes anything.
 */
export function posterViewerMarkup(poster: { url: string; filename: string }): string {
  return `
    <div class="viewer-backdrop" data-action="close-viewer"></div>
    <figure class="viewer-card" role="dialog" aria-modal="true" aria-label="Poster">
      <div class="viewer-picture">
        <img class="viewer-image" src="${esc(poster.url)}" alt="the poster this run composes" />
      </div>
      <figcaption class="viewer-body">
        <div class="viewer-head">
          <span class="chip">poster</span>
          <span class="seed">1600 &times; 900</span>
          <button class="primary" data-action="download-poster">Download PNG</button>
          <button class="ghost viewer-close" data-action="close-viewer" title="Close (Esc)">Close</button>
        </div>
        <p class="viewer-subject">The blots this run made, the settings it ran with and how long the film ran.</p>
        <p class="viewer-prompt">Nothing has been saved yet: Download writes <code>${esc(poster.filename)}</code>.</p>
      </figcaption>
    </figure>`;
}

export function viewerMarkup(model: ViewerModel): string {
  return model.kind === 'poster' ? posterViewerMarkup(model) : blotViewerMarkup(model.blot);
}

/** Draws the viewer, or takes it off the screen when there is nothing to show. */
export function renderViewer(root: HTMLElement, model: ViewerModel | null): void {
  if (!model) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  root.innerHTML = viewerMarkup(model);
}
