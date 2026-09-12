import { describe, it, expect } from 'vitest';
import { createPrefsStore, defaultPrefs, loadPrefs, savePrefs } from './prefs';
import { systemTheme } from './theme';

/** A localStorage stand-in: the module only ever get/setItems. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const data = { ...seed };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  } as unknown as Storage;
}

const KEY = 'inkfilm.prefs.v1';

describe('page preferences', () => {
  it('starts on the studio, unmuted, with an unpicked brush', () => {
    const prefs = defaultPrefs();
    expect(prefs.mode).toBe('studio');
    expect(prefs.muted).toBe(false);
    expect(prefs.watch).toBe(false);
    expect(prefs.brush.color).toBe('');
    expect(prefs.brush.radius).toBe(40);
    expect(loadPrefs(null)).toEqual(prefs);
  });

  it('round-trips every choice', () => {
    const storage = fakeStorage();
    savePrefs(
      { mode: 'manual', brush: { color: '#8c2f1f', radius: 88, wetness: 0.2 }, muted: true, watch: true, theme: 'light' },
      storage,
    );
    const loaded = loadPrefs(storage);
    expect(loaded).toEqual({ mode: 'manual', brush: { color: '#8c2f1f', radius: 88, wetness: 0.2 }, muted: true, watch: true, theme: 'light' });
  });

  it('ignores junk, unknown keys and wrong types', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({ mode: 'theatre', muted: 'yes', watch: 1, theme: 'dusk', brush: { color: 'red', radius: 'big' }, nonsense: true }),
    });
    const loaded = loadPrefs(storage);
    expect(loaded.mode).toBe('studio');
    expect(loaded.muted).toBe(false);
    expect(loaded.watch).toBe(false);
    expect(loaded.brush.color).toBe('');
    expect(loaded.brush.radius).toBe(40);
    expect('nonsense' in loaded).toBe(false);
  });

  it('opens on the system theme until the user picks one', () => {
    expect(defaultPrefs().theme).toBe(systemTheme());
    expect(defaultPrefs('light').theme).toBe('light');
    const storage = fakeStorage({ [KEY]: JSON.stringify({ theme: 'light' }) });
    expect(loadPrefs(storage).theme).toBe('light');
    // anything that is not a theme leaves the default in place
    expect(loadPrefs(fakeStorage({ [KEY]: JSON.stringify({ theme: 1 }) })).theme).toBe(systemTheme());
  });

  it('clamps a hand-edited brush into the sliders that show it', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({ brush: { color: '#7a5b3a', radius: 9999, wetness: -4 } }),
    });
    const loaded = loadPrefs(storage);
    expect(loaded.brush.radius).toBe(120);
    expect(loaded.brush.wetness).toBe(0);
  });

  it('falls back to the defaults on a corrupt payload', () => {
    expect(loadPrefs(fakeStorage({ [KEY]: '{not json' }))).toEqual(defaultPrefs());
    expect(loadPrefs(fakeStorage({ [KEY]: 'null' }))).toEqual(defaultPrefs());
    expect(loadPrefs(fakeStorage({ [KEY]: '"a string"' }))).toEqual(defaultPrefs());
  });

  it('survives storage that throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    expect(() => loadPrefs(hostile)).not.toThrow();
    expect(() => savePrefs({ ...defaultPrefs(), muted: true }, hostile)).not.toThrow();
  });

  it('writes a change through and remembers it on the next page', () => {
    const storage = fakeStorage();
    const store = createPrefsStore(storage);
    store.set('muted', true);
    expect(store.state().muted).toBe(true);
    expect(JSON.parse(storage.getItem(KEY)!).muted).toBe(true);
    // a reload: a new store over the same storage
    expect(createPrefsStore(storage).state().muted).toBe(true);
  });

  it('never writes a value that is already there, and never writes on load', () => {
    const storage = fakeStorage();
    let writes = 0;
    const counted = {
      getItem: (key: string) => storage.getItem(key),
      setItem: (key: string, value: string) => {
        writes += 1;
        storage.setItem(key, value);
      },
    } as unknown as Storage;
    const store = createPrefsStore(counted);
    expect(writes).toBe(0);
    store.set('watch', false);
    store.set('watch', false);
    store.setBrush({ radius: 40 });
    expect(writes).toBe(0);
    store.setBrush({ radius: 41 });
    expect(writes).toBe(1);
  });

  it('writes the brush as one payload, keeping the keys it did not touch', () => {
    const storage = fakeStorage();
    const store = createPrefsStore(storage);
    store.setBrush({ color: '#1b998b', radius: 60, wetness: 0.8 });
    store.setBrush({ radius: 61 });
    const stored = JSON.parse(storage.getItem(KEY)!);
    expect(stored.brush).toEqual({ color: '#1b998b', radius: 61, wetness: 0.8 });
    expect(stored.mode).toBe('studio');
  });
});
