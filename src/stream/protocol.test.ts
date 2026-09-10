import { describe, it, expect } from 'vitest';
import {
  buildConfigure,
  buildPing,
  buildPrompt,
  buildStop,
  CONFIGURE_FIELDS,
  DIRECTOR_ENDPOINT,
  DIRECTOR_LIMITS,
  parseServerMessage,
  PROMPT_FIELDS,
  PROTOCOL_VERSION,
  PromptVersions,
  validateScript,
  ScriptValidationError,
  type ConfigureInput,
  type ServerMessage,
  type SessionInfo,
} from './protocol';

describe('endpoint constant', () => {
  it('points at the realtime Director app', () => {
    expect(DIRECTOR_ENDPOINT).toBe('minimax/h3-max/director');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('buildConfigure', () => {
  const base: ConfigureInput = {
    prompt: 'A continuous film of ink.',
    imageUrl: 'https://fal.media/blot.png',
    resolution: '768p',
    aspectRatio: '16:9',
    memory: 12,
    seed: 42,
  };

  it('sends only fields the additionalProperties:false schema allows', () => {
    const message = buildConfigure(base);
    for (const key of Object.keys(message)) {
      expect(CONFIGURE_FIELDS.has(key), `unexpected field ${key}`).toBe(true);
    }
  });

  it('always opens at prompt_version 1 with protocol_version 1', () => {
    const message = buildConfigure(base);
    expect(message.type).toBe('configure');
    expect(message.prompt_version).toBe(1);
    expect(message.protocol_version).toBe(1);
  });

  it('omits optional fields rather than sending nulls', () => {
    const message = buildConfigure({ prompt: 'bare' });
    expect(message).not.toHaveProperty('image_url');
    expect(message).not.toHaveProperty('seed');
    expect(message).not.toHaveProperty('audio_url');
    expect(message).not.toHaveProperty('script');
    expect(message).not.toHaveProperty('end_image_url');
  });

  it('accepts a null seed as random rather than sending null', () => {
    expect(buildConfigure({ prompt: 'x', seed: null })).not.toHaveProperty('seed');
    expect(buildConfigure({ prompt: 'x', seed: 7 }).seed).toBe(7);
  });

  it('clamps memory into the documented 1..50 window', () => {
    expect(buildConfigure({ prompt: 'x', memory: 0 }).memory).toBe(1);
    expect(buildConfigure({ prompt: 'x', memory: 999 }).memory).toBe(50);
    expect(buildConfigure({ prompt: 'x', memory: 12.6 }).memory).toBe(13);
  });

  it('carries the pinned soundtrack and the bitrate', () => {
    const message = buildConfigure({ prompt: 'x', audioUrl: 'https://fal.media/track.mp3', audioBitrate: 128000 });
    expect(message.audio_url).toBe('https://fal.media/track.mp3');
    expect(message.audio_bitrate).toBe(128000);
  });

  it('refuses an empty prompt', () => {
    expect(() => buildConfigure({ prompt: '   ' })).toThrow(/needs a prompt/);
  });

  it('refuses a prompt past the 50,000 character ceiling', () => {
    expect(() => buildConfigure({ prompt: 'x'.repeat(DIRECTOR_LIMITS.maxPromptChars + 1) })).toThrow(/50000 characters/);
  });

  it('trims the prompt', () => {
    expect(buildConfigure({ prompt: '  spaced  ' }).prompt).toBe('spaced');
  });

  it('copies a script rather than aliasing the caller array', () => {
    const script = [{ offset: 10, prompt: 'beat' }];
    const message = buildConfigure({ prompt: 'x', script });
    script[0]!.prompt = 'mutated';
    expect(message.script![0]!.prompt).toBe('beat');
  });

  it('rejects an invalid script before spending a session', () => {
    expect(() => buildConfigure({ prompt: 'x', script: [{ offset: 1, end_image_url: 'a' }, { offset: 2, end_image_url: 'b' }] }))
      .toThrow(ScriptValidationError);
  });
});

describe('buildPrompt', () => {
  it('sends only fields the prompt schema allows', () => {
    const message = buildPrompt({ promptVersion: 2, prompt: 'next beat' });
    for (const key of Object.keys(message)) {
      expect(PROMPT_FIELDS.has(key), `unexpected field ${key}`).toBe(true);
    }
  });

  it('carries a text direction', () => {
    expect(buildPrompt({ promptVersion: 2, prompt: ' go ' })).toEqual({
      type: 'prompt', prompt_version: 2, prompt: 'go',
    });
  });

  it('carries an arrival image, which is how a blot lands', () => {
    const message = buildPrompt({ promptVersion: 3, prompt: 'resolve', endImageUrl: 'https://fal.media/angle.png' });
    expect(message.end_image_url).toBe('https://fal.media/angle.png');
  });

  it('carries audio with an explicit behaviour', () => {
    const message = buildPrompt({ promptVersion: 4, audioUrl: 'https://fal.media/b.mp3', audioBehavior: 'queue' });
    expect(message.audio_url).toBe('https://fal.media/b.mp3');
    expect(message.audio_behavior).toBe('queue');
  });

  it('can send a direction with only an image and no text', () => {
    const message = buildPrompt({ promptVersion: 5, endImageUrl: 'https://fal.media/a.png' });
    expect(message.prompt).toBeUndefined();
    expect(message.end_image_url).toBe('https://fal.media/a.png');
  });

  it('refuses an empty direction', () => {
    expect(() => buildPrompt({ promptVersion: 2 })).toThrow(/needs a prompt/);
    expect(() => buildPrompt({ promptVersion: 2, prompt: '   ' })).toThrow(/needs a prompt/);
  });

  it('refuses a prompt_version below 1', () => {
    expect(() => buildPrompt({ promptVersion: 0, prompt: 'x' })).toThrow(/prompt_version/);
    expect(() => buildPrompt({ promptVersion: 1.5, prompt: 'x' })).toThrow(/prompt_version/);
  });

  it('keeps scripts exclusive, exactly as documented', () => {
    const script = [{ offset: 10, prompt: 'beat' }];
    expect(() => buildPrompt({ promptVersion: 2, script, prompt: 'mixed' })).toThrow(/cannot be combined/);
    expect(() => buildPrompt({ promptVersion: 2, script, endImageUrl: 'https://fal.media/a.png' })).toThrow(/cannot be combined/);
    expect(() => buildPrompt({ promptVersion: 2, script, audioUrl: 'https://fal.media/a.mp3' })).toThrow(/cannot be combined/);
  });

  it('stamps the script mode', () => {
    const message = buildPrompt({ promptVersion: 2, script: [{ offset: 0, prompt: 'a' }] });
    expect(message.script_mode).toBe('replace');
    expect(buildPrompt({ promptVersion: 2, script: [{ offset: 0, prompt: 'a' }], scriptMode: 'append' }).script_mode).toBe('append');
  });

  it('passes replan through, since that is how a direction pre-empts the queue', () => {
    expect(buildPrompt({ promptVersion: 2, prompt: 'x', replan: false }).replan).toBe(false);
    expect(buildPrompt({ promptVersion: 2, prompt: 'x' })).not.toHaveProperty('replan');
  });
});

describe('validateScript', () => {
  const beat = (offset: number, extra: Record<string, unknown> = {}) => ({ offset, ...extra }) as { offset: number };

  it('accepts a well-formed plan', () => {
    expect(validateScript([beat(0, { prompt: 'a' }), beat(10, { prompt: 'b' }), beat(20, { end_image_url: 'x' })]))
      .toEqual({ ok: true });
  });

  it('rejects an empty or non-array script', () => {
    expect(validateScript([]).ok).toBe(false);
    expect(validateScript(null as never).ok).toBe(false);
  });

  it('rejects more than 64 beats', () => {
    const beats = Array.from({ length: 65 }, (_, i) => beat(i * 10, { prompt: 'x' }));
    const verdict = validateScript(beats);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/64 beats/);
  });

  it('rejects more than 16 end images', () => {
    const beats = Array.from({ length: 17 }, (_, i) => beat(i * 10, { end_image_url: `u${i}` }));
    const verdict = validateScript(beats);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/16 end images/);
  });

  it('rejects end images closer than three seconds', () => {
    const verdict = validateScript([beat(0, { end_image_url: 'a' }), beat(2, { end_image_url: 'b' })]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/at least 3s apart/);
    expect(validateScript([beat(0, { end_image_url: 'a' }), beat(3, { end_image_url: 'b' })]).ok).toBe(true);
  });

  it('rejects non-integer and negative offsets', () => {
    expect(validateScript([beat(1.5, { prompt: 'x' })]).ok).toBe(false);
    expect(validateScript([beat(-1, { prompt: 'x' })]).ok).toBe(false);
  });

  it('rejects offsets that go backwards', () => {
    const verdict = validateScript([beat(20, { prompt: 'a' }), beat(10, { prompt: 'b' })]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/must not decrease/);
  });

  it('allows repeated offsets so text and an audio cue can share a second', () => {
    expect(validateScript([beat(10, { prompt: 'a' }), beat(10, { audio_url: 'u' })]).ok).toBe(true);
  });

  it('rejects an empty prompt or empty url rather than sending it', () => {
    expect(validateScript([beat(0, { prompt: '' })]).ok).toBe(false);
    expect(validateScript([beat(0, { end_image_url: '' })]).ok).toBe(false);
  });

  it('rejects a script with nothing in it', () => {
    expect(validateScript([beat(0)]).ok).toBe(false);
  });
});

describe('PromptVersions', () => {
  it('starts at 1 and strictly increases', () => {
    const versions = new PromptVersions();
    expect(versions.current).toBe(1);
    expect([versions.next(), versions.next(), versions.next()]).toEqual([2, 3, 4]);
    expect(versions.current).toBe(4);
  });
});

describe('parseServerMessage', () => {
  it('parses session_info with the documented constants', () => {
    const message = parseServerMessage(JSON.stringify({
      type: 'session_info',
      app: 'minimax-h3-max-director',
      protocol_version: 1,
      fps: 24,
      chunk_seconds: 10,
      min_chunk_duration: 5,
      max_chunk_duration: 15,
      default_chunk_duration: 10,
      resolutions: ['480p', '768p', '1080p'],
      aspect_ratios: ['16:9', '9:16', '1:1'],
      audio_bitrates: [96000, 128000, 192000],
      default_memory: 12,
      min_memory: 1,
      max_memory: 50,
      scripts: true,
      script_modes: ['replace', 'append'],
      script_max_beats: 64,
      script_max_end_images: 16,
      script_min_end_image_spacing_seconds: 3,
      script_max_queued: 4,
      script_max_pending: 4,
      max_audio_source_seconds: 600,
      max_session_seconds: null,
      session_limit_scope: 'configured',
      one_session_per_machine: true,
      continuation_context_frames: 39,
      continuation_playback_seconds: 8.5,
      prompt_context_segments: 12,
      prompt_deck_size: 6,
      prompt_expander: 'fast',
    }));
    expect(message?.type).toBe('session_info');
    if (message?.type !== 'session_info') throw new Error('wrong type');
    const info: SessionInfo = message.info;
    expect(info.app).toBe('minimax-h3-max-director');
    expect(info.fps).toBe(24);
    expect(info.chunkSeconds).toBe(10);
    expect(info.resolutions).toEqual(['480p', '768p', '1080p']);
    expect(info.maxSessionSeconds).toBeNull();
    expect(info.oneSessionPerMachine).toBe(true);
    expect(info.continuationContextFrames).toBe(39);
    expect(info.maxQueuedScripts).toBe(4);
  });

  it('defaults session_info fields the server omits', () => {
    const message = parseServerMessage('{"type":"session_info"}');
    if (message?.type !== 'session_info') throw new Error('wrong type');
    expect(message.info.fps).toBe(24);
    expect(message.info.chunkSeconds).toBe(10);
    expect(message.info.maxBeats).toBe(64);
    expect(message.info.maxSessionSeconds).toBeNull();
    expect(message.info.scripts).toBe(false);
  });

  it('parses configured', () => {
    const message = parseServerMessage(JSON.stringify({
      type: 'configured', prompt_version: 1, enable_safety_checker: true,
      resolution: '768p', aspect_ratio: '16:9', memory: 12, acceleration: 'regular',
      chunk_duration: 10, has_initial_image: true, has_initial_audio: true,
    }));
    if (message?.type !== 'configured') throw new Error('wrong type');
    expect(message.resolution).toBe('768p');
    expect(message.chunkDuration).toBe(10);
    expect(message.hasInitialImage).toBe(true);
    expect(message.safetyChecker).toBe(true);
  });

  it('parses a chunk with its buffer and timing telemetry', () => {
    const message = parseServerMessage(JSON.stringify({
      type: 'chunk', chunk_index: 7, prompt_version: 4, requested_duration_seconds: 10,
      playback_seconds: 70, buffer_depth_seconds: 12.5, buffer_depth_chunks: 2,
      next_generation_estimate_seconds: 8, generation_seconds: 9.4, route: 'regulus',
      trimmed_context_frames: 39, script_offset_seconds: 60, script_version: 2,
    }));
    if (message?.type !== 'chunk') throw new Error('wrong type');
    expect(message.chunk.chunkIndex).toBe(7);
    expect(message.chunk.bufferDepthSeconds).toBe(12.5);
    expect(message.chunk.route).toBe('regulus');
    expect(message.chunk.scriptOffsetSeconds).toBe(60);
  });

  it('parses prompt lifecycle frames', () => {
    expect(parseServerMessage('{"type":"prompt_pending","prompt_version":5}')).toMatchObject({ type: 'prompt_pending', promptVersion: 5 });
    expect(parseServerMessage('{"type":"prompt_applied","prompt_version":5,"script_queued":2,"script_mode":"append"}'))
      .toMatchObject({ type: 'prompt_applied', promptVersion: 5, scriptQueued: 2, scriptMode: 'append' });
    expect(parseServerMessage('{"type":"prompt_rejected","prompt_version":5,"reason":"queue_full","error":"full"}'))
      .toMatchObject({ type: 'prompt_rejected', promptVersion: 5, reason: 'queue_full', error: 'full' });
  });

  it('parses every documented rejection reason', () => {
    const reasons = ['content_policy', 'preparation_failed', 'stale_prompt_version', 'invalid_script',
      'infeasible_timing', 'invalid_audio', 'invalid_image', 'queue_full'];
    for (const reason of reasons) {
      const message = parseServerMessage(JSON.stringify({ type: 'prompt_rejected', prompt_version: 2, reason }));
      expect(message, reason).toMatchObject({ type: 'prompt_rejected', reason });
    }
  });

  it('parses audio frames', () => {
    expect(parseServerMessage('{"type":"audio_applied","prompt_version":3,"behavior":"replace","duration_seconds":120,"remaining_seconds":118,"queued_sources":0,"source":"upload","transcribed":false}'))
      .toMatchObject({ type: 'audio_applied', behavior: 'replace', durationSeconds: 120, remainingSeconds: 118 });
    expect(parseServerMessage('{"type":"audio_rejected","prompt_version":3,"reason":"invalid_audio","error":"bad"}'))
      .toMatchObject({ type: 'audio_rejected', reason: 'invalid_audio' });
    expect(parseServerMessage('{"type":"audio_exhausted","chunk_index":2,"silent_seconds":3.5}'))
      .toMatchObject({ type: 'audio_exhausted', chunkIndex: 2, silentSeconds: 3.5 });
  });

  it('parses deadline_missed and stream_exhausted', () => {
    expect(parseServerMessage('{"type":"deadline_missed","chunk_index":4,"late_by_seconds":2.5,"behavior":"freeze_video_and_silence_audio_until_ready"}'))
      .toMatchObject({ type: 'deadline_missed', chunkIndex: 4, lateBySeconds: 2.5 });
    expect(parseServerMessage('{"type":"stream_exhausted","reason":"session_limit","chunks":12}'))
      .toMatchObject({ type: 'stream_exhausted', reason: 'session_limit', chunks: 12 });
  });

  it('parses every documented error code', () => {
    const codes = ['balance_unavailable', 'content_policy', 'configuration_timeout', 'generation_failed',
      'generation_timeout', 'immutable_settings', 'initialization_timeout', 'invalid_initial_image',
      'invalid_initial_audio', 'invalid_initial_script', 'invalid_input', 'invalid_message',
      'not_configured', 'stale_prompt_version'];
    for (const code of codes) {
      const message = parseServerMessage(JSON.stringify({ type: 'error', code, error: 'boom', prompt_version: 2 }));
      expect(message, code).toMatchObject({ type: 'error', code, message: 'boom', promptVersion: 2 });
    }
  });

  it('survives malformed frames without throwing', () => {
    for (const raw of ['', 'not json', '[]', 'null', '"text"', '42', '{}']) {
      expect(() => parseServerMessage(raw), raw).not.toThrow();
    }
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
    expect(parseServerMessage('{}')).toMatchObject({ type: 'unknown' });
  });

  it('reports an unrecognised frame type as unknown rather than dropping it', () => {
    const message = parseServerMessage('{"type":"quantum_flux","value":1}');
    expect(message).toMatchObject({ type: 'unknown' });
    if (message?.type !== 'unknown') throw new Error('wrong type');
    expect(message.raw.type).toBe('quantum_flux');
  });

  it('coerces wrong-typed fields instead of trusting them', () => {
    const message = parseServerMessage('{"type":"error","code":42,"error":null,"prompt_version":"two"}');
    if (message?.type !== 'error') throw new Error('wrong type');
    expect(typeof message.code).toBe('string');
    expect(typeof message.message).toBe('string');
    expect(message.promptVersion).toBeNull();
  });
});

describe('buildStop and buildPing', () => {
  it('are exactly what the schema expects', () => {
    expect(buildStop()).toEqual({ type: 'stop' });
    expect(buildPing(1234)).toEqual({ type: 'ping', ts: 1234 });
  });
});
