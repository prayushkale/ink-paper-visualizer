import { moodById } from '../presets/moods';
import { musicById } from '../presets/music';
import type { Settings } from '../state';
import type { StudioView } from '../studio/studio';

const WIDTH = 1600;
const HEIGHT = 900;

function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A shareable still: the blots that made the film, plus what the run was set to.
 *
 * Composed at the same 16:9 as the stream so it drops straight into a post
 * without cropping the pictures out of it.
 */
export async function renderPoster(view: StudioView, settings: Settings): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser cannot compose a poster');

  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, '#0d0c10');
  background.addColorStop(1, '#1d1a1a');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = '#d8a24a';
  ctx.fillRect(0, 0, WIDTH, 6);

  ctx.fillStyle = '#eae7e1';
  ctx.font = '600 62px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('Ink & Film', 72, 120);

  ctx.fillStyle = '#9a958f';
  ctx.font = '400 26px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('real ink blots, imagined by a vision model, realised as one unbroken film', 72, 162);

  const mood = moodById(settings.moodId);
  const music = musicById(settings.music.musicId);
  const facts = [
    `mood ${mood.label.toLowerCase()}`,
    settings.music.mode === 'pinned' ? `score ${music.label.toLowerCase()} (pinned)` : `score ${music.label.toLowerCase()} (generated)`,
    `${settings.camera.enabled ? settings.camera.anglesPerBlot : 0} camera angles per blot`,
    `blot #${settings.ink.seed}`,
    settings.budget.dryRun ? 'dry run' : `${view.session.generatedSeconds}s generated`,
    `${view.chain.sessions} session${view.chain.sessions === 1 ? '' : 's'}`,
  ];
  ctx.font = '500 22px ui-monospace, monospace';
  ctx.fillStyle = '#c9c4bd';
  facts.forEach((fact, index) => {
    ctx.fillText(fact, 72 + index * 236, 214);
  });

  const blotWidth = 208;
  const blotHeight = 168;
  const gap = 22;
  const startX = 72;
  const y = 300;
  const shown = view.rail.slice(0, 6);
  for (let i = 0; i < shown.length; i++) {
    const blot = shown[i]!;
    const x = startX + i * (blotWidth + gap);
    ctx.fillStyle = '#1d1c23';
    roundRect(ctx, x, y, blotWidth, blotHeight, 12);
    ctx.fill();
    if (blot.thumb) {
      const image = await loadImage(blot.thumb);
      if (image) {
        ctx.save();
        roundRect(ctx, x + 8, y + 8, blotWidth - 16, blotHeight - 48, 8);
        ctx.clip();
        ctx.drawImage(image, x + 8, y + 8, blotWidth - 16, blotHeight - 48);
        ctx.restore();
      }
    }
    ctx.fillStyle = '#9a958f';
    ctx.font = '500 15px ui-sans-serif, system-ui, sans-serif';
    const label = (blot.subject ?? `blot #${blot.seed}`).slice(0, 24);
    ctx.fillText(label, x + 8, y + blotHeight - 12);
  }

  if (shown.length === 0) {
    ctx.fillStyle = '#6b6660';
    ctx.font = '500 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('no blots yet — start a run and the poster fills in', 72, y + 60);
  }

  ctx.fillStyle = '#6b6660';
  ctx.font = '500 20px ui-monospace, monospace';
  ctx.fillText(
    `MiniMax H3 Max Director on fal · ${view.session.generatedSeconds}s streamed · 24 fps · natively continuous`,
    72,
    HEIGHT - 56,
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the poster could not be encoded'))),
      'image/png',
    );
  });
}
