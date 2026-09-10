import { clampPrompt } from '../stream/promptComposer';

export interface BlotReading {
  /** A few words naming what the model sees. */
  subject: string;
  /** The beat: what is happening now and what it becomes. */
  prompt: string;
  /** How the previous picture becomes this one. */
  transition: string;
  moodTags: string[];
  sound: string;
  /** True when the model returned usable structure rather than prose. */
  structured: boolean;
}

const MAX_SUBJECT = 120;
const MAX_PROMPT = 1200;
const MAX_TRANSITION = 160;
const MAX_SOUND = 300;
const MAX_TAGS = 6;

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(', ').trim();
  return '';
}

function asTags(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;]/)
      : [];
  const tags = source
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.toLowerCase().replace(/^#/, '').trim())
    .filter((tag) => tag.length > 0 && tag.length <= 40);
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

function trimTo(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** Pulls the first balanced JSON object out of a model reply. */
export function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter((value): value is string => typeof value === 'string');
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const char = candidate[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break; // malformed: try the next candidate
          }
        }
      }
    }
  }
  return null;
}

/**
 * Reads a vision reply into a BlotReading. Models are unreliable, so a reply
 * that is pure prose still becomes a usable beat rather than an error.
 */
export function parseReading(raw: string): BlotReading {
  const text = String(raw ?? '').trim();
  const parsed = extractJsonObject(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const prompt = asString(record.prompt ?? record.beat ?? record.description ?? record.idea);
    const subject = asString(record.subject ?? record.title ?? record.name);
    if (prompt !== '' || subject !== '') {
      return {
        subject: trimTo(subject || prompt.split(/[.,;]/)[0] || 'an unreadable shape', MAX_SUBJECT),
        prompt: trimTo(clampPrompt(prompt || subject), MAX_PROMPT),
        transition: trimTo(asString(record.transition ?? record.arrival), MAX_TRANSITION),
        moodTags: asTags(record.moodTags ?? record.mood_tags ?? record.tags ?? record.mood),
        sound: trimTo(asString(record.sound ?? record.audio), MAX_SOUND),
        structured: true,
      };
    }
  }
  // Prose fallback: treat the whole reply as the beat.
  const prose = text.replace(/^```[\s\S]*?```$/g, '').trim();
  if (prose === '') return fallbackReading(hashText(text));
  return {
    subject: trimTo(prose.split(/[.\n]/)[0] || 'an unreadable shape', MAX_SUBJECT),
    prompt: trimTo(clampPrompt(prose), MAX_PROMPT),
    transition: '',
    moodTags: [],
    sound: '',
    structured: false,
  };
}

/** Small stable hash so an empty reply still gets a deterministic fallback. */
function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Used when the model fails entirely: the film keeps moving, unillustrated. */
export function fallbackReading(seed: number): BlotReading {
  const subjects = ['a slow bloom', 'a lifted edge', 'a settling mass', 'a widening stain', 'a drawn-out thread'];
  const subject = subjects[Math.abs(seed) % subjects.length]!;
  return {
    subject,
    prompt: `${subject} continues to spread and reorganise, the pigment finding new figures as it moves, never settling into anything it can be named as.`,
    transition: 'the picture keeps breathing',
    moodTags: [],
    sound: '',
    structured: false,
  };
}
