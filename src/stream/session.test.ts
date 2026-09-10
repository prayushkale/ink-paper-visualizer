import { describe, it, expect, beforeEach } from 'vitest';
import { DirectorSession, realTimer, type DirectorSessionEvents } from './session';
import { buildConfigure } from './protocol';
import {
  createWmaTransport,
  type DirectorConnection,
  type DirectorTransport,
  type RealtimeStateName,
  type TransportHandlers,
  type WmaOpenArgs,
} from './transport';

/** A transport that records everything and lets a test drive server frames. */
function fakeTransport() {
  const sent: Array<Record<string, unknown>> = [];
  let handlers: TransportHandlers | null = null;
  let closed = false;
  const transport: DirectorTransport = {
    open(next) {
      handlers = next;
      const connection: DirectorConnection = {
        send: (message) => void sent.push(message as Record<string, unknown>),
        close: async () => { closed = true; },
      };
      return connection;
    },
  };
  return {
    transport,
    sent,
    get closed() { return closed; },
    /** Feeds a raw wire frame, exactly as the server would write it. */
    server(message: Record<string, unknown>) {
      handlers!.onData(JSON.stringify(message));
    },
    raw(text: string) {
      handlers!.onData(text);
    },
    state(state: RealtimeStateName) {
      handlers!.onState(state);
    },
    error(error: unknown) {
      handlers!.onError(error);
    },
    get media() {
      return handlers!.onMedia;
    },
  };
}

function collectingEvents() {
  const seen: Array<[string, unknown]> = [];
  const events: DirectorSessionEvents = new Proxy({} as DirectorSessionEvents, {
    get(_target, property: string) {
      return (...args: unknown[]) => seen.push([property, args.length === 1 ? args[0] : args]);
    },
  });
  return {
    events,
    seen,
    calls: <T = unknown>(name: string): T[] =>
      seen.filter(([key]) => key === name).map(([, payload]) => payload as T),
  };
}

const config = () => buildConfigure({
  prompt: 'A continuous film of ink and paper.',
  imageUrl: 'https://fal.media/first.png',
  resolution: '768p',
  aspectRatio: '16:9',
  memory: 12,
});

describe('DirectorSession', () => {
  let t: ReturnType<typeof fakeTransport>;
  let e: ReturnType<typeof collectingEvents>;
  let session: DirectorSession;

  beforeEach(() => {
    t = fakeTransport();
    e = collectingEvents();
    session = new DirectorSession({ transport: t.transport, events: e.events });
  });

  it('sends configure once, on start, and reports connecting', () => {
    session.start(config());
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ type: 'configure', prompt_version: 1, protocol_version: 1 });
    expect(session.status).toBe('connecting');
  });

  it('refuses to start twice', () => {
    session.start(config());
    expect(() => session.start(config())).toThrow(/already been started/);
  });

  it('refuses to direct before the session has started', () => {
    expect(() => session.direct({ prompt: 'x' })).toThrow(/before the session is started/);
  });

  it('follows the transport into live and starts the keepalive', () => {
    const timers: Array<() => void> = [];
    const scheduled: DirectorSession = new DirectorSession({
      transport: t.transport,
      events: e.events,
      schedule: { set: (fn) => { timers.push(fn); return timers.length; }, clear: () => {} },
      pingIntervalMs: 5000,
    });
    scheduled.start(config());
    scheduled.handleData(JSON.stringify({ type: 'configured', prompt_version: 1, enable_safety_checker: true }));
    t.state('live');
    expect(scheduled.status).toBe('live');
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(t.sent.some((message) => message.type === 'ping')).toBe(true);
  });

  it('does not start a keepalive when no scheduler was injected', () => {
    session.start(config());
    t.state('live');
    expect(t.sent.filter((message) => message.type === 'ping')).toHaveLength(0);
  });

  it('increments prompt_version for every direction', () => {
    session.start(config());
    t.state('live');
    expect(session.direct({ prompt: 'one' })).toBe(2);
    expect(session.direct({ prompt: 'two' })).toBe(3);
    expect(session.direct({ prompt: 'three' })).toBe(4);
    expect(session.promptVersion).toBe(4);
    const versions = t.sent.filter((m) => m.type === 'prompt').map((m) => m.prompt_version);
    expect(versions).toEqual([2, 3, 4]);
  });

  it('sends an arrival image with the direction, which is how a blot lands', () => {
    session.start(config());
    session.direct({ prompt: 'resolve into it', endImageUrl: 'https://fal.media/angle.png' });
    expect(t.sent[1]).toMatchObject({
      type: 'prompt',
      prompt_version: 2,
      end_image_url: 'https://fal.media/angle.png',
    });
  });

  it('can send an image-only direction', () => {
    session.start(config());
    session.direct({ endImageUrl: 'https://fal.media/angle.png' });
    expect(t.sent[1]).toMatchObject({ type: 'prompt', end_image_url: 'https://fal.media/angle.png' });
    expect(t.sent[1]).not.toHaveProperty('prompt');
  });

  it('swaps the pinned score with an explicit behaviour', () => {
    session.start(config());
    session.setAudio('https://fal.media/track.mp3', 'queue');
    expect(t.sent[1]).toMatchObject({ type: 'prompt', audio_url: 'https://fal.media/track.mp3', audio_behavior: 'queue' });
  });

  it('queues a plan-ahead script', () => {
    session.start(config());
    session.queueScript([
      { offset: 10, prompt: 'first', end_image_url: 'https://fal.media/a.png' },
      { offset: 20, prompt: 'second', end_image_url: 'https://fal.media/b.png' },
    ], 'append');
    expect(t.sent[1]).toMatchObject({ type: 'prompt', script_mode: 'append' });
    expect((t.sent[1]!.script as unknown[]).length).toBe(2);
  });

  it('refuses a script that would be rejected on the wire', () => {
    session.start(config());
    expect(() => session.queueScript([
      { offset: 10, end_image_url: 'a' },
      { offset: 11, end_image_url: 'b' },
    ])).toThrow(/3s apart/);
  });

  it('tracks chunk telemetry and accumulates generated seconds', () => {
    session.start(config());
    t.server({ type: 'chunk', chunk_index: 0, prompt_version: 2, requested_duration_seconds: 10, buffer_depth_seconds: 8, playback_seconds: 10 });
    t.server({ type: 'chunk', chunk_index: 1, prompt_version: 2, requested_duration_seconds: 10, buffer_depth_seconds: 12, playback_seconds: 20 });
    expect(session.lastChunk?.chunkIndex).toBe(1);
    expect(session.generatedSeconds).toBe(20);
    expect(e.calls('onChunk')).toHaveLength(2);
  });

  it('caps generated seconds at zero for a nonsensical chunk', () => {
    session.start(config());
    t.server({ type: 'chunk', chunk_index: 0, requested_duration_seconds: -5 });
    expect(session.generatedSeconds).toBe(0);
  });

  it('surfaces session_info including a null session ceiling', () => {
    session.start(config());
    t.server({ type: 'session_info', app: 'minimax-h3-max-director', chunk_seconds: 10, max_session_seconds: null, one_session_per_machine: true });
    expect(session.sessionInfo?.chunkSeconds).toBe(10);
    expect(session.sessionInfo?.maxSessionSeconds).toBeNull();
    expect(e.calls('onSessionInfo')).toHaveLength(1);
  });

  it('reports buffering when generation falls behind playback', () => {
    session.start(config());
    t.server({ type: 'deadline_missed', chunk_index: 3, late_by_seconds: 2.5, behavior: 'freeze_video_and_silence_audio_until_ready' });
    expect(e.calls('onBuffering')[0]).toEqual({ chunkIndex: 3, lateBySeconds: 2.5 });
  });

  it('routes prompt lifecycle frames', () => {
    session.start(config());
    t.server({ type: 'prompt_pending', prompt_version: 2 });
    t.server({ type: 'prompt_applied', prompt_version: 2, script_queued: null, script_mode: null });
    t.server({ type: 'prompt_rejected', prompt_version: 3, reason: 'queue_full', error: 'full' });
    expect(e.calls('onPromptPending')).toHaveLength(1);
    expect(e.calls('onPromptApplied')[0]).toEqual([2, null]);
    expect(e.calls('onPromptRejected')[0]).toEqual({ promptVersion: 3, reason: 'queue_full', error: 'full' });
  });

  it('routes audio frames', () => {
    session.start(config());
    t.server({ type: 'audio_applied', prompt_version: 2, behavior: 'replace', duration_seconds: 120, remaining_seconds: 118 });
    t.server({ type: 'audio_rejected', prompt_version: 2, reason: 'invalid_audio', error: 'bad file' });
    t.server({ type: 'audio_exhausted', chunk_index: 4, silent_seconds: 3 });
    expect(e.calls('onAudioApplied')[0]).toMatchObject({ behavior: 'replace', durationSeconds: 120 });
    expect(e.calls('onAudioRejected')[0]).toEqual({ reason: 'invalid_audio', error: 'bad file' });
    expect(e.calls('onAudioExhausted')[0]).toEqual({ chunkIndex: 4, silentSeconds: 3 });
  });

  it('reports the reason a stream ended so the chain can decide what next', () => {
    session.start(config());
    t.server({ type: 'stream_exhausted', reason: 'session_limit', chunks: 12 });
    expect(e.calls('onExhausted')[0]).toEqual({ reason: 'session_limit', chunks: 12 });
  });

  it('marks a session unrecoverable on a fatal error code', () => {
    session.start(config());
    t.server({ type: 'error', code: 'balance_unavailable', error: 'no credit', prompt_version: null });
    expect(session.fatalError).toMatchObject({ code: 'balance_unavailable' });
    expect(e.calls('onError')[0]).toMatchObject({ code: 'balance_unavailable' });
  });

  it('reports a recoverable error without marking the session fatal', () => {
    session.start(config());
    t.server({ type: 'error', code: 'generation_failed', error: 'one bad chunk', prompt_version: 4 });
    expect(session.fatalError).toBeNull();
    expect(e.calls('onError')[0]).toMatchObject({ code: 'generation_failed' });
  });

  it('narrows an unknown error code instead of pretending to know it', () => {
    session.start(config());
    t.server({ type: 'error', code: 'quantum_flux', error: 'who knows' });
    expect(e.calls('onError')[0]).toMatchObject({ code: 'unknown' });
  });

  it('ignores frames it cannot parse and forwards unrecognised ones', () => {
    session.start(config());
    expect(() => t.raw('not json')).not.toThrow();
    expect(() => t.raw('[]')).not.toThrow();
    t.server({ type: 'session_metrics', final: false, session_wall_ms: 1000, history_size: 3 });
    t.raw(JSON.stringify({ type: 'brand_new_thing', value: 1 }));
    expect(e.calls('onUnknownMessage')).toHaveLength(1);
  });

  it('reports a transport failure', () => {
    session.start(config());
    t.error(new Error('ice failed'));
    expect(session.status).toBe('failed');
    expect(session.fatalError).toMatchObject({ code: 'transport_error' });
  });

  it('treats a remote close that we did not ask for as an ending', () => {
    session.start(config());
    t.state('live');
    t.state('closed');
    expect(session.status).toBe('ended');
  });

  it('sends stop, closes the connection and reports the ending once', async () => {
    session.start(config());
    t.state('live');
    await session.stop();
    await session.stop();
    expect(t.sent.filter((m) => m.type === 'stop')).toHaveLength(1);
    expect(t.closed).toBe(true);
    expect(session.status).toBe('ended');
    const statuses = e.calls<[string, string | undefined]>('onStatus');
    expect(statuses.filter(([status]) => status === 'ended')).toHaveLength(1);
  });

  it('refuses to direct after stopping', async () => {
    session.start(config());
    await session.stop();
    expect(() => session.direct({ prompt: 'too late' })).toThrow(/after the session has stopped/);
  });

  it('still closes the peer when sending stop throws', async () => {
    let closed = false;
    const broken: DirectorTransport = {
      open: () => ({
        send: (message) => {
          if ((message as { type: string }).type === 'stop') throw new Error('channel already gone');
        },
        close: async () => { closed = true; },
      }),
    };
    const session2 = new DirectorSession({ transport: broken, events: e.events });
    session2.start(config());
    await expect(session2.stop()).resolves.toBeUndefined();
    expect(closed).toBe(true);
    expect(session2.status).toBe('ended');
  });

  it('accumulates live wall-clock time, including the stretch still running', () => {
    let clock = 1000;
    const timed = new DirectorSession({ transport: t.transport, events: e.events, now: () => clock });
    timed.start(config());
    expect(timed.liveMs).toBe(0); // never went live
    t.state('live');
    clock = 6000;
    // the chain controller reads this while the film is on air, so it has to
    // grow live rather than only after a stop
    expect(timed.liveMs).toBe(5000);
    void timed.stop();
    return Promise.resolve().then(() => {
      clock = 60_000;
      // stopping freezes the clock: the session is no longer live
      expect(timed.liveMs).toBe(5000);
    });
  });
});

describe('createWmaTransport', () => {
  it('declares both receive tracks before the offer is created', () => {
    let seen: WmaOpenArgs | null = null;
    const transport = createWmaTransport((args) => {
      seen = args;
      return { send: () => {}, close: async () => {} };
    });
    transport.open({ onData: () => {}, onState: () => {}, onError: () => {} });
    expect(seen!.receive).toEqual(['video', 'audio']);
    expect(seen!.endpoint).toBe('minimax/h3-max/director');
  });

  it('passes a custom endpoint through', () => {
    let seen: WmaOpenArgs | null = null;
    const transport = createWmaTransport((args) => {
      seen = args;
      return { send: () => {}, close: async () => {} };
    }, 'acme/other-director');
    transport.open({ onData: () => {}, onState: () => {}, onError: () => {} });
    expect(seen!.endpoint).toBe('acme/other-director');
  });

  it('forwards media, data, state and errors to the handlers', () => {
    const seenEvents: string[] = [];
    const transport = createWmaTransport((args) => {
      args.onData('{}');
      args.onState('live');
      args.onError(new Error('x'));
      args.onMedia?.({} as MediaStream);
      return { send: () => {}, close: async () => {} };
    });
    transport.open({
      onData: () => seenEvents.push('data'),
      onState: () => seenEvents.push('state'),
      onError: () => seenEvents.push('error'),
      onMedia: () => seenEvents.push('media'),
    });
    expect(seenEvents).toEqual(['data', 'state', 'error', 'media']);
  });
});

describe('realTimer', () => {
  it('sets and clears an interval', () => {
    let fired = 0;
    const handle = realTimer.set(() => fired++, 1);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        realTimer.clear(handle);
        const count = fired;
        expect(count).toBeGreaterThan(0);
        setTimeout(() => {
          expect(fired).toBe(count);
          resolve();
        }, 5);
      }, 10);
    });
  });
});
