import type { PaintFrame } from '../ink/paintReel';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * One blot's painting as a stack of frames, each carrying when it appears and
 * how long it is held. The CSS plays them in order; the markup is the whole
 * show, so there is no timer to keep alive across a repaint.
 */
export function paintReelMarkup(frames: readonly PaintFrame[]): string {
  const body = frames.map((frame) => {
    const timing = `--at:${frame.at}ms;--hold:${frame.holdMs}ms`;
    const caption = frame.label === ''
      ? ''
      : `<span class="paint-note" style="${timing}">${esc(frame.label)}</span>`;
    return `<img class="paint-frame" src="${esc(frame.uri)}" alt="" aria-hidden="true" style="${timing}" />${caption}`;
  }).join('');
  return `<span class="paint-reel">${body}</span>`;
}

/**
 * The blot being painted, shown at stage size instead of thumbnail size.
 *
 * The rail is a 300px column that a narrow window hides altogether, and the
 * pre-flight is a minute or two with no picture to show for it: the painting is
 * the one thing worth watching while it happens, so the same frames that play on
 * a card play large over the stage. `key` is the show, so a heartbeat that
 * rewrites the markup cannot restart a painting that is still running.
 */
export function renderPaintingStage(root: HTMLElement, blot: { id: string; paint: PaintFrame[] } | null): void {
  const frames = blot?.paint ?? null;
  if (!blot || !frames || frames.length === 0) {
    reelIsPlaying(root, '');
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  if (reelIsPlaying(root, `${blot.id}:${frames.length}:${frames[0]!.at}`)) return;
  root.hidden = false;
  root.innerHTML = paintReelMarkup(frames);
}

/**
 * What each element is currently playing, so a repaint can leave it alone.
 *
 * A painting is a CSS animation over markup the shell rebuilds on a heartbeat.
 * Rewriting that markup would start the reel again from its first frame, which
 * is why a renderer showing one has to hold its output until the show is over.
 */
const playing = new WeakMap<HTMLElement, string>();

/**
 * True when `root` already holds the reel named by `key` and must not be
 * rewritten. An empty key means nothing is playing, and always writes.
 */
export function reelIsPlaying(root: HTMLElement, key: string): boolean {
  if (key === '') {
    playing.delete(root);
    return false;
  }
  if (playing.get(root) === key) return true;
  playing.set(root, key);
  return false;
}
