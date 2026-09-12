import { usd } from '../state';
import { formatDuration } from '../api/client';
import type { StudioView } from '../studio/studio';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STATUS_COPY: Record<string, string> = {
  idle: 'idle',
  preflight: 'preparing',
  connecting: 'connecting',
  live: 'live',
  paused: 'paused',
  chaining: 'handing over',
  stopping: 'stopping',
  ended: 'finished',
  failed: 'failed',
};

const PREPARING_COPY: Record<string, string> = {
  painting: 'painting the first blots',
  hosting: 'hosting them where the model can fetch them',
  imagining: 'asking the vision model what they could be',
  shooting: 'shooting the camera orbits',
  ready: 'opening the session',
  stalled: 'the rail is struggling',
};

/**
 * The pre-flight overlay.
 *
 * Nothing is generated until the rail holds enough ready blots, and that is a
 * minute or two of work with no picture to show for it, so the stage, the count
 * and the elapsed clock have to be visible or the app looks broken.
 */
export function renderPreparing(root: HTMLElement, view: StudioView): void {
  const preparing = view.preparing;
  if (!preparing) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const percent = preparing.target > 0
    ? Math.min(100, Math.round((preparing.ready / preparing.target) * 100))
    : 0;
  const views = preparing.anglesWanted > 0
    ? `<span>views ${Math.min(preparing.anglesReady, preparing.anglesWanted)}/${preparing.anglesWanted}</span>`
    : '';
  const dropped = preparing.failed > 0 ? `<span>${preparing.failed} dropped</span>` : '';
  const orbited = preparing.anglesWanted > 0 ? ' and orbited' : '';
  root.hidden = false;
  root.innerHTML = `
    <div class="preparing-card">
      <p class="preparing-title">Preparing the film</p>
      <p class="preparing-stage">${esc(PREPARING_COPY[preparing.stage] ?? preparing.stage)}…</p>
      <div class="meter-bar"><div class="meter-fill" style="width:${percent}%"></div></div>
      <p class="preparing-meta">
        <span><strong>${preparing.ready}</strong>/${preparing.target} blots ready</span>
        ${views}
        ${dropped}
        <span>${formatDuration(preparing.elapsedMs)}</span>
      </p>
      <p class="preparing-hint">
        Every blot is painted, hosted and read by the vision model${orbited} before the
        session can open on it. Nothing is billed until the film starts.
      </p>
    </div>`;
}

/** The status line: what the film is doing, and what it is costing. */
export function renderStatusPill(root: HTMLElement, view: StudioView): void {
  const rate = view.spend.rate;
  const promo = view.spend.promo;
  root.innerHTML = `
    <span class="pill status-${view.status}" data-status>
      <span class="dot"></span>${esc(STATUS_COPY[view.status] ?? view.status)}
    </span>
    <span class="pill spend ${view.spend.dryRun ? 'dry' : ''}" title="Director bills per second of generated video">
      ${view.spend.dryRun ? 'dry run · $0' : `${usd(view.spend.sessionUsd)} this session`}
    </span>
    <span class="pill muted" title="Today's total against the daily cap">
      ${usd(view.spend.todayUsd)} / ${usd(view.spend.dailyCapUsd)} today
    </span>
    <span class="pill muted rate" title="${promo ? 'Launch price until 2026-09-14' : 'List price since 2026-09-14'}">
      $${rate.toFixed(2)}/s${promo ? ' promo' : ''}
    </span>`;
}

/** Overlay on the film: buffer health, the beat on screen, and the chain count. */
export function renderHud(root: HTMLElement, view: StudioView): void {
  const live = view.status === 'live' || view.status === 'paused' || view.status === 'chaining';
  if (!live) {
    root.innerHTML = '';
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const bufferClass = view.session.bufferSeconds <= 0 ? 'thin' : view.session.bufferSeconds < 8 ? 'ok' : 'deep';
  root.innerHTML = `
    <div class="hud-row">
      <span class="hud-cell buffer ${bufferClass}" title="Seconds of finished video waiting ahead of playback">
        buffer ${view.session.bufferSeconds.toFixed(1)}s
      </span>
      <span class="hud-cell" title="Generated chunks so far">chunk ${view.session.chunkIndex + 1}</span>
      <span class="hud-cell" title="Which backend produced it">${esc(view.session.route)}</span>
      <span class="hud-cell" title="Chained sessions this run">take ${view.chain.sessions}</span>
      <span class="hud-cell" title="Directions sent">v${view.session.promptVersion}</span>
    </div>
    ${view.current ? `
      <div class="hud-current">
        <span class="hud-label">now imagining</span>
        <strong>${esc(view.current.subject ?? 'something unnameable')}</strong>
        ${view.current.cameraLabel ? `<span class="hud-cam">${esc(view.current.cameraLabel)}</span>` : ''}
      </div>` : ''}
    ${view.session.buffering ? '<div class="hud-warn">the model fell behind playback and is catching up</div>' : ''}`;
}

/**
 * Cost meters, chain state, recording, and the raw server log.
 *
 * `replaying` is the index of the take the shell is playing back on the stage, or
 * null when none is: the button that started it is the button that stops it, so
 * it has to read as pressed for as long as the take is on screen. A session's
 * stream dies with the session, so without a playback the only thing a finished
 * run leaves is a file to download.
 */
export function renderTelemetry(root: HTMLElement, view: StudioView, replaying: number | null = null): void {
  const recording = view.recording;
  const remainingSeconds = view.spend.remainingSessionSeconds;
  // a paused session is finalised, so a run can be several files
  const parts = recording.parts.length > 0
    ? recording.parts
    : recording.result ? [recording.result] : [];
  root.innerHTML = `
    <div class="grid-two">
      <div class="stat">
        <span class="stat-label">This session</span>
        <strong>${view.spend.dryRun ? '$0.00' : usd(view.spend.sessionUsd)}</strong>
        <span class="muted">of ${usd(view.spend.sessionCapUsd)} cap</span>
      </div>
      <div class="stat">
        <span class="stat-label">Today</span>
        <strong>${view.spend.dryRun ? '$0.00' : usd(view.spend.todayUsd)}</strong>
        <span class="muted">of ${usd(view.spend.dailyCapUsd)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Session time left</span>
        <strong>${Math.round(remainingSeconds)}s</strong>
        <span class="muted">${view.capabilities.sessionMaxSeconds
          ? `server ceiling ${view.capabilities.sessionMaxSeconds}s`
          : 'no declared ceiling'}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Sessions run</span>
        <strong>${view.chain.sessions}</strong>
        <span class="muted">${view.chain.chains} handover${view.chain.chains === 1 ? '' : 's'}${view.chain.failures ? ` · ${view.chain.failures} failed` : ''}</span>
      </div>
    </div>

    <div class="meter">
      <div class="meter-bar"><div class="meter-fill" style="width:${sessionPercent(view)}%"></div></div>
      <span class="muted">session budget used</span>
    </div>

    <div class="recording">
      <div class="recording-head">
        <span class="chip state-${recording.state}">recording ${esc(recording.state)}</span>
        ${recording.container ? `<span class="chip">${esc(recording.container)}</span>` : ''}
        <span class="muted">${formatDuration(recording.durationMs)}</span>
      </div>
      ${parts.length === 0
        ? `<p class="muted">${recording.state === 'idle' ? 'nothing recorded yet' : 'the file appears here when you stop'}</p>`
        : `${parts.map((part, index) => `
             <div class="recording-row">
               <button class="${replaying === index ? 'danger' : 'primary'}" data-action="play-recording" data-index="${index}"
                       title="${replaying === index ? 'Take the take off the stage' : 'Play this take on the stage, over and over'}">
                 ${replaying === index ? 'Stop' : 'Play'} <span class="muted">· ${formatDuration(part.durationMs)}</span>
               </button>
               <button class="secondary" data-action="download" data-index="${index}">
                 Download ${part.remuxed ? 'mp4' : part.container}${parts.length > 1 ? ` · part ${index + 1}` : ''}
                 <span class="muted">· ${Math.round(part.bytes / 1024)} KB</span>
               </button>
             </div>`).join('')}
           ${replaying === null
             ? ''
             : '<p class="muted">Playing this take on the stage, on a loop. Start the film to go back to the live session.</p>'}
           ${view.capabilities.ffmpeg ? '' : '<p class="muted">ffmpeg was not found, so a webm cannot be converted to mp4 here.</p>'}`}
    </div>

    <details class="log-wrap" ${view.warnings.length > 0 ? 'open' : ''}>
      <summary>Server log <span class="muted">${view.log.length}</span></summary>
      <pre class="log">${view.log.slice(-60).map((line) =>
        `<span class="log-${line.kind}">${esc(line.text)}</span>`).join('\n')}</pre>
    </details>`;
}

function sessionPercent(view: StudioView): number {
  const cap = view.spend.remainingSessionSeconds + view.session.generatedSeconds;
  if (cap <= 0) return 0;
  return Math.max(0, Math.min(100, (view.session.generatedSeconds / cap) * 100));
}
