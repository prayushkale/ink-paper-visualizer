import type { CameraMove } from '../presets/camera';
import type { MoodPreset } from '../presets/moods';
import type { MusicPreset } from '../presets/music';
import type { BlotReading } from '../rail/reading';

/** Palette sentence shared by every part of the film. */
export function paletteSentence(colors: readonly string[]): string {
  return colors.length > 0 ? `Palette locked to ${colors.join(', ')}.` : '';
}

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
    `MATERIAL: the world is made of ink and pigment on warm paper and keeps behaving like it. Shapes resolve into figures, weather and architecture without ever becoming literal illustration. ${paletteSentence(palette)}`,
    '',
    'PRESERVE: preserve the paper-and-pigment surface, the locked palette, the film\'s unhurried curiosity, and its refusal to explain itself. Preserve whatever figures or places have already appeared.',
    '',
    'HOW THE FILM MOVES: the film is handed a new ink blot every few seconds, and each blot is an exact destination the picture must arrive at. Never announce a blot. Treat each incoming blot as something the world was already becoming.',
    '',
    `OPENING: begin mid-motion, already underway — ${input.openingAction ?? 'a slow drift across the pigment as if the camera has been watching for a while'}.`,
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

  const moodClause = input.moodStrength >= 0.7
    ? `${mood.tail}`
    : input.moodStrength >= 0.35
      ? `keep the film's own momentum while ${mood.tail}`
      : 'follow the film wherever it is already going';
  parts.push(`Preserve the paper-and-pigment surface and everything already established. ${capitalise(moodClause)}.`);

  if (camera) parts.push(`${capitalise(camera.phrase)}.`);
  if (arrivalMode === 'hard') {
    parts.push('The closing frame of this beat is fixed: resolve exactly into the incoming image, letting the pigment become it rather than cutting to it.');
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
    `Preserve the paper-and-pigment surface, the figures and places already established, and the continuity of the take. ${capitalise(to.tail)}.`,
    paletteSentence(input.palette),
    `Sound: ${to.soundBrief}.`,
  ].join(' ');
}

/** Applied when the vision model asks for something the stream rejects. */
export function softenDirection(text: string): string {
  return [
    text,
    'Keep it abstract and painterly: no recognisable people, no brands, no legible text, no graphic violence.',
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
