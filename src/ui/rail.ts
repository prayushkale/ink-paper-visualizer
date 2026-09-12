import { CAMERA_MOVES, type CameraMoveId } from '../presets/camera';
import type { StudioView, BlotView } from '../studio/studio';
import { paintReelMarkup, reelIsPlaying } from './paint';

/** What each pipeline state is called on a card, in the rail's own words. */
export const BLOT_STATE_LABEL: Record<string, string> = {
  painting: 'painting',
  invented: 'inventing',
  rendered: 'painted',
  uploaded: 'hosted',
  interpreted: 'imagined',
  ready: 'ready',
  scheduled: 'queued',
  live: 'on screen',
  passed: 'done',
  failed: 'dropped',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One blot card: the picture, what the model saw in it, and its angle views. */
export function blotCard(blot: BlotView, currentId: string | null): string {
  const isCurrent = blot.id === currentId;
  // A blot shows its own painting while that is playing, whatever stage the
  // pipeline has already carried it to: the card is about what the rail has to
  // show, not about a state that is a second old by the time it is read.
  const state = blot.painting ? 'painting' : blot.state;
  const angles = blot.angles
    .map((angle) => `
      <span class="angle ${angle.state}" title="${esc(angle.label)}">
        ${esc(CAMERA_MOVES[angle.move]?.label ?? angle.move)}
      </span>`)
    .join('');
  return `
    <article class="blot ${state} ${isCurrent ? 'current' : ''}" data-zoom="${esc(blot.id)}">
      <div class="blot-thumb">
        <button class="blot-zoom" type="button" data-zoom="${esc(blot.id)}" title="Open this blot full screen">
          ${blot.thumb ? `<img src="${blot.thumb}" alt="ink blot ${blot.seed}" loading="lazy" />` : '<div class="skeleton"></div>'}
        </button>
        ${blot.paint ? paintReelMarkup(blot.paint) : ''}
        ${isCurrent ? '<span class="now">on screen</span>' : ''}
      </div>
      <div class="blot-body">
        <div class="blot-head">
          <span class="chip state-${blot.painting ? 'invented' : blot.state}">${esc(BLOT_STATE_LABEL[state] ?? state)}</span>
          ${blot.handmade ? '<span class="chip handmade">hand-painted</span>' : ''}
          <span class="seed">#${blot.seed}</span>
        </div>
        <p class="subject">${blot.subject ? esc(blot.subject) : '<span class="muted">waiting for the vision model…</span>'}</p>
        ${blot.prompt ? `<p class="prompt">${esc(blot.prompt)}</p>` : ''}
        ${angles ? `<div class="angles">${angles}</div>` : ''}
        ${blot.error ? `<p class="blot-error">${esc(blot.error)}</p>` : ''}
      </div>
    </article>`;
}

/** Which blots are painting, and which frames of theirs are on the rail. */
function reelsOnShow(view: StudioView): string {
  return view.rail
    .filter((blot) => blot.paint !== null && blot.paint.length > 0)
    .map((blot) => `${blot.id}:${blot.paint!.length}:${blot.paint![0]!.at}`)
    .join(',');
}

export function renderRail(root: HTMLElement, view: StudioView, options: { compact?: boolean } = {}): void {
  const currentId = view.current?.blotId ?? null;
  // A painting plays as a CSS animation over markup the shell rebuilds on a
  // heartbeat, so a rewrite would start it again from its first frame. The
  // studio paints one blot at a time and a card cannot change while its own ink
  // is arriving, so the rail is left exactly as it is until the show is over -
  // and until a new blot arrives, which is the one thing that does matter.
  const ids = view.rail.map((blot) => blot.id).join(',');
  const reels = reelsOnShow(view);
  if (reelIsPlaying(root, reels === '' ? '' : `${ids}|${reels}`)) return;
  const cards = view.rail.map((blot) => blotCard(blot, currentId)).join('');
  const empty = view.rail.length === 0
    ? '<p class="muted pad">The rail fills as soon as a run starts. Press <strong>Start the film</strong>.</p>'
    : '';
  root.innerHTML = options.compact
    ? `<div class="filmstrip-track">${cards}${empty}</div>`
    : `<div class="rail-head">
         <h2>Blots</h2>
         <span class="muted">${view.rail.length} on the rail</span>
       </div>
       <div class="rail-track">${cards}${empty}</div>`;
}

/** A small top-down diagram of where each enabled camera move ends up. */
export function orbitDiagram(moves: CameraMoveId[]): string {
  const size = 132;
  const centre = size / 2;
  const radius = 44;
  const spokes = moves.map((move, index) => {
    const frames = CAMERA_MOVES[move].keyframes(index + 1);
    const last = frames[frames.length - 1]!;
    const radians = ((last.azimuth - 90) * Math.PI) / 180;
    const distance = Math.max(0.25, Math.min(2.2, last.distance));
    const r = radius / distance;
    const x = centre + Math.cos(radians) * r;
    const y = centre + Math.sin(radians) * r;
    const elevationDrop = Math.round((last.elevation / 90) * 12);
    return {
      move,
      x,
      y,
      top: y - elevationDrop,
      label: CAMERA_MOVES[move].label,
    };
  });
  return `
    <svg class="orbit" viewBox="0 0 ${size} ${size}" role="img" aria-label="where each camera move ends">
      <circle cx="${centre}" cy="${centre}" r="${radius}" class="orbit-path" />
      <circle cx="${centre}" cy="${centre}" r="7" class="orbit-subject" />
      ${spokes.map((spoke) => `
        <line x1="${centre}" y1="${centre}" x2="${spoke.x}" y2="${spoke.y}" class="orbit-spoke" />
        <circle cx="${spoke.x}" cy="${spoke.y}" r="4.5" class="orbit-dot" />
        <circle cx="${spoke.x}" cy="${spoke.top}" r="1.6" class="orbit-elev" />
      `).join('')}
    </svg>
    <ul class="orbit-key">
      ${spokes.map((spoke) => `<li>${esc(spoke.label)}</li>`).join('')}
    </ul>`;
}
