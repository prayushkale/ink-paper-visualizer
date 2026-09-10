import { describe, it, expect } from 'vitest';
import {
  clampPrompt,
  composeDirection,
  composeMoodShift,
  composeVisionPrompt,
  composeWorldPrompt,
  MAX_PROMPT_CHARS,
  paletteSentence,
  softenDirection,
} from './promptComposer';
import { CAMERA_MOVES } from '../presets/camera';
import { MOODS } from '../presets/moods';
import { MUSIC_PRESETS } from '../presets/music';
import type { BlotReading } from '../rail/reading';

const mood = MOODS.cosmic;
const music = MUSIC_PRESETS.classical;
const palette = mood.palette;

const reading = (overrides: Partial<BlotReading> = {}): BlotReading => ({
  subject: 'a drifting filament',
  prompt: 'The filament unspools across the dark and begins to braid itself into a spiral.',
  transition: 'the drift gathers',
  moodTags: ['cosmic'],
  sound: 'a deep drone and one metallic ping',
  structured: true,
  ...overrides,
});

describe('composeWorldPrompt', () => {
  const world = composeWorldPrompt({ mood, music, palette, moodStrength: 0.7, musicPinned: false });

  it('states the film is one continuous unbroken take', () => {
    expect(world).toMatch(/single continuous, unbroken film/);
    expect(world).toMatch(/no cuts to black, no titles/);
  });

  it('carries the mood art direction and the palette', () => {
    expect(world).toContain(mood.lead);
    expect(world).toContain(mood.palette.join(', '));
  });

  it('uses the word preserve, which is what later directions refer back to', () => {
    expect(world).toMatch(/PRESERVE/);
    expect(world).toMatch(/[Pp]reserve/);
  });

  it('offers a repeatable source of new situations', () => {
    expect(world).toMatch(/new ink blot every few seconds/);
    expect(world).toMatch(/exact destination/);
  });

  it('opens mid-motion rather than summarising', () => {
    expect(world).toMatch(/OPENING: begin mid-motion/);
  });

  it('describes a pinned score as a condition, not a suggestion', () => {
    const pinned = composeWorldPrompt({ mood, music, palette, moodStrength: 0.7, musicPinned: true });
    expect(pinned).toMatch(/pinned to this film/);
    expect(pinned).toMatch(/No voice-over/);
    expect(world).not.toMatch(/pinned to this film/);
  });

  it('still names the sound when the score is generated', () => {
    expect(world).toContain(music.brief);
  });

  it('tightens as the mood strength rises', () => {
    const loose = composeWorldPrompt({ mood, music, palette, moodStrength: 0.1, musicPinned: false });
    const tight = composeWorldPrompt({ mood, music, palette, moodStrength: 0.9, musicPinned: false });
    expect(loose).toMatch(/drift if it wants to/);
    expect(tight).toMatch(/Hold this mood tightly/);
  });
});

describe('composeVisionPrompt', () => {
  it('includes the base prompt and the running context', () => {
    const prompt = composeVisionPrompt({
      basePrompt: 'BASE',
      mood,
      music,
      camera: CAMERA_MOVES['orbit-right'],
      previousPrompts: ['first beat', 'second beat'],
      beatIndex: 2,
      moodStrength: 0.5,
    });
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('RUNNING CONTEXT');
    expect(prompt).toContain('beat 1: first beat');
    expect(prompt).toContain('beat 2: second beat');
    expect(prompt).toContain('This is beat 3');
  });

  it('names the camera move and asks the words to agree with it', () => {
    const prompt = composeVisionPrompt({
      basePrompt: 'BASE', mood, music, camera: CAMERA_MOVES['crane-up'],
      previousPrompts: [], beatIndex: 0, moodStrength: 0.5,
    });
    expect(prompt).toContain(CAMERA_MOVES['crane-up'].label);
    expect(prompt).toContain(CAMERA_MOVES['crane-up'].phrase);
  });

  it('says so plainly when this is the opening beat', () => {
    const prompt = composeVisionPrompt({
      basePrompt: 'BASE', mood, music, camera: null,
      previousPrompts: [], beatIndex: 0, moodStrength: 0.5,
    });
    expect(prompt).toMatch(/opening beat/);
    expect(prompt).toMatch(/No camera move is prescribed/);
  });

  it('carries the score and the mood pressure', () => {
    const prompt = composeVisionPrompt({
      basePrompt: 'BASE', mood, music, camera: null,
      previousPrompts: [], beatIndex: 0, moodStrength: 0.42,
    });
    expect(prompt).toContain(music.bpm.toString());
    expect(prompt).toContain('0.42');
  });
});

describe('composeDirection', () => {
  const direction = composeDirection({
    reading: reading(),
    mood,
    music,
    camera: CAMERA_MOVES['orbit-right'],
    moodStrength: 0.8,
    arrivalMode: 'hard',
  });

  it('leads with the transition, then the beat', () => {
    expect(direction).toMatch(/^The drift gathers\./);
    expect(direction).toContain('unspools across the dark');
  });

  it('repeats the preserve instruction so continuity survives every beat', () => {
    expect(direction).toMatch(/Preserve the paper-and-pigment surface/);
  });

  it('carries the camera move so picture and words agree', () => {
    const phrase = CAMERA_MOVES['orbit-right'].phrase;
    expect(direction.toLowerCase()).toContain(phrase.toLowerCase());
  });

  it('pins the closing frame only when the arrival is hard', () => {
    expect(direction).toMatch(/closing frame of this beat is fixed/);
    const soft = composeDirection({
      reading: reading(), mood, music, camera: null, moodStrength: 0.8, arrivalMode: 'soft',
    });
    expect(soft).not.toMatch(/closing frame of this beat is fixed/);
    expect(soft).not.toMatch(/resolve exactly into the incoming image/);
  });

  it('uses the reading sound when there is one, and the score accent otherwise', () => {
    expect(direction).toContain('a deep drone and one metallic ping');
    const silent = composeDirection({
      reading: reading({ sound: '' }), mood, music, camera: null, moodStrength: 0.8, arrivalMode: 'soft',
    });
    expect(silent).toContain(music.accent);
  });

  it('copes with a reading that has no prompt at all', () => {
    const thin = composeDirection({
      reading: reading({ prompt: '', transition: '' }), mood, music, camera: null,
      moodStrength: 0.5, arrivalMode: 'soft',
    });
    expect(thin).toMatch(/drifting filament/);
    expect(thin).toMatch(/emerges from the pigment/);
  });

  it('relaxes the mood instruction as the strength drops', () => {
    const loose = composeDirection({
      reading: reading(), mood, music, camera: null, moodStrength: 0.1, arrivalMode: 'soft',
    });
    const tight = composeDirection({
      reading: reading(), mood, music, camera: null, moodStrength: 0.9, arrivalMode: 'soft',
    });
    expect(loose).toMatch(/wherever it is already going/);
    expect(tight.toLowerCase()).toContain(mood.tail.toLowerCase());
  });

  it('produces a single line that fits comfortably in a prompt field', () => {
    expect(direction).not.toMatch(/\n/);
    expect(direction.length).toBeLessThan(2000);
  });
});

describe('composeMoodShift', () => {
  it('escalates the wording with the strength', () => {
    const from = MOODS.serene;
    const to = MOODS.menacing;
    expect(composeMoodShift({ from, to, strength: 0.9, palette: to.palette })).toMatch(/Change the film's mood completely/);
    expect(composeMoodShift({ from, to, strength: 0.5, palette: to.palette })).toMatch(/Turn the film's mood/);
    expect(composeMoodShift({ from, to, strength: 0.1, palette: to.palette })).toMatch(/a trace of/);
  });

  it('always preserves continuity of the take', () => {
    const shift = composeMoodShift({ from: MOODS.serene, to: MOODS.playful, strength: 0.8, palette: MOODS.playful.palette });
    expect(shift).toMatch(/continuity of the take/);
    expect(shift).toContain(MOODS.playful.lead);
    expect(shift).toContain(MOODS.playful.soundBrief);
  });
});

describe('helpers', () => {
  it('paletteSentence stays quiet for an empty palette', () => {
    expect(paletteSentence([])).toBe('');
    expect(paletteSentence(['#111111'])).toMatch(/#111111/);
  });

  it('softenDirection keeps the beat but rules out literal trouble', () => {
    const softened = softenDirection('A city burns.');
    expect(softened).toMatch(/A city burns\./);
    expect(softened).toMatch(/no recognisable people/);
  });

  it('clampPrompt enforces the character ceiling', () => {
    expect(clampPrompt('  short  ')).toBe('short');
    const long = clampPrompt('x'.repeat(MAX_PROMPT_CHARS + 500));
    expect(long.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});
