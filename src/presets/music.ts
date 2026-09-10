export type MusicId =
  | 'trance'
  | 'classical'
  | 'ambient'
  | 'lofi'
  | 'jazz'
  | 'cinematic'
  | 'industrial'
  | 'zen'
  | 'choir'
  | 'synthwave';

export interface MusicPreset {
  id: MusicId;
  label: string;
  bpm: number;
  /**
   * Sound direction for the model. Used verbatim in 'generated' mode, and as
   * colour for the beat prompts in both modes.
   */
  brief: string;
  /**
   * Where a bundled track would live. Drop a file at this path to have the
   * preset resolve without uploading anything of your own.
   */
  localPath: string;
  /** Musical character, injected into a beat when the mood energy is high. */
  accent: string;
}

export const MUSIC_PRESETS: Record<MusicId, MusicPreset> = {
  trance: {
    id: 'trance',
    label: 'Trance',
    bpm: 138,
    brief: 'rolling 16th-note arpeggios, long supersaw pads, a steady four-on-the-floor pulse, no vocals',
    localPath: '/assets/music/trance.mp3',
    accent: 'the pulse widens and the arpeggio climbs a step',
  },
  classical: {
    id: 'classical',
    label: 'Classical',
    bpm: 72,
    brief: 'a chamber string ensemble, sustained lines, rubato phrasing, no percussion',
    localPath: '/assets/music/classical.mp3',
    accent: 'the strings swell and the harmony turns',
  },
  ambient: {
    id: 'ambient',
    label: 'Ambient',
    bpm: 60,
    brief: 'long evolving drones, tape hiss, sparse bell-like tones, no beat',
    localPath: '/assets/music/ambient.mp3',
    accent: 'a new overtone emerges from the drone',
  },
  lofi: {
    id: 'lofi',
    label: 'Lo-fi',
    bpm: 82,
    brief: 'dusty boom-bap drums, warm electric piano chords, vinyl crackle, no vocals',
    localPath: '/assets/music/lofi.mp3',
    accent: 'the chord changes and the drums relax a notch',
  },
  jazz: {
    id: 'jazz',
    label: 'Jazz',
    bpm: 96,
    brief: 'brushed drums, upright bass walking, sparse muted trumpet phrases',
    localPath: '/assets/music/jazz.mp3',
    accent: 'the bass walks up into the next change',
  },
  cinematic: {
    id: 'cinematic',
    label: 'Cinematic',
    bpm: 70,
    brief: 'low brass swells, timpani hits, a rising string ostinato',
    localPath: '/assets/music/cinematic.mp3',
    accent: 'the ostinato tightens and the brass answers',
  },
  industrial: {
    id: 'industrial',
    label: 'Industrial',
    bpm: 120,
    brief: 'distorted mechanical percussion, metallic scrapes, a driving synth bass',
    localPath: '/assets/music/industrial.mp3',
    accent: 'a machine lands a heavy downbeat',
  },
  zen: {
    id: 'zen',
    label: 'Zen',
    bpm: 54,
    brief: 'a single struck bowl, breath, bamboo flute, long silences',
    localPath: '/assets/music/zen.mp3',
    accent: 'one bowl strike rings out and decays',
  },
  choir: {
    id: 'choir',
    label: 'Choir',
    bpm: 64,
    brief: 'a cappella voices in a stone room, low sustained chords, slow reverb',
    localPath: '/assets/music/choir.mp3',
    accent: 'the voices open into a wide chord',
  },
  synthwave: {
    id: 'synthwave',
    label: 'Synthwave',
    bpm: 104,
    brief: 'gated reverb drums, a panned analog bass, neon lead with slow vibrato',
    localPath: '/assets/music/synthwave.mp3',
    accent: 'the lead glides up and the drums open',
  },
};

export const MUSIC_IDS = Object.keys(MUSIC_PRESETS) as MusicId[];
export const DEFAULT_MUSIC_ID: MusicId = 'ambient';

export function musicById(id: string | undefined): MusicPreset {
  return (id && MUSIC_PRESETS[id as MusicId]) || MUSIC_PRESETS[DEFAULT_MUSIC_ID];
}
