import { describe, it, expect, beforeEach } from 'vitest';
import {
  MusicBed,
  MusicBedError,
  TrackTooLongError,
  createMusicBedPorts,
  formatBytes,
  generatedScoreBrief,
  musicSourceFor,
  musicSourceForFile,
  shouldPin,
  type MusicBedPorts,
} from './musicBed';
import { MUSIC_PRESETS } from '../presets/music';
import { defaultSettings, type MusicConfig } from '../state';

const preset = MUSIC_PRESETS.trance;

function config(overrides: Partial<MusicConfig> = {}): MusicConfig {
  return { ...defaultSettings().music, musicId: 'trance', mode: 'pinned', ...overrides };
}

function ports(overrides: Partial<MusicBedPorts> = {}) {
  const uploaded: string[] = [];
  const fetched: string[] = [];
  const base: MusicBedPorts = {
    fetchTrack: async (url) => {
      fetched.push(url);
      return new Blob([new Uint8Array(2048)], { type: 'audio/mpeg' });
    },
    upload: async (_blob, name) => {
      uploaded.push(name);
      return `https://fal.media/${name}`;
    },
    probeDurationSeconds: async () => 214,
  };
  return { ports: { ...base, ...overrides }, uploaded, fetched };
}

describe('musicSourceFor', () => {
  it('prefers an explicit url over the bundled path', () => {
    const source = musicSourceFor(config({ customUrl: 'https://example.com/my-track.mp3' }), preset);
    expect(source).toMatchObject({ kind: 'custom-url', url: 'https://example.com/my-track.mp3' });
  });

  it('falls back to the bundled path for a genre', () => {
    expect(musicSourceFor(config(), preset)).toMatchObject({ kind: 'bundled', url: preset.localPath });
  });

  it('ignores a whitespace-only url', () => {
    expect(musicSourceFor(config({ customUrl: '   ' }), preset).kind).toBe('bundled');
  });

  it('lets a dropped file win', () => {
    const file = new Blob(['audio'], { type: 'audio/wav' });
    expect(musicSourceForFile(file, preset, 'mine.wav')).toMatchObject({ kind: 'file', file });
    expect(musicSourceForFile(file, preset, 'mine.wav').label).toContain('mine.wav');
  });
});

describe('shouldPin', () => {
  it('is true only in pinned mode', () => {
    expect(shouldPin(config({ mode: 'pinned' }))).toBe(true);
    expect(shouldPin(config({ mode: 'generated' }))).toBe(false);
  });
});

describe('generatedScoreBrief', () => {
  it('names the genre, tempo and instrumentation', () => {
    const brief = generatedScoreBrief(preset, 0.5);
    expect(brief).toContain(preset.label);
    expect(brief).toContain(String(preset.bpm));
    expect(brief).toContain(preset.brief);
  });
  it('adapts to the mood energy', () => {
    expect(generatedScoreBrief(preset, 0.9)).toMatch(/driving/);
    expect(generatedScoreBrief(preset, 0.1)).toMatch(/sparse/);
    expect(generatedScoreBrief(preset, 0.5)).toMatch(/without dominating/);
  });
});

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('MusicBed', () => {
  let p: ReturnType<typeof ports>;
  let bed: MusicBed;

  beforeEach(() => {
    p = ports();
    bed = new MusicBed(p.ports, { maxSourceSeconds: 600 });
  });

  it('returns null for the generated score and clears any pinned track', async () => {
    expect(await bed.resolve(config({ mode: 'generated' }), preset)).toBeNull();
    expect(bed.resolved).toBeNull();
  });

  it('hosts a bundled track and reports what it pinned', async () => {
    const track = await bed.resolve(config(), preset);
    expect(track).toMatchObject({ url: `https://fal.media/${preset.id}-music-bed.mp3`, durationSeconds: 214 });
    expect(p.fetched).toEqual([preset.localPath]);
    expect(p.uploaded).toHaveLength(1);
    expect(bed.resolved).toEqual(track);
  });

  it('caches by track identity so chaining a session does not re-upload', async () => {
    await bed.resolve(config(), preset);
    await bed.resolve(config(), preset);
    expect(p.fetched).toHaveLength(1);
    expect(p.uploaded).toHaveLength(1);
    expect(bed.isResolvedFor(config(), preset)).toBe(true);
  });

  it('re-hosts when the genre changes', async () => {
    await bed.resolve(config(), preset);
    const classical = MUSIC_PRESETS.classical;
    const next = await bed.resolve({ ...config(), musicId: 'classical' }, classical);
    expect(p.uploaded).toHaveLength(2);
    expect(next!.url).toContain('classical');
  });

  it('re-hosts when the custom url changes', async () => {
    await bed.resolve(config({ customUrl: 'https://example.com/a.mp3' }), preset);
    await bed.resolve(config({ customUrl: 'https://example.com/b.mp3' }), preset);
    expect(p.uploaded).toHaveLength(2);
    expect(p.fetched).toEqual(['https://example.com/a.mp3', 'https://example.com/b.mp3']);
  });

  it('uploads a dropped file instead of fetching anything', async () => {
    const file = new Blob([new Uint8Array(4096)], { type: 'audio/wav' });
    const track = await bed.resolve(config(), preset, file);
    expect(p.fetched).toHaveLength(0);
    expect(track!.url).toBe(`https://fal.media/${preset.id}-music-bed.wav`);
    expect(track!.bytes).toBe(4096);
  });

  it('shares one upload between concurrent resolves of the same track', async () => {
    const [a, b] = await Promise.all([bed.resolve(config(), preset), bed.resolve(config(), preset)]);
    expect(a).toEqual(b);
    expect(p.uploaded).toHaveLength(1);
  });

  it('refuses a track longer than the model accepts', async () => {
    const long = ports({ probeDurationSeconds: async () => 1200 });
    const strict = new MusicBed(long.ports, { maxSourceSeconds: 600 });
    await expect(strict.resolve(config(), preset)).rejects.toBeInstanceOf(TrackTooLongError);
    expect(long.uploaded).toHaveLength(0);
    expect(strict.resolved).toBeNull();
  });

  it('accepts a track whose duration cannot be determined', async () => {
    const unknown = ports({ probeDurationSeconds: async () => null });
    const relaxed = new MusicBed(unknown.ports, { maxSourceSeconds: 600 });
    const track = await relaxed.resolve(config(), preset);
    expect(track!.durationSeconds).toBeNull();
    expect(unknown.uploaded).toHaveLength(1);
  });

  it('rejects an empty track', async () => {
    const empty = ports({ fetchTrack: async () => new Blob([], { type: 'audio/mpeg' }) });
    const bed2 = new MusicBed(empty.ports);
    await expect(bed2.resolve(config(), preset)).rejects.toBeInstanceOf(MusicBedError);
    expect(empty.uploaded).toHaveLength(0);
  });

  it('refuses an HTML body the dev server served for a missing bundled track', async () => {
    // `/assets/music/trance.mp3` with nothing in the folder answers with the
    // app's index.html, and fal storage rejects `text/html` with a 500 that the
    // client can only render as "Internal Server Error".
    const missing = ports({
      fetchTrack: async () => new Blob(['<!doctype html><html></html>'], { type: 'text/html' }),
    });
    const bed2 = new MusicBed(missing.ports);
    await expect(bed2.resolve(config(), preset)).rejects.toThrow(/no bundled track at \/assets\/music\/trance\.mp3/);
    await expect(bed2.resolve(config(), preset)).rejects.toThrow(/switch the score to generated/);
    expect(missing.uploaded).toHaveLength(0);
    expect(bed2.resolved).toBeNull();
  });

  it('refuses a custom url that answers with something other than audio', async () => {
    const notAudio = ports({ fetchTrack: async () => new Blob(['<html>'], { type: 'text/html' }) });
    const bed2 = new MusicBed(notAudio.ports);
    await expect(bed2.resolve(config({ customUrl: 'https://example.com/track.mp3' }), preset))
      .rejects.toThrow(/came back as text\/html, not audio/);
    expect(notAudio.uploaded).toHaveLength(0);
  });

  it('still accepts a track the browser could only type as octet-stream', async () => {
    const generic = ports({ fetchTrack: async () => new Blob([new Uint8Array(512)], { type: 'application/octet-stream' }) });
    const bed2 = new MusicBed(generic.ports);
    const track = await bed2.resolve(config(), preset);
    expect(track!.url).toContain('trance-music-bed');
    expect(generic.uploaded).toHaveLength(1);
  });

  it('surfaces a fetch failure without caching it', async () => {
    const failing = ports({ fetchTrack: async () => { throw new MusicBedError('could not load the track (404)'); } });
    const bed2 = new MusicBed(failing.ports);
    await expect(bed2.resolve(config(), preset)).rejects.toThrow(/404/);
    expect(bed2.resolved).toBeNull();
    await expect(bed2.resolve(config(), preset)).rejects.toThrow(/404/);
  });

  it('retries the upload after a failure rather than remembering the failure', async () => {
    let attempts = 0;
    const flaky = ports({
      upload: async (_blob, name) => {
        attempts++;
        if (attempts === 1) throw new Error('storage down');
        return `https://fal.media/${name}`;
      },
    });
    const bed2 = new MusicBed(flaky.ports);
    await expect(bed2.resolve(config(), preset)).rejects.toThrow(/storage down/);
    const track = await bed2.resolve(config(), preset);
    expect(track?.url).toContain('trance-music-bed');
    expect(attempts).toBe(2);
  });

  it('picks the file extension from the content type', async () => {
    for (const [type, extension] of [['audio/wav', 'wav'], ['audio/ogg', 'ogg'], ['audio/flac', 'flac'], ['audio/mp4', 'mp3']] as const) {
      const typed = ports({ fetchTrack: async () => new Blob([new Uint8Array(16)], { type }) });
      const bed2 = new MusicBed(typed.ports);
      const track = await bed2.resolve(config(), preset);
      expect(track!.url.endsWith(`.${extension}`)).toBe(true);
    }
  });

  it('switching to the generated score drops the pinned track', async () => {
    await bed.resolve(config(), preset);
    expect(bed.resolved).not.toBeNull();
    await bed.resolve(config({ mode: 'generated' }), preset);
    expect(bed.resolved).toBeNull();
  });

  it('clear() forgets the cached track', async () => {
    await bed.resolve(config(), preset);
    bed.clear();
    expect(bed.resolved).toBeNull();
    await bed.resolve(config(), preset);
    expect(p.uploaded).toHaveLength(2);
  });
});

describe('createMusicBedPorts', () => {
  it('returns the three ports the bed needs', () => {
    const created = createMusicBedPorts();
    expect(typeof created.fetchTrack).toBe('function');
    expect(typeof created.upload).toBe('function');
    expect(typeof created.probeDurationSeconds).toBe('function');
  });

  it('reports no duration outside a browser', async () => {
    await expect(createMusicBedPorts().probeDurationSeconds(new Blob(['x']))).resolves.toBeNull();
  });
});
