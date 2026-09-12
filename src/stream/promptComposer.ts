import type { CameraMove } from '../presets/camera';
import type { MoodPreset } from '../presets/moods';
import type { MusicPreset } from '../presets/music';
import type { BlotReading } from '../rail/reading';

/** Palette sentence shared by every part of the film. */
export function paletteSentence(colors: readonly string[]): string {
  return colors.length > 0
    ? `The ink is currently running to ${colors.join(', ')}; let those colours grade the footage rather than impose a scheme on it.`
    : '';
}

/**
 * The continuity clause three prompts share: the beat direction, a mid-stream
 * mood shift and the scheduler's own stall continuation. One run that states its
 * look three different ways reads as three different films, so the wording - and
 * the insistence that the picture stays photographic rather than painted - lives
 * here and is repeated verbatim.
 */
export const PRESERVE_CLAUSE = 'Preserve the live-action photographic look of every frame and everything already established.';

export interface WorldPromptInput {
  mood: MoodPreset;
  music: MusicPreset;
  /** Ink colours the engine is currently drawing with. */
  palette: readonly string[];
  moodStrength: number;
  /** true when the track is pinned as conditioning audio, not just described. */
  musicPinned: boolean;
  /** Overrides the score sentence, e.g. from `generatedScoreBrief`. */
  scoreBrief?: string;
  openingAction?: string;
}

/**
 * The `configure` prompt. This is the only place the film's whole world is
 * stated, so it follows the four working parts a Director prompt needs: the
 * world and its visual language, the constants to preserve, a repeatable source
 * of new situations, and an opening action already in motion.
 */
export function composeWorldPrompt(input: WorldPromptInput): string {
  const { mood, music, palette, moodStrength } = input;
  const brief = input.scoreBrief ?? music.brief;
  const sound = input.musicPinned
    ? `A continuous ${music.label.toLowerCase()} score is pinned to this film as its soundtrack: ${brief}. Every segment is conditioned on the next window of that recording, so cut picture to it rather than inventing music. No voice-over, no dialogue.`
    : `Score and sound are generated with the picture: ${brief}. No voice-over.`;
  const pressure = moodStrength >= 0.75
    ? 'Hold this mood tightly; let it colour every frame.'
    : moodStrength >= 0.4
      ? 'Let this mood set the tone without smothering the imagery.'
      : 'Use this mood as a starting colour; let the film drift if it wants to.';
  return [
    'A single continuous, unbroken film. 24 fps. One take that never ends: no cuts to black, no titles, no captions, no on-screen text, no logos, no presenter.',
    '',
    `WORLD: ${mood.lead}`,
    `${pressure}`,
    '',
    `MATERIAL: real photography of a real place, in real materials - skin, water, dust, stone, metal, fabric, weather - shot on 35mm with practical light, natural motion blur and true optics. The ink blot handed to you as the opening image is a reference for the forms, the composition and the colours of this world, never its look: no paper, no pigment, no brush marks, no wash, no drawing, no illustration, and never the blot itself on screen. ${paletteSentence(palette)}`,
    '',
    `PRESERVE: ${PRESERVE_CLAUSE} Preserve the lens, the light and the camera language you opened with, the colours the ink is running to as the film's grade, the film's unhurried curiosity, and its refusal to explain itself. Preserve whatever figures or places have already appeared.`,
    '',
    'HOW THE FILM MOVES: the film is handed a new ink blot every few seconds, and each blot is an exact destination the picture must arrive at. Never announce a blot. Treat each incoming blot as something the world was already becoming.',
    '',
    'STARTING FROM THE INK: every segment begins inside a real ink painting, and that painting is a reference photograph of the scene the film is already in. Read its actual forms - the silhouette, the mass, where the light falls, the colours - and rebuild them as real objects, a real location and real weather. The painting is the subject; its medium is never the picture.',
    '',
    `OPENING: begin mid-motion, already underway — ${input.openingAction ?? 'a slow push through real air and light, as if the camera has been watching this place for a while'}.`,
    '',
    `SOUND: ${sound}`,
  ].join('\n');
}

export interface VisionPromptInput {
  basePrompt: string;
  mood: MoodPreset;
  music: MusicPreset;
  camera: CameraMove | null;
  previousPrompts: readonly string[];
  beatIndex: number;
  moodStrength: number;
}

/**
 * The prompt handed to the vision model alongside the blot. It carries the
 * film's running context so each reading continues the story instead of
 * starting a new one.
 */
export function composeVisionPrompt(input: VisionPromptInput): string {
  const { mood, music, camera, previousPrompts } = input;
  const history = previousPrompts.length === 0
    ? '- (this is the opening beat of the film)'
    : previousPrompts.map((prompt, index) => `- beat ${index + 1}: ${prompt}`).join('\n');
  const cameraLine = camera
    ? `This beat\'s camera move is "${camera.label}": ${camera.phrase}. Write the beat so the picture and that move agree.`
    : 'No camera move is prescribed; choose one that serves the beat.';
  return [
    input.basePrompt,
    '',
    'RUNNING CONTEXT',
    `- Film mood: ${mood.label}. ${mood.lead}`,
    `- Mood pressure: ${input.moodStrength.toFixed(2)} of 1, where 1 means commit fully to the mood.`,
    `- Score: ${music.label} at about ${music.bpm} BPM — ${music.brief}.`,
    `- ${cameraLine}`,
    '- The painting is a reference photograph of a real scene, never its look. Name the real thing it depicts and describe it as live-action footage: concrete nouns, real materials, real motion, a named light source, a lens, and how the camera moves. Never write about ink, paper, pigment, brushwork, painting or animation.',
    `- Beats so far (oldest first):`,
    history,
    '',
    `This is beat ${input.beatIndex + 1}. Reply with the JSON object only.`,
  ].join('\n');
}

export interface DirectionInput {
  reading: BlotReading;
  mood: MoodPreset;
  music: MusicPreset;
  camera: CameraMove | null;
  moodStrength: number;
  /** 'hard' means the final frame is pinned to the blot. */
  arrivalMode: 'hard' | 'soft';
  /** Colours of the blot this beat is heading into, chosen at random. */
  palette?: readonly string[];
}

/**
 * The text of a live `prompt` message: one beat of the same film.
 * Kept short on purpose - Director is continuing a stream, not starting a clip.
 */
export function composeDirection(input: DirectionInput): string {
  const { reading, mood, music, camera, arrivalMode } = input;
  const parts: string[] = [];
  if (reading.transition) parts.push(`${capitalise(reading.transition)}.`);
  if (reading.prompt) parts.push(reading.prompt.trim());
  else if (reading.subject) parts.push(`${capitalise(reading.subject)} emerges from the pigment and keeps moving.`);
  if (input.palette && input.palette.length > 0) {
    parts.push(`The ink this beat is heading into runs to ${input.palette.join(', ')}; let those colours grade the shot rather than colour the world.`);
  }

  const moodClause = input.moodStrength >= 0.7
    ? `${mood.tail}`
    : input.moodStrength >= 0.35
      ? `keep the film's own momentum while ${mood.tail}`
      : 'follow the film wherever it is already going';
  parts.push(`${PRESERVE_CLAUSE} ${capitalise(moodClause)}.`);

  if (camera) parts.push(`${capitalise(camera.phrase)}.`);
  if (arrivalMode === 'hard') {
    parts.push('The closing frame of this beat is fixed: land exactly on the real scene the incoming ink painting depicts - the same forms, now real material under the same light - rather than cutting or fading to it. The take then keeps running from inside that scene. Never resolve into the painting itself: no blot, no paper, no pigment, no crease, no illustration.');
  } else {
    parts.push('Let the picture drift toward the real scene the incoming ink painting depicts, keep the take running with no cut, and never let the ink, the paper or the crease show.');
  }
  if (reading.sound) parts.push(`Sound: ${reading.sound.trim()}`);
  else parts.push(`Sound: ${music.accent}.`);
  return parts.join(' ');
}

export interface MoodShiftInput {
  from: MoodPreset;
  to: MoodPreset;
  strength: number;
  palette: readonly string[];
}

/** A mid-stream mood change is a direction, never a new session. */
export function composeMoodShift(input: MoodShiftInput): string {
  const { from, to, strength } = input;
  const lead = strength >= 0.75
    ? `Change the film's mood completely, from ${from.label.toLowerCase()} to ${to.label.toLowerCase()}.`
    : strength >= 0.4
      ? `Turn the film's mood from ${from.label.toLowerCase()} towards ${to.label.toLowerCase()}.`
      : `Let a trace of ${to.label.toLowerCase()} enter the film.`;
  return [
    lead,
    to.lead,
    `${PRESERVE_CLAUSE} Keep the figures and places already established and the continuity of the take. ${capitalise(to.tail)}.`,
    paletteSentence(input.palette),
    `Sound: ${to.soundBrief}.`,
  ].join(' ');
}

/** Applied when the vision model asks for something the stream rejects. */
export function softenDirection(text: string): string {
  return [
    text,
    'Keep it non-literal: no recognisable people, no brands, no legible text, no graphic violence.',
  ].join(' ');
}

export function capitalise(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

/** Hard cap so a runaway model can never blow the 50,000 character limit. */
export const MAX_PROMPT_CHARS = 8000;

export function clampPrompt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_PROMPT_CHARS ? trimmed : `${trimmed.slice(0, MAX_PROMPT_CHARS - 1)}…`;
}
