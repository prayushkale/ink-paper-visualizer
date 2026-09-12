import { describe, it, expect } from 'vitest';
import {
  SECTION_IDS,
  createSectionStore,
  defaultSections,
  isSectionId,
  loadSections,
  saveSections,
} from './sections';

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

describe('section layout', () => {
  it('starts every section closed', () => {
    const state = defaultSections();
    expect(Object.values(state)).toEqual(SECTION_IDS.map(() => false));
    expect(Object.values(loadSections(null))).toEqual(SECTION_IDS.map(() => false));
  });

  it('round-trips what the user opened', () => {
    const storage = fakeStorage();
    saveSections({ ...defaultSections(), camera: true }, storage);
    const loaded = loadSections(storage);
    expect(loaded.camera).toBe(true);
    expect(loaded.stream).toBe(false);
  });

  it('keeps a stored layout when nothing is written in between', () => {
    const storage = fakeStorage();
    saveSections({ ...defaultSections(), budget: true, mood: true }, storage);
    // a fresh page load reads the same storage again
    expect(loadSections(storage)).toEqual(loadSections(storage));
    expect(loadSections(storage).budget).toBe(true);
  });

  it('ignores junk, unknown ids and non-boolean values', () => {
    const storage = fakeStorage({
      'inkfilm.sections.v1': JSON.stringify({ stream: 'yes', camera: 1, nonsense: true, mood: true }),
    });
    const loaded = loadSections(storage);
    expect(loaded.mood).toBe(true);
    expect(loaded.stream).toBe(false);
    expect(loaded.camera).toBe(false);
    expect('nonsense' in loaded).toBe(false);
  });

  it('falls back to closed when the payload is corrupt', () => {
    expect(loadSections(fakeStorage({ 'inkfilm.sections.v1': '{not json' }))).toEqual(defaultSections());
    expect(loadSections(fakeStorage({ 'inkfilm.sections.v1': 'null' }))).toEqual(defaultSections());
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
    expect(() => loadSections(hostile)).not.toThrow();
    expect(() => saveSections({ ...defaultSections(), music: true }, hostile)).not.toThrow();
  });

  it('only accepts ids it renders', () => {
    expect(isSectionId('stream')).toBe(true);
    expect(isSectionId('nonsense')).toBe(false);
    expect(isSectionId(undefined)).toBe(false);
  });

  it('writes through on toggle, and never writes a value that is already there', () => {
    const storage = fakeStorage();
    const store = createSectionStore(storage);
    expect(store.state().camera).toBe(false);
    store.set('camera', true);
    expect(store.state().camera).toBe(true);
    expect(JSON.parse(storage.getItem('inkfilm.sections.v1')!).camera).toBe(true);

    let writes = 0;
    const counted = {
      getItem: (key: string) => storage.getItem(key),
      setItem: (key: string, value: string) => {
        writes += 1;
        storage.setItem(key, value);
      },
    } as unknown as Storage;
    const counting = createSectionStore(counted);
    counting.set('mood', false);
    counting.set('mood', false);
    expect(writes).toBe(0);
  });

  it('keeps the layout of a later visit', () => {
    const storage = fakeStorage();
    createSectionStore(storage).set('vision', true);
    // a new page: a new store over the same storage
    expect(createSectionStore(storage).state().vision).toBe(true);
  });
});
