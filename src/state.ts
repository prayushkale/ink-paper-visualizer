export type Phase =
  | 'paint'
  | 'folding'
  | 'reveal'
  | 'interpreting'
  | 'review'
  | 'video'
  | 'done';

export type Axis = 'vertical' | 'horizontal';
/** which half folds over: left/right for vertical, top/bottom for horizontal */
export type Direction = 'left' | 'right' | 'top' | 'bottom';

export interface Fold {
  axis: Axis;
  direction: Direction;
}

export interface DropOptions {
  radius: number;   // px on the 1024px canvas, 10-120
  color: string;    // CSS color
  wetness: number;  // 0-1, how far the blot splatters
}

/** Everything the user can configure for the video step. */
export interface VideoConfig {
  falModel: string;            // endpoint id, default 'minimax/h3-max-turbo/image-to-video'
  duration: number;            // int 5-15
  resolution: '480P' | '768P';
  promptExpansionMode: 'fast' | 'balanced' | 'quality';
  seed: number | null;         // null = random
  extraParamsJson: string;     // advanced: extra fields merged into FAL payload, '' = none
}

export interface Settings {
  openrouterModel: string;     // default 'google/gemini-2.5-flash'
  visionPrompt: string;
  video: VideoConfig;
}

export const DEFAULT_VISION_PROMPT = `You are a visionary film director. Study this abstract ink blot painting. Let its shapes, colors and negative space suggest something only you can see - figures, landscapes, creatures, weather, machines, dreams. Then write ONE vivid video-generation prompt for a short cinematic video that STARTS exactly from this painting as its first frame and then comes alive and evolves into what you imagined. Describe subject, motion, camera movement, lighting and mood. Output ONLY the video prompt text, under 150 words, no preamble.`;

export const DEFAULT_SETTINGS: Settings = {
  openrouterModel: 'google/gemini-2.5-flash',
  visionPrompt: DEFAULT_VISION_PROMPT,
  video: {
    falModel: 'minimax/h3-max-turbo/image-to-video',
    duration: 5,
    resolution: '768P',
    promptExpansionMode: 'fast',
    seed: null,
    extraParamsJson: '',
  },
};

/** Cost estimate in USD; rates verified 2026-09-08 (promo ended). */
export function estimateCost(cfg: VideoConfig): number {
  const perSec = cfg.resolution === '480P' ? 0.025 : 0.04;
  return cfg.duration * perSec;
}

const LS_KEY = 'ink-paper-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}
