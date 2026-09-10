import type { MusicConfig } from '../state';
import type { MusicPreset } from '../presets/music';

/** Where a pinned soundtrack comes from, in priority order. */
export type MusicSourceKind = 'none' | 'custom-url' | 'bundled' | 'file';

export interface MusicSource {
  kind: MusicSourceKind;
  /** Remote URL or bundled path, when the source is addressable. */
  url?: string;
  /** A user-dropped file, when there is no URL. */
  file?: Blob;
  label: string;
}

/** Picks the track to pin: an explicit URL wins over a bundled path. */
export function musicSourceFor(config: MusicConfig, preset: MusicPreset): MusicSource {
  const custom = config.customUrl?.trim();
  if (custom) return { kind: 'custom-url', url: custom, label: preset.label };
  return { kind: 'bundled', url: preset.localPath, label: preset.label };
}

/** A user-dropped file always wins over anything configured. */
export function musicSourceForFile(file: Blob, preset: MusicPreset, name?: string): MusicSource {
  return { kind: 'file', file, label: name ? `${preset.label} (${name})` : preset.label };
}

export function shouldPin(config: MusicConfig): boolean {
  return config.mode === 'pinned';
}

/** The sentence used when the score is left to the model instead of pinned. */
export function generatedScoreBrief(preset: MusicPreset, energy: number): string {
  const intensity = energy >= 0.75
    ? 'keep it driving and forward-leaning'
    : energy <= 0.3
      ? 'keep it sparse and unhurried'
      : 'keep it present without dominating';
  return `${preset.label} at about ${preset.bpm} BPM: ${preset.brief}. ${intensity}.`;
}

export class TrackTooLongError extends Error {
  constructor(seconds: number, limit: number) {
    super(`that track is ${Math.round(seconds)}s; the model accepts at most ${limit}s of source audio`);
    this.name = 'TrackTooLongError';
  }
}

export class MusicBedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicBedError';
  }
}

export interface PinnedTrack {
  url: string;
  /** Reported by the browser; null when it could not be determined. */
  durationSeconds: number | null;
  bytes: number;
  source: MusicSource;
}

export interface MusicBedPorts {
  /** Reads a URL into memory so it can be hosted on fal. */
  fetchTrack(url: string): Promise<Blob>;
  upload(blob: Blob, name: string): Promise<string>;
  probeDurationSeconds(blob: Blob): Promise<number | null>;
}

export interface MusicBedOptions {
  /** `max_audio_source_seconds` from the session's own capabilities. */
  maxSourceSeconds?: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Turns a chosen genre into a URL the Director session can condition on.
 *
 * The model fetches `audio_url` itself, so a track the user dropped into the
 * browser has to be hosted first - uploading it once per session is the cost of
 * pinning. Resolved tracks are cached by identity so chaining a new session
 * does not re-upload the same recording.
 */
export class MusicBed {
  private cache: PinnedTrack | null = null;
  private cacheKey: string | null = null;
  private inFlight: Promise<PinnedTrack | null> | null = null;

  constructor(
    private readonly ports: MusicBedPorts,
    private readonly options: MusicBedOptions = {},
  ) {}

  get resolved(): PinnedTrack | null {
    return this.cache;
  }

  /** true when the configured track is already hosted and reusable. */
  isResolvedFor(config: MusicConfig, preset: MusicPreset, file?: Blob | null): boolean {
    const key = this.keyFor(musicSourceFor(config, preset), file);
    return this.cache !== null && this.cacheKey === key;
  }

  clear(): void {
    this.cache = null;
    this.cacheKey = null;
    this.inFlight = null;
  }

  /**
   * Resolves the pinned track, or null when the score should be generated.
   * Throws MusicBedError when pinning was asked for but there is nothing to pin.
   */
  async resolve(config: MusicConfig, preset: MusicPreset, file?: Blob | null): Promise<PinnedTrack | null> {
    if (!shouldPin(config)) {
      this.clear();
      return null;
    }
    const source = file ? musicSourceForFile(file, preset) : musicSourceFor(config, preset);
    const key = this.keyFor(source, file);
    if (this.cache && this.cacheKey === key) return this.cache;
    if (this.inFlight && this.cacheKey === key) return this.inFlight;

    this.cacheKey = key;
    const work = this.host(source, preset);
    this.inFlight = work;
    try {
      const track = await work;
      this.cache = track;
      return track;
    } catch (error) {
      // a failed resolve must not be remembered as if it had succeeded
      this.cache = null;
      this.cacheKey = null;
      throw error;
    } finally {
      if (this.inFlight === work) this.inFlight = null;
    }
  }

  private keyFor(source: MusicSource, file?: Blob | null): string {
    if (file) return `file:${file.size}:${file.type}`;
    return `${source.kind}:${source.url ?? ''}`;
  }

  private async host(source: MusicSource, preset: MusicPreset): Promise<PinnedTrack> {
    let blob: Blob;
    if (source.kind === 'file' && source.file) {
      blob = source.file;
    } else if (source.url) {
      blob = await this.ports.fetchTrack(source.url);
    } else {
      throw new MusicBedError('no track to pin: choose a genre with a bundled file, drop an audio file, or switch to the generated score');
    }
    if (blob.size === 0) throw new MusicBedError('that track is empty');
    if (!isAudio(blob)) throw new MusicBedError(unusableTrackMessage(source, blob.type));

    const durationSeconds = await this.ports.probeDurationSeconds(blob);
    const limit = this.options.maxSourceSeconds ?? 600;
    if (durationSeconds !== null && durationSeconds > limit) {
      throw new TrackTooLongError(durationSeconds, limit);
    }

    const extension = extensionFor(blob.type);
    const url = await this.ports.upload(blob, `${preset.id}-music-bed.${extension}`);
    return { url, durationSeconds, bytes: blob.size, source };
  }
}

/**
 * True when a blob is plausibly audio.
 *
 * An untyped blob is allowed through (the browser could not tell, and the
 * extension is all we have), but anything the browser positively typed as
 * something else is refused: fal storage rejects `text/html` outright, and the
 * failure that produces is unreadable from here.
 */
function isAudio(blob: Blob): boolean {
  const type = (blob.type || '').split(';')[0]!.trim().toLowerCase();
  if (type === '') return true;
  return type.startsWith('audio/') || type === 'application/octet-stream' || type === 'binary/octet-stream';
}

/**
 * The dev server answers a request for a bundled track that does not exist with
 * the app's index.html, so an empty `assets/music/` used to reach fal as an
 * HTML upload. Name the real problem instead.
 */
function unusableTrackMessage(source: MusicSource, type: string): string {
  const served = type.trim() === '' ? 'a file the browser could not identify' : type;
  if (source.kind === 'bundled') {
    return `no bundled track at ${source.url} - the server served ${served} instead. Drop one of the files listed in assets/music/README.md, paste a track URL, or switch the score to generated.`;
  }
  return `that track came back as ${served}, not audio`;
}

function extensionFor(contentType: string): string {
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('ogg')) return 'ogg';
  if (contentType.includes('flac')) return 'flac';
  if (contentType.includes('aac') || contentType.includes('m4a')) return 'm4a';
  return 'mp3';
}

/** Browser-side ports: fetch over the app origin, upload through the proxy. */
export function createMusicBedPorts(): MusicBedPorts {
  return {
    async fetchTrack(url: string): Promise<Blob> {
      const response = await fetch(url);
      if (!response.ok) throw new MusicBedError(`could not load the track (${response.status})`);
      return response.blob();
    },
    async upload(blob: Blob, name: string): Promise<string> {
      const { uploadFile } = await import('../fal');
      return uploadFile(blob, name);
    },
    async probeDurationSeconds(blob: Blob): Promise<number | null> {
      if (typeof document === 'undefined') return null;
      const url = URL.createObjectURL(blob);
      try {
        return await new Promise<number | null>((resolve) => {
          const audio = document.createElement('audio');
          audio.preload = 'metadata';
          const done = (value: number | null): void => resolve(value);
          audio.addEventListener('loadedmetadata', () => {
            done(Number.isFinite(audio.duration) ? audio.duration : null);
          }, { once: true });
          audio.addEventListener('error', () => done(null), { once: true });
          setTimeout(() => done(null), 5000);
          audio.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}
