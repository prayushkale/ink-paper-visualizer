/**
 * Which sections of the settings column are open.
 *
 * The column is rebuilt from scratch every time settings change, so the layout
 * cannot live in the DOM: it is stored, and "I left that section closed" then
 * survives a reload, a new tab, and the next day.
 */

export const SECTION_IDS = ['stream', 'mood', 'music', 'camera', 'budget', 'vision'] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export type SectionState = Record<SectionId, boolean>;

const LS_KEY = 'inkfilm.sections.v1';

/** Every section starts closed, so the column opens as a short list of headings. */
export function defaultSections(): SectionState {
  const state = {} as SectionState;
  for (const id of SECTION_IDS) state[id] = false;
  return state;
}

/** True only for a section id we render, so a stray dataset value is ignored. */
export function isSectionId(value: string | undefined): value is SectionId {
  return value !== undefined && (SECTION_IDS as readonly string[]).includes(value);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads the stored layout, keeping only ids we know and values that are booleans. */
export function loadSections(storage: Pick<Storage, 'getItem'> | null = safeStorage()): SectionState {
  const state = defaultSections();
  if (!storage) return state;
  try {
    const raw = storage.getItem(LS_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return state;
    const record = parsed as Record<string, unknown>;
    for (const id of SECTION_IDS) {
      const value = record[id];
      if (typeof value === 'boolean') state[id] = value;
    }
  } catch {
    /* corrupt payload, absent storage, private mode: the defaults are the answer */
  }
  return state;
}

export function saveSections(
  state: SectionState,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode: the layout simply does not persist */
  }
}

/** A one-shot store for the running page: read once, write through on every toggle. */
export function createSectionStore(storage: Storage | null = safeStorage()): {
  state(): SectionState;
  set(id: SectionId, open: boolean): void;
} {
  let current = loadSections(storage);
  return {
    state: () => current,
    set(id: SectionId, open: boolean): void {
      if (current[id] === open) return;
      current = { ...current, [id]: open };
      saveSections(current, storage);
    },
  };
}
