import { describe, it, expect } from 'vitest';
import {
  RecorderUnavailableError,
  StreamRecorder,
  chooseRecordingMime,
  containerOf,
  recordingCandidates,
  type RecordingSupport,
  type RecorderLike,
} from './recorder';

const support = (...mimes: string[]): RecordingSupport => ({
  isTypeSupported: (mime) => mimes.includes(mime),
});

/** A MediaRecorder stand-in that hands over chunks when told to. */
function fakeRecorder() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const calls: string[] = [];
  const recorder: RecorderLike = {
    start: (timeslice) => void calls.push(`start:${timeslice ?? 'none'}`),
    stop: () => {
      calls.push('stop');
      // behave like a real recorder: a final chunk, then stop
      emit('dataavailable', { data: new Blob([new Uint8Array(64)], { type: 'video/webm' }) });
      emit('stop', {});
    },
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    addEventListener: (type: string, listener: (event: never) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener as (event: unknown) => void);
      listeners.set(type, list);
    },
  };
  function emit(type: string, event: unknown): void {
    for (const listener of listeners.get(type) ?? []) listener(event);
  }
  return { recorder, calls, emit };
}

describe('recordingCandidates / containerOf', () => {
  it('puts mp4 first by default so the file can be posted as-is', () => {
    const candidates = recordingCandidates();
    expect(candidates[0]).toMatch(/^video\/mp4/);
    expect(candidates.findIndex((m) => m.startsWith('video/webm')))
      .toBeGreaterThan(candidates.findIndex((m) => m.startsWith('video/mp4')));
  });

  it('reorders when mp4 is not wanted', () => {
    expect(recordingCandidates(false)[0]).toMatch(/^video\/webm/);
  });

  it('always offers a plain container last as a last resort', () => {
    for (const preferMp4 of [true, false]) {
      const candidates = recordingCandidates(preferMp4);
      expect(candidates).toContain('video/mp4');
      expect(candidates).toContain('video/webm');
    }
  });

  it('identifies the container', () => {
    expect(containerOf('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('mp4');
    expect(containerOf('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(containerOf('video/ogg')).toBe('ogg');
    expect(containerOf('audio/mpeg')).toBe('unknown');
  });
});

describe('chooseRecordingMime', () => {
  it('takes the best mp4 the browser offers', () => {
    const chosen = chooseRecordingMime(support('video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm'));
    expect(chosen).toEqual({ mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', container: 'mp4' });
  });

  it('falls back to a lower mp4 profile', () => {
    const chosen = chooseRecordingMime(support('video/mp4', 'video/webm'));
    expect(chosen).toEqual({ mime: 'video/mp4', container: 'mp4' });
  });

  it('falls back to webm when mp4 is unsupported', () => {
    const chosen = chooseRecordingMime(support('video/webm;codecs=vp9,opus'));
    expect(chosen).toEqual({ mime: 'video/webm;codecs=vp9,opus', container: 'webm' });
  });

  it('returns null when nothing is supported', () => {
    expect(chooseRecordingMime(support())).toBeNull();
  });

  it('survives a support probe that throws', () => {
    expect(chooseRecordingMime({ isTypeSupported: () => { throw new Error('nope'); } })).toBeNull();
  });
});

describe('StreamRecorder', () => {
  const stream = {} as MediaStream;

  it('starts with the chosen container and a timeslice', () => {
    const fake = fakeRecorder();
    const recorder = new StreamRecorder({
      support: support('video/webm'),
      createRecorder: () => fake.recorder,
      timesliceMs: 500,
    });
    const chosen = recorder.start(stream);
    expect(chosen.container).toBe('webm');
    expect(fake.calls).toEqual(['start:500']);
    expect(recorder.state).toBe('recording');
  });

  it('refuses to start twice', () => {
    const fake = fakeRecorder();
    const recorder = new StreamRecorder({ support: support('video/webm'), createRecorder: () => fake.recorder });
    recorder.start(stream);
    expect(() => recorder.start(stream)).toThrow(/already recording/);
  });

  it('throws when the browser cannot record at all', () => {
    const recorder = new StreamRecorder({ support: support() });
    expect(() => recorder.start(stream)).toThrow(RecorderUnavailableError);
  });

  it('collects chunks and resolves a file on stop', async () => {
    const fake = fakeRecorder();
    let clock = 1000;
    const recorder = new StreamRecorder({
      support: support('video/webm'),
      createRecorder: () => fake.recorder,
      now: () => clock,
    });
    recorder.start(stream);
    clock = 6000;
    const recording = await recorder.stop();
    expect(recording).toMatchObject({ container: 'webm', durationMs: 5000, bytes: 64 });
    expect(recording!.blob.size).toBe(64);
  });

  it('excludes paused time from the duration', async () => {
    const fake = fakeRecorder();
    let clock = 0;
    const recorder = new StreamRecorder({
      support: support('video/webm'),
      createRecorder: () => fake.recorder,
      now: () => clock,
    });
    recorder.start(stream);
    clock = 4000;
    recorder.pause();
    expect(recorder.state).toBe('paused');
    clock = 10_000;
    recorder.resume();
    expect(recorder.state).toBe('recording');
    clock = 12_000;
    const recording = await recorder.stop();
    expect(recording!.durationMs).toBe(6000);
    expect(fake.calls).toContain('pause');
    expect(fake.calls).toContain('resume');
  });

  it('resolves null when nothing was recorded', async () => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const silent: RecorderLike = {
      start: () => {},
      stop: () => { for (const l of listeners.get('stop') ?? []) l({}); },
      pause: () => {},
      resume: () => {},
      addEventListener: (type: string, listener: (event: never) => void) => {
        const list = listeners.get(type) ?? [];
        list.push(listener as (event: unknown) => void);
        listeners.set(type, list);
      },
    };
    const recorder = new StreamRecorder({ support: support('video/webm'), createRecorder: () => silent });
    recorder.start(stream);
    await expect(recorder.stop()).resolves.toBeNull();
  });

  it('resolves null when stop is called before start', async () => {
    const recorder = new StreamRecorder({ support: support('video/webm') });
    await expect(recorder.stop()).resolves.toBeNull();
  });

  it('keeps the original file when the remux fails', async () => {
    const fake = fakeRecorder();
    const recorder = new StreamRecorder({
      support: support('video/webm'),
      createRecorder: () => fake.recorder,
      remux: async () => { throw new Error('ffmpeg unavailable'); },
    });
    recorder.start(stream);
    const recording = await recorder.stop();
    expect(recording!.container).toBe('webm');
    expect(recording!.remuxed).toBe(false);
    expect(recording!.bytes).toBe(64);
  });

  it('remuxes a webm into an mp4 when it can', async () => {
    const fake = fakeRecorder();
    const recorder = new StreamRecorder({
      support: support('video/webm'),
      createRecorder: () => fake.recorder,
      remux: async (blob) => new Blob([blob, new Uint8Array(32)], { type: 'video/mp4' }),
    });
    recorder.start(stream);
    const recording = await recorder.stop();
    expect(recording).toMatchObject({ container: 'mp4', remuxed: true, mime: 'video/mp4' });
    expect(recording!.bytes).toBe(96);
  });

  it('does not remux what is already an mp4', async () => {
    const fake = fakeRecorder();
    let remuxCalled = false;
    const recorder = new StreamRecorder({
      support: support('video/mp4'),
      createRecorder: () => fake.recorder,
      remux: async (blob) => {
        remuxCalled = true;
        return blob;
      },
    });
    recorder.start(stream);
    const recording = await recorder.stop();
    expect(recording!.container).toBe('mp4');
    expect(remuxCalled).toBe(false);
  });

  it('ignores empty data chunks', async () => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const emit = (type: string, event: unknown): void => {
      for (const l of listeners.get(type) ?? []) l(event);
    };
    const choppy: RecorderLike = {
      start: () => {},
      stop: () => {
        emit('dataavailable', { data: new Blob([]) });
        emit('dataavailable', { data: new Blob([new Uint8Array(8)]) });
        emit('stop', {});
      },
      pause: () => {},
      resume: () => {},
      addEventListener: (type: string, listener: (event: never) => void) => {
        const list = listeners.get(type) ?? [];
        list.push(listener as (event: unknown) => void);
        listeners.set(type, list);
      },
    };
    const recorder = new StreamRecorder({ support: support('video/webm'), createRecorder: () => choppy });
    recorder.start(stream);
    const recording = await recorder.stop();
    expect(recording!.bytes).toBe(8);
  });

  it('reports a second stop with the same result', async () => {
    const fake = fakeRecorder();
    const recorder = new StreamRecorder({ support: support('video/webm'), createRecorder: () => fake.recorder });
    recorder.start(stream);
    const first = await recorder.stop();
    const second = await recorder.stop();
    expect(second).toEqual(first);
    expect(fake.calls.filter((call) => call === 'stop')).toHaveLength(1);
  });

  it('can be reset so a chained session records again', async () => {
    const fake = fakeRecorder();
    const recorder = new StreamRecorder({ support: support('video/webm'), createRecorder: () => fake.recorder });
    recorder.start(stream);
    await recorder.stop();
    recorder.reset();
    expect(recorder.state).toBe('idle');
    const chosen = recorder.start(stream);
    expect(chosen.container).toBe('webm');
  });
});
