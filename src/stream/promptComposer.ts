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

/**
 * How much of a blot's clip may still be the painting.
 *
 * A clip opens on the blot itself, because the blot is the image the model is
 * handed, and left to itself the model animates that painting for the whole take
 * - which is what made the film arrive on an inky frame. The switch to real
 * footage is stated as one second wherever a clip is asked for, so the studio's
 * orbit takes and the hand-painted imagining agree about the first second.
 */
export const CLIP_SWITCH_SECONDS = 1;

/** The one wording of "the painting is over inside a second", shared by both. */
export function clipOpeningClause(seconds: number = CLIP_SWITCH_SECONDS): string {
  const window = seconds === 1 ? 'first second' : `first ${seconds} seconds`;
  return `The clip opens on the painting and the switch is over inside its ${window}: the first frame is the ink painting, and by the end of it the picture is live-action footage of the real scene - at no point after that is it a painting again.`;
}

/** How hard the mood is pressed, in one place so every prompt presses equally. */
export function moodPressureClause(moodStrength: number): string {
  return moodStrength >= 0.75
    ? 'Commit fully to it; let it colour every frame.'
    : moodStrength >= 0.4
      ? 'Let it set the tone without smothering the imagery.'
      : 'Treat it as the opening colour and let the picture drift from it.';
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

export interface BlotClipPromptInput {
  /** What the vision model saw in the blot, when it has been read. */
  reading: Pick<BlotReading, 'subject' | 'prompt'> | null;
  mood: MoodPreset;
  music: MusicPreset;
  moodStrength: number;
  /** The move the camera trajectory is making, so the words agree with it. */
  camera: CameraMove | null;
  /** Clip length in seconds. */
  seconds: number;
  /** The colours the blot was painted in, when it has them. */
  palette?: readonly string[];
}

/**
 * The prompt for one blot's own clip: the Multi Angle take that blot is orbited
 * with, and the take whose held final pose the film arrives on.
 *
 * Multi Angle takes a prompt, and without one the model keeps the scene frozen
 * and animates the painting it was handed. This says what the blot is a
 * reference for instead, in the same keys as the rest of the film - the world,
 * the mood that is set, and the score - so a blot's clip stops being the one
 * paid-for picture in the app that ignores the settings beside it.
 */
export function composeBlotClipPrompt(input: BlotClipPromptInput): string {
  const { mood, music, reading, camera } = input;
  const subject = reading?.subject?.trim() ?? '';
  const beat = reading?.prompt?.trim() ?? '';
  const lines = [
    `A single unbroken shot of live-action photography, ${input.seconds} seconds long, 24 fps: a real place in real materials - skin, water, dust, stone, metal, fabric, weather - under practical light, with natural motion blur and true optics.`,
    `OPENING: the attached ink painting is the shot's first frame, and it is a reference photograph of a real scene rather than the picture's medium. ${clipOpeningClause()}`,
  ];
  if (subject !== '' || beat !== '') {
    lines.push(`SUBJECT: ${subject !== '' ? `${capitalise(subject)}. ` : ''}${beat}`.trim());
  }
  lines.push(`MOOD: ${mood.label} - ${mood.lead} ${moodPressureClause(input.moodStrength)}`);
  lines.push(`SCORE: ${music.label}, about ${music.bpm} BPM - ${music.brief}. ${capitalise(music.accent)}; cut the movement to that pulse.`);
  if (camera) lines.push(`CAMERA: ${capitalise(camera.phrase)}.`);
  if (input.palette && input.palette.length > 0) lines.push(paletteSentence(input.palette));
  lines.push('No paper, no pigment, no brush marks, no wash, no drawing, no illustration and no animation on screen, and no on-screen text, logos or legible signage.');
  return lines.join('\n\n');
}

export interface BlotClipBriefInput {
  /** The user's prompt, kept as the opening brief. */
  basePrompt: string;
  mood: MoodPreset;
  music: MusicPreset;
  moodStrength: number;
  /** Clip length in seconds. */
  seconds: number;
}

/**
 * The prompt behind "Imagine this blot": the hand-painted route's one clip.
 *
 * The user's own prompt stays the brief and the run's own settings are appended
 * to it as context - the shape `composeVisionPrompt` gives the studio's readings
 * - so an imagining made with a mood and a score set beside it carries both,
 * instead of describing a clip in a vacuum.
 */
export function composeBlotClipBrief(input: BlotClipBriefInput): string {
  return [
    input.basePrompt.trim(),
    '',
    'RUNNING CONTEXT',
    `- Film mood: ${input.mood.label}. ${input.mood.lead}`,
    `- Mood pressure: ${input.moodStrength.toFixed(2)} of 1, where 1 means commit fully to the mood. ${moodPressureClause(input.moodStrength)}`,
    `- Score: ${input.music.label} at about ${input.music.bpm} BPM - ${input.music.brief}.`,
    `- Length: one moment of at most ${input.seconds} seconds, with an arc that lands inside it rather than a sequence of events.`,
    `- Switch: ${clipOpeningClause()}`,
    '- Never write about ink, paper, pigment, brushwork, painting or animation being on screen.',
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
