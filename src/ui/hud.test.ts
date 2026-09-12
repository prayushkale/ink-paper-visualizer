import { describe, it, expect } from 'vitest';
import { renderPreparing, renderTelemetry } from './hud';
import type { StudioView } from '../studio/studio';

/** Enough of an element for the renderers: they only set `hidden` and `innerHTML`. */
function root(): HTMLElement {
  return { hidden: true, innerHTML: '' } as unknown as HTMLElement;
}

function view(preparing: StudioView['preparing']): StudioView {
  return { preparing } as StudioView;
}

const progress = (
  overrides: Partial<NonNullable<StudioView['preparing']>> = {},
): NonNullable<StudioView['preparing']> => ({
  target: 3,
  ready: 0,
  working: 3,
  failed: 0,
  anglesReady: 0,
  anglesWanted: 0,
  stage: 'painting',
  elapsedMs: 5_000,
  ...overrides,
});

describe('renderPreparing', () => {
  it('hides itself once there is no pre-flight to report', () => {
    const el = root();
    renderPreparing(el, view(null));
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });

  it('names the stage, the blots, the views and the clock', () => {
    const el = root();
    renderPreparing(el, view(progress({ stage: 'shooting', ready: 1, working: 2, anglesReady: 2, anglesWanted: 6, elapsedMs: 74_000 })));
    expect(el.hidden).toBe(false);
    expect(el.innerHTML).toContain('shooting the camera orbits');
    expect(el.innerHTML).toContain('<strong>1</strong>/3 blots ready');
    expect(el.innerHTML).toContain('views 2/6');
    expect(el.innerHTML).toContain('width:33%');
    expect(el.innerHTML).toContain('1m 14s');
  });

  it('drops the view counter and the orbit wording when no orbits are configured', () => {
    const el = root();
    renderPreparing(el, view(progress({ stage: 'imagining', failed: 1 })));
    expect(el.innerHTML).toContain('asking the vision model what they could be');
    expect(el.innerHTML).toContain('1 dropped');
    expect(el.innerHTML).not.toContain('views');
    expect(el.innerHTML).not.toContain('orbited');
  });

  it('never lets the bar or the view count run past its target', () => {
    const el = root();
    renderPreparing(el, view(progress({ ready: 4, anglesReady: 9, anglesWanted: 6 })));
    expect(el.innerHTML).toContain('width:100%');
    expect(el.innerHTML).toContain('views 6/6');
  });

  it('names a rail that dropped everything', () => {
    const el = root();
    renderPreparing(el, view(progress({ stage: 'stalled', working: 0, failed: 4 })));
    expect(el.innerHTML).toContain('the rail is struggling');
  });
});

/**
 * The recording block is the only place a finished take exists, so the button
 * that plays one back has to say whether it is the take on screen right now.
 */
function recordingView(overrides: Partial<StudioView['recording']> = {}): StudioView {
  const part = { blob: {} as Blob, mime: 'video/webm', container: 'webm' as const, durationMs: 64_000, bytes: 2_048_000, remuxed: false };
  return {
    recording: { state: 'idle', container: 'webm', durationMs: 64_000, bytes: 2_048_000, result: part, parts: [part], ...overrides },
    spend: { dryRun: false, sessionUsd: 1, todayUsd: 2, sessionCapUsd: 5, dailyCapUsd: 10, remainingSessionSeconds: 60 },
    session: { generatedSeconds: 30, bufferSeconds: 4, chunkIndex: 2, route: 'fal', buffering: false, promptVersion: 1, elapsedSeconds: 30, chunks: 3 },
    chain: { sessions: 1, chains: 0, failures: 0, maxChains: 5 },
    capabilities: { ffmpeg: true, sessionMaxSeconds: null, oneSessionPerMachine: true },
    log: [],
    warnings: [],
  } as unknown as StudioView;
}

describe('renderTelemetry', () => {
  it('offers a playback beside the file for every finished take', () => {
    const el = root();
    renderTelemetry(el, recordingView());
    expect(el.innerHTML).toContain('data-action="play-recording" data-index="0"');
    expect(el.innerHTML).toContain('Play <span class="muted">· 1m 04s</span>');
    expect(el.innerHTML).toContain('data-action="download"');
  });

  it('reads as pressed for the take that is on screen', () => {
    const el = root();
    renderTelemetry(el, recordingView(), 0);
    expect(el.innerHTML).toContain('Stop <span class="muted">· 1m 04s</span>');
    expect(el.innerHTML).toContain('class="danger"');
    expect(el.innerHTML).toContain('Playing this take on the stage');
  });

  it('says nothing about playback while nothing is playing', () => {
    const el = root();
    renderTelemetry(el, recordingView(), null);
    expect(el.innerHTML).not.toContain('Playing this take');
  });

  it('lists every part of a run that was paused and resumed', () => {
    const el = root();
    const first = recordingView().recording.parts[0]!;
    renderTelemetry(el, recordingView({ parts: [first, { ...first, bytes: 4096 }] }), 1);
    expect(el.innerHTML).toContain('data-index="0"');
    expect(el.innerHTML).toContain('data-index="1"');
    expect(el.innerHTML).toContain('part 2');
  });
});
