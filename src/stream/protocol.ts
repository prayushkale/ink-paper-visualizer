/**
 * The Director wire protocol, in one place.
 *
 * `fal.realtime.open()` is documented as experimental and may change in a minor
 * release, so every message shape, limit and parse lives here and nowhere else.
 * The client `configure` schema is `additionalProperties: false`: sending a
 * field the model does not know is an error, not a hint, so the builders below
 * are the only way to construct a message.
 */

export const DIRECTOR_ENDPOINT = 'minimax/h3-max/director';
export const PROTOCOL_VERSION = 1;

/** Documented hard limits. */
export const DIRECTOR_LIMITS = {
  maxPromptChars: 50_000,
  maxBeats: 64,
  maxEndImages: 16,
  minEndImageSpacingSeconds: 3,
  minMemory: 1,
  maxMemory: 50,
  defaultMemory: 12,
  minChunkSeconds: 5,
  maxChunkSeconds: 15,
  defaultChunkSeconds: 10,
  audioBitrates: [96_000, 128_000, 192_000] as const,
  maxQueuedScripts: 4,
  maxPendingScripts: 4,
} as const;

export type DirectorResolution = '480p' | '768p' | '1080p';
export type DirectorAspect = '16:9' | '9:16' | '1:1';
export type AudioBehavior = 'replace' | 'queue';
export type ScriptMode = 'replace' | 'append';

export interface ScriptBeat {
  /** Whole seconds from the start of the first clip generated under the script. */
  offset: number;
  prompt?: string;
  end_image_url?: string;
  audio_url?: string;
}

export interface ConfigureMessage {
  type: 'configure';
  prompt_version: number;
  protocol_version: typeof PROTOCOL_VERSION;
  prompt: string;
  image_url?: string;
  end_image_url?: string;
  resolution?: DirectorResolution;
  aspect_ratio?: DirectorAspect;
  memory?: number;
  seed?: number;
  audio_url?: string;
  audio_bitrate?: (typeof DIRECTOR_LIMITS.audioBitrates)[number];
  script?: ScriptBeat[];
}

export interface PromptMessage {
  type: 'prompt';
  prompt_version: number;
  prompt?: string;
  end_image_url?: string;
  audio_url?: string;
  audio_behavior?: AudioBehavior;
  replan?: boolean;
  script?: ScriptBeat[];
  script_mode?: ScriptMode;
}

export interface PingMessage {
  type: 'ping';
  ts: number;
}

export interface StopMessage {
  type: 'stop';
}

export type ClientMessage = ConfigureMessage | PromptMessage | PingMessage | StopMessage;

export class ScriptValidationError extends Error {
  constructor(message: string) {
    super(`script rejected before it was sent: ${message}`);
    this.name = 'ScriptValidationError';
  }
}

/**
 * Validates an upfront script against every documented rule, because a rejected
 * script costs a round trip and, worse, a visible hole in a live film.
 */
export function validateScript(beats: ScriptBeat[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(beats) || beats.length === 0) return { ok: false, reason: 'a script needs at least one beat' };
  if (beats.length > DIRECTOR_LIMITS.maxBeats) {
    return { ok: false, reason: `at most ${DIRECTOR_LIMITS.maxBeats} beats, got ${beats.length}` };
  }
  let previousOffset = -1;
  let endImages: number[] = [];
  let textBeats = 0;
  for (const beat of beats) {
    if (!Number.isInteger(beat.offset) || beat.offset < 0) {
      return { ok: false, reason: `offset must be a whole number of seconds >= 0 (got ${beat.offset})` };
    }
    if (beat.offset < previousOffset) return { ok: false, reason: 'offsets must not decrease' };
    previousOffset = beat.offset;
    if (beat.prompt !== undefined) {
      if (beat.prompt.length === 0) return { ok: false, reason: 'an included prompt must not be empty' };
      if (beat.prompt.length > DIRECTOR_LIMITS.maxPromptChars) {
        return { ok: false, reason: 'a beat prompt exceeds the 50,000 character limit' };
      }
      textBeats++;
    }
    if (beat.end_image_url !== undefined) {
      if (beat.end_image_url === '') return { ok: false, reason: 'an included end image must have a url' };
      endImages.push(beat.offset);
    }
  }
  if (endImages.length > DIRECTOR_LIMITS.maxEndImages) {
    return { ok: false, reason: `at most ${DIRECTOR_LIMITS.maxEndImages} end images, got ${endImages.length}` };
  }
  for (let i = 1; i < endImages.length; i++) {
    const gap = endImages[i]! - endImages[i - 1]!;
    if (gap < DIRECTOR_LIMITS.minEndImageSpacingSeconds) {
      return {
        ok: false,
        reason: `end images must be at least ${DIRECTOR_LIMITS.minEndImageSpacingSeconds}s apart (got ${gap}s at offset ${endImages[i]})`,
      };
    }
  }
  if (textBeats === 0 && endImages.length === 0) {
    return { ok: false, reason: 'a script needs at least one prompt or end image' };
  }
  return { ok: true };
}

export interface ConfigureInput {
  prompt: string;
  promptVersion?: number;
  imageUrl?: string;
  endImageUrl?: string;
  resolution?: DirectorResolution;
  aspectRatio?: DirectorAspect;
  memory?: number;
  seed?: number | null;
  audioUrl?: string | null;
  audioBitrate?: ConfigureMessage['audio_bitrate'];
  script?: ScriptBeat[];
}

/** Builds the one `configure` message that opens a session's world. */
export function buildConfigure(input: ConfigureInput): ConfigureMessage {
  const prompt = input.prompt.trim();
  if (prompt === '') throw new Error('configure needs a prompt');
  if (prompt.length > DIRECTOR_LIMITS.maxPromptChars) {
    throw new Error(`configure prompt exceeds ${DIRECTOR_LIMITS.maxPromptChars} characters`);
  }
  const message: ConfigureMessage = {
    type: 'configure',
    prompt_version: input.promptVersion ?? 1,
    protocol_version: PROTOCOL_VERSION,
    prompt,
  };
  if (input.imageUrl) message.image_url = input.imageUrl;
  if (input.endImageUrl) message.end_image_url = input.endImageUrl;
  if (input.resolution) message.resolution = input.resolution;
  if (input.aspectRatio) message.aspect_ratio = input.aspectRatio;
  if (input.memory !== undefined) {
    message.memory = Math.min(DIRECTOR_LIMITS.maxMemory, Math.max(DIRECTOR_LIMITS.minMemory, Math.round(input.memory)));
  }
  if (input.seed !== undefined && input.seed !== null) message.seed = Math.round(input.seed);
  if (input.audioUrl) message.audio_url = input.audioUrl;
  if (input.audioBitrate !== undefined) message.audio_bitrate = input.audioBitrate;
  if (input.script) {
    const verdict = validateScript(input.script);
    if (!verdict.ok) throw new ScriptValidationError(verdict.reason);
    message.script = input.script.map((beat) => ({ ...beat }));
  }
  return message;
}

export interface DirectInput {
  promptVersion: number;
  prompt?: string;
  endImageUrl?: string | null;
  audioUrl?: string | null;
  audioBehavior?: AudioBehavior;
  replan?: boolean;
  script?: ScriptBeat[];
  scriptMode?: ScriptMode;
}

/**
 * Builds a live direction. A direction may carry text, an end image, an audio
 * source, or a whole new script - but a script is exclusive with the others,
 * exactly as documented.
 */
export function buildPrompt(input: DirectInput): PromptMessage {
  if (!Number.isInteger(input.promptVersion) || input.promptVersion < 1) {
    throw new Error('prompt_version must be an integer >= 1');
  }
  const message: PromptMessage = { type: 'prompt', prompt_version: input.promptVersion };
  if (input.script) {
    const verdict = validateScript(input.script);
    if (!verdict.ok) throw new ScriptValidationError(verdict.reason);
    if (input.prompt || input.endImageUrl || input.audioUrl) {
      throw new ScriptValidationError('a script cannot be combined with prompt, end_image_url or audio_url');
    }
    message.script = input.script.map((beat) => ({ ...beat }));
    message.script_mode = input.scriptMode ?? 'replace';
    return message;
  }
  const prompt = input.prompt?.trim();
  if (prompt) {
    if (prompt.length > DIRECTOR_LIMITS.maxPromptChars) {
      throw new Error(`direction exceeds ${DIRECTOR_LIMITS.maxPromptChars} characters`);
    }
    message.prompt = prompt;
  }
  if (input.endImageUrl) message.end_image_url = input.endImageUrl;
  if (input.audioUrl) message.audio_url = input.audioUrl;
  if (input.audioBehavior) message.audio_behavior = input.audioBehavior;
  if (input.replan !== undefined) message.replan = input.replan;
  if (message.prompt === undefined && message.end_image_url === undefined && message.audio_url === undefined) {
    throw new Error('a direction needs a prompt, an end image or an audio source');
  }
  return message;
}

export function buildPing(ts: number): PingMessage {
  return { type: 'ping', ts };
}

export function buildStop(): StopMessage {
  return { type: 'stop' };
}

/** Every field name the Director `configure` schema accepts, and nothing else. */
export const CONFIGURE_FIELDS = new Set([
  'type', 'prompt_version', 'protocol_version', 'prompt', 'image_url',
  'end_image_url', 'resolution', 'aspect_ratio', 'memory', 'seed',
  'audio_url', 'audio_bitrate', 'script',
]);

export const PROMPT_FIELDS = new Set([
  'type', 'prompt_version', 'prompt', 'end_image_url', 'audio_url',
  'audio_behavior', 'replan', 'script', 'script_mode',
]);

// --------------------------------------------------------------- server side

export interface SessionInfo {
  app: string;
  protocolVersion: number;
  fps: number;
  chunkSeconds: number;
  minChunkDuration: number;
  maxChunkDuration: number;
  defaultChunkDuration: number;
  resolutions: string[];
  aspectRatios: string[];
  audioBitrates: number[];
  memoryDefault: number;
  memoryMin: number;
  memoryMax: number;
  scripts: boolean;
  scriptModes: string[];
  maxBeats: number;
  maxEndImages: number;
  minEndImageSpacingSeconds: number;
  maxQueuedScripts: number;
  maxPendingScripts: number;
  maxAudioSourceSeconds: number;
  maxSessionSeconds: number | null;
  sessionLimitScope: 'configured' | 'effective' | null;
  oneSessionPerMachine: boolean;
  continuationContextFrames: number;
  continuationPlaybackSeconds: number;
  promptContextSegments: number;
  promptDeckSize: number;
  promptExpander: string;
  raw: Record<string, unknown>;
}

export interface ChunkInfo {
  chunkIndex: number;
  promptVersion: number;
  requestedDurationSeconds: number;
  playbackSeconds: number;
  bufferDepthSeconds: number;
  bufferDepthChunks: number;
  nextGenerationEstimateSeconds: number;
  generationSeconds: number;
  route: string;
  trimmedContextFrames: number;
  scriptOffsetSeconds: number | null;
  scriptVersion: number | null;
}

export type ServerMessage =
  | { type: 'session_info'; info: SessionInfo }
  | {
      type: 'configured';
      promptVersion: number;
      resolution: string | null;
      aspectRatio: string | null;
      memory: number | null;
      audioBitrate: number | null;
      acceleration: string | null;
      chunkDuration: number | null;
      safetyChecker: boolean;
      hasInitialImage: boolean | null;
      hasInitialAudio: boolean | null;
    }
  | { type: 'chunk'; chunk: ChunkInfo }
  | { type: 'prompt_pending'; promptVersion: number }
  | { type: 'prompt_applied'; promptVersion: number; scriptQueued: number | null; scriptMode: string | null }
  | { type: 'prompt_rejected'; promptVersion: number; reason: string; error: string | null }
  | { type: 'audio_pending'; promptVersion: number; behavior: string | null }
  | { type: 'audio_applied'; promptVersion: number; behavior: string | null; durationSeconds: number; remainingSeconds: number }
  | { type: 'audio_rejected'; promptVersion: number; reason: string; error: string }
  | { type: 'audio_exhausted'; chunkIndex: number; silentSeconds: number }
  | { type: 'deadline_missed'; chunkIndex: number; lateBySeconds: number; behavior: string }
  | { type: 'stream_exhausted'; reason: 'stopped' | 'session_limit' | string; chunks: number }
  | { type: 'session_metrics'; final: boolean; sessionWallMs: number | null; historySize: number | null }
  | { type: 'pong'; clientTs: number | null }
  | { type: 'error'; code: string; message: string; promptVersion: number | null }
  | { type: 'unknown'; raw: Record<string, unknown> };

const SERVER_ERROR_CODES = [
  'balance_unavailable', 'content_policy', 'configuration_timeout', 'generation_failed',
  'generation_timeout', 'immutable_settings', 'initialization_timeout', 'invalid_initial_image',
  'invalid_initial_audio', 'invalid_initial_script', 'invalid_input', 'invalid_message',
  'not_configured', 'stale_prompt_version',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];
/** Server codes plus the two conditions the client can itself observe. */
export type StudioErrorCode = ServerErrorCode | 'transport_error' | 'unknown';

/** Narrows an arbitrary server code onto the set we handle explicitly. */
export function asStudioErrorCode(code: string): StudioErrorCode {
  return (SERVER_ERROR_CODES as readonly string[]).includes(code) ? (code as ServerErrorCode) : 'unknown';
}

const REASONS_REJECTED = new Set([
  'content_policy', 'preparation_failed', 'stale_prompt_version', 'invalid_script',
  'infeasible_timing', 'invalid_audio', 'invalid_image', 'queue_full',
]);

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

function parseSessionInfo(raw: Record<string, unknown>): SessionInfo {
  const scope = asString(raw.session_limit_scope);
  return {
    app: asString(raw.app) ?? 'unknown',
    protocolVersion: asNumber(raw.protocol_version) ?? PROTOCOL_VERSION,
    fps: asNumber(raw.fps) ?? 24,
    chunkSeconds: asNumber(raw.chunk_seconds) ?? DIRECTOR_LIMITS.defaultChunkSeconds,
    minChunkDuration: asNumber(raw.min_chunk_duration) ?? DIRECTOR_LIMITS.minChunkSeconds,
    maxChunkDuration: asNumber(raw.max_chunk_duration) ?? DIRECTOR_LIMITS.maxChunkSeconds,
    defaultChunkDuration: asNumber(raw.default_chunk_duration) ?? DIRECTOR_LIMITS.defaultChunkSeconds,
    resolutions: asStringArray(raw.resolutions),
    aspectRatios: asStringArray(raw.aspect_ratios),
    audioBitrates: asNumberArray(raw.audio_bitrates),
    memoryDefault: asNumber(raw.default_memory) ?? DIRECTOR_LIMITS.defaultMemory,
    memoryMin: asNumber(raw.min_memory) ?? DIRECTOR_LIMITS.minMemory,
    memoryMax: asNumber(raw.max_memory) ?? DIRECTOR_LIMITS.maxMemory,
    scripts: raw.scripts === true,
    scriptModes: asStringArray(raw.script_modes),
    maxBeats: asNumber(raw.script_max_beats) ?? DIRECTOR_LIMITS.maxBeats,
    maxEndImages: asNumber(raw.script_max_end_images) ?? DIRECTOR_LIMITS.maxEndImages,
    minEndImageSpacingSeconds: asNumber(raw.script_min_end_image_spacing_seconds) ?? DIRECTOR_LIMITS.minEndImageSpacingSeconds,
    maxQueuedScripts: asNumber(raw.script_max_queued) ?? DIRECTOR_LIMITS.maxQueuedScripts,
    maxPendingScripts: asNumber(raw.script_max_pending) ?? DIRECTOR_LIMITS.maxPendingScripts,
    maxAudioSourceSeconds: asNumber(raw.max_audio_source_seconds) ?? 600,
    // null means the server did not state a ceiling; the app must not assume one
    maxSessionSeconds: asNumber(raw.max_session_seconds),
    sessionLimitScope: scope === 'configured' || scope === 'effective' ? scope : null,
    oneSessionPerMachine: raw.one_session_per_machine !== false,
    continuationContextFrames: asNumber(raw.continuation_context_frames) ?? 39,
    continuationPlaybackSeconds: asNumber(raw.continuation_playback_seconds) ?? 8.5,
    promptContextSegments: asNumber(raw.prompt_context_segments) ?? 12,
    promptDeckSize: asNumber(raw.prompt_deck_size) ?? 6,
    promptExpander: asString(raw.prompt_expander) ?? 'fast',
    raw,
  };
}

/**
 * Parses one server frame. Never throws: a frame this build does not know about
 * becomes `unknown` so the film keeps running across a protocol addition.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = asString(record.type);
  switch (type) {
    case 'session_info':
      return { type: 'session_info', info: parseSessionInfo(record) };
    case 'configured':
      return {
        type: 'configured',
        promptVersion: asNumber(record.prompt_version) ?? 1,
        resolution: asString(record.resolution),
        aspectRatio: asString(record.aspect_ratio),
        memory: asNumber(record.memory),
        audioBitrate: asNumber(record.audio_bitrate),
        acceleration: asString(record.acceleration),
        chunkDuration: asNumber(record.chunk_duration),
        safetyChecker: record.enable_safety_checker === true,
        hasInitialImage: asBool(record.has_initial_image),
        hasInitialAudio: asBool(record.has_initial_audio),
      };
    case 'chunk':
      return {
        type: 'chunk',
        chunk: {
          chunkIndex: asNumber(record.chunk_index) ?? 0,
          promptVersion: asNumber(record.prompt_version) ?? 1,
          requestedDurationSeconds: asNumber(record.requested_duration_seconds) ?? DIRECTOR_LIMITS.defaultChunkSeconds,
          playbackSeconds: asNumber(record.playback_seconds) ?? 0,
          bufferDepthSeconds: asNumber(record.buffer_depth_seconds) ?? 0,
          bufferDepthChunks: asNumber(record.buffer_depth_chunks) ?? 0,
          nextGenerationEstimateSeconds: asNumber(record.next_generation_estimate_seconds) ?? 0,
          generationSeconds: asNumber(record.generation_seconds) ?? 0,
          route: asString(record.route) ?? 'unknown',
          trimmedContextFrames: asNumber(record.trimmed_context_frames) ?? 0,
          scriptOffsetSeconds: asNumber(record.script_offset_seconds),
          scriptVersion: asNumber(record.script_version),
        },
      };
    case 'prompt_pending':
      return { type: 'prompt_pending', promptVersion: asNumber(record.prompt_version) ?? 0 };
    case 'prompt_applied':
      return {
        type: 'prompt_applied',
        promptVersion: asNumber(record.prompt_version) ?? 0,
        scriptQueued: asNumber(record.script_queued),
        scriptMode: asString(record.script_mode),
      };
    case 'prompt_rejected': {
      const reason = asString(record.reason) ?? 'preparation_failed';
      return {
        type: 'prompt_rejected',
        promptVersion: asNumber(record.prompt_version) ?? 0,
        reason: REASONS_REJECTED.has(reason) ? reason : reason,
        error: asString(record.error),
      };
    }
    case 'audio_pending':
      return { type: 'audio_pending', promptVersion: asNumber(record.prompt_version) ?? 0, behavior: asString(record.behavior) };
    case 'audio_applied':
      return {
        type: 'audio_applied',
        promptVersion: asNumber(record.prompt_version) ?? 0,
        behavior: asString(record.behavior),
        durationSeconds: asNumber(record.duration_seconds) ?? 0,
        remainingSeconds: asNumber(record.remaining_seconds) ?? 0,
      };
    case 'audio_rejected':
      return {
        type: 'audio_rejected',
        promptVersion: asNumber(record.prompt_version) ?? 0,
        reason: asString(record.reason) ?? 'invalid_audio',
        error: asString(record.error) ?? '',
      };
    case 'audio_exhausted':
      return {
        type: 'audio_exhausted',
        chunkIndex: asNumber(record.chunk_index) ?? 0,
        silentSeconds: asNumber(record.silent_seconds) ?? 0,
      };
    case 'deadline_missed':
      return {
        type: 'deadline_missed',
        chunkIndex: asNumber(record.chunk_index) ?? 0,
        lateBySeconds: asNumber(record.late_by_seconds) ?? 0,
        behavior: asString(record.behavior) ?? 'freeze_video_and_silence_audio_until_ready',
      };
    case 'stream_exhausted':
      return {
        type: 'stream_exhausted',
        reason: asString(record.reason) ?? 'stopped',
        chunks: asNumber(record.chunks) ?? 0,
      };
    case 'session_metrics':
      return {
        type: 'session_metrics',
        final: record.final === true,
        sessionWallMs: asNumber(record.session_wall_ms),
        historySize: asNumber(record.history_size),
      };
    case 'pong':
      return { type: 'pong', clientTs: asNumber(record.client_ts) };
    case 'error': {
      const code = asString(record.code) ?? 'invalid_input';
      return {
        type: 'error',
        code,
        message: asString(record.error) ?? 'unknown error',
        promptVersion: asNumber(record.prompt_version),
      };
    }
    default:
      return { type: 'unknown', raw: record };
  }
}

/**
 * Strictly increasing prompt versions. The server rejects a repeat or a
 * decrease with `stale_prompt_version`, so the counter is the session's job,
 * not the caller's.
 */
export class PromptVersions {
  private value: number;

  constructor(start = 1) {
    this.value = start;
  }

  get current(): number {
    return this.value;
  }

  next(): number {
    this.value += 1;
    return this.value;
  }
}
