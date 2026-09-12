import { DEFAULT_VISION_PROMPT, type DropOptions, type Phase, type Settings } from '../state';
import { MAX_ANGLE_SECONDS } from '../presets/camera';
import { moodById } from '../presets/moods';
import { musicById } from '../presets/music';
import { composeBlotClipBrief } from '../stream/promptComposer';
import type { Fold, InkRecipe } from '../ink/types';
import { foldGeometry } from '../ink/fold-math';
import { parseSeed } from '../ink/rng';
import type { InkScene } from '../three/scene';
import type { Paper } from '../ink/paper';
import { snapshotPaper } from '../ink/render';
import { api } from '../api/client';

export interface ManualContext {
  container: HTMLElement;
  getPaper(): Paper;
  getScene(): InkScene;
  settings: Settings;
  dropOptions: DropOptions;
  save(): void;
  /** The brush is UI state, not a run setting, so it persists on its own. */
  onBrushChanged(drop: DropOptions): void;
  /** Hands the finished blot to the film. */
  onHandoff(blob: Blob, thumbDataUri: string, recipe: InkRecipe): void;
  onExit(): void;
}

interface ManualState {
  phase: Phase;
  folds: Fold[];
  interpretation?: string;
  error?: string;
}

const AXIS_LABEL: Record<Fold['axis'], string> = { vertical: 'vertical', horizontal: 'horizontal' };

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The hand-painted route.
 *
 * Same paper physics, same fold geometry, same vision model as the automatic
 * engine, and it ends the same way: the blot joins the film as the next thing
 * the stream has to arrive at. Nothing here produces a one-off clip.
 */
export function mountManual(ctx: ManualContext): { rerender(): void; phase(): Phase } {
  const state: ManualState = { phase: 'paint', folds: [] };

  const h = (html: string): HTMLElement => {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild as HTMLElement;
  };

  function render(): void {
    const paper = ctx.getPaper();
    ctx.container.innerHTML = '';
    head();
    if (state.phase === 'paint') renderPaint();
    else if (state.phase === 'folding') renderBusy('Folding the paper', 'One half mirrors onto the other, wet on wet.');
    else if (state.phase === 'interpreting') renderBusy('Imagining', 'The vision model is reading the blot.');
    else if (state.phase === 'reveal') renderReveal();
    else renderReview();
    void paper;
  }

  /**
   * The top of the pad: the way back to the studio.
   *
   * It is also the last line of every pad, but the pad is a column of controls
   * that scrolls, so the one button that leaves the painting mode sat below the
   * fold of everything but the first phase - a mode with no visible way out.
   */
  function head(): void {
    const bar = h('<div class="pad-head"><button class="ghost" id="btnBackToFilm">Back to the film</button></div>');
    bar.querySelector('#btnBackToFilm')!.addEventListener('click', () => ctx.onExit());
    ctx.container.appendChild(bar);
  }

  function renderPaint(): void {
    const drop = ctx.dropOptions;
    ctx.container.appendChild(h(`
      <div class="pad">
        <h2>Paint one yourself</h2>
        <p class="hint">Paint a blot by hand, fold it, then hand it to the film.</p>
        <label>Ink colour <input type="color" id="inkColor" value="${drop.color}" /></label>
        <label>Drop size <span class="muted">${drop.radius} px</span>
          <input type="range" id="dropSize" min="10" max="120" value="${drop.radius}" />
        </label>
        <label>Wetness <span class="muted">${drop.wetness.toFixed(2)}</span>
          <input type="range" id="wetness" min="0" max="1" step="0.05" value="${drop.wetness}" />
        </label>
        <p class="hint">Click the paper to drop ink. Drag for a trail.</p>
        <hr />
        <h2>Folds</h2>
        <div id="foldList"></div>
        <div class="row">
          <button class="secondary" id="addFoldV">+ Vertical</button>
          <button class="secondary" id="addFoldH">+ Horizontal</button>
        </div>
        <button class="primary" id="btnFold">Fold the paper</button>
        <button class="secondary" id="btnClear">Clear paper</button>
        <button class="ghost" id="btnBack">Back to the film</button>
      </div>`));

    const update = (): void => {
      ctx.dropOptions.color = (ctx.container.querySelector('#inkColor') as HTMLInputElement).value;
      ctx.dropOptions.radius = Number((ctx.container.querySelector('#dropSize') as HTMLInputElement).value);
      ctx.dropOptions.wetness = Number((ctx.container.querySelector('#wetness') as HTMLInputElement).value);
      const size = ctx.container.querySelector('#dropSize')!.parentElement!.querySelector('.muted');
      if (size) size.textContent = `${ctx.dropOptions.radius} px`;
      const wet = ctx.container.querySelector('#wetness')!.parentElement!.querySelector('.muted');
      if (wet) wet.textContent = ctx.dropOptions.wetness.toFixed(2);
    };
    // `input` keeps the readout and the live brush in step; `change` is what a
    // range or colour picker fires when the gesture ends, so that is where the
    // brush is written down - a drag must not store a payload per pixel.
    const commit = (): void => {
      update();
      ctx.onBrushChanged({ ...ctx.dropOptions });
    };
    for (const id of ['#inkColor', '#dropSize', '#wetness']) {
      const input = ctx.container.querySelector(id)!;
      input.addEventListener('input', update);
      input.addEventListener('change', commit);
    }

    const renderFolds = (): void => {
      const list = ctx.container.querySelector('#foldList')!;
      list.innerHTML = state.folds.length === 0
        ? '<p class="hint">No folds yet, so the blot stays unsymmetric.</p>'
        : state.folds.map((fold, index) => `
            <div class="fold-item">
              Fold ${index + 1}: ${AXIS_LABEL[fold.axis]} (${fold.direction} half folds over)
              <button data-i="${index}" class="rm">x</button>
            </div>`).join('');
      list.querySelectorAll<HTMLButtonElement>('.rm').forEach((button) =>
        button.addEventListener('click', () => {
          state.folds.splice(Number(button.dataset.i), 1);
          renderFolds();
        }));
    };
    renderFolds();

    ctx.container.querySelector('#addFoldV')!.addEventListener('click', () => {
      state.folds.push({ axis: 'vertical', direction: state.folds.length % 2 === 0 ? 'left' : 'right' });
      renderFolds();
    });
    ctx.container.querySelector('#addFoldH')!.addEventListener('click', () => {
      state.folds.push({ axis: 'horizontal', direction: state.folds.length % 2 === 0 ? 'top' : 'bottom' });
      renderFolds();
    });
    ctx.container.querySelector('#btnFold')!.addEventListener('click', () => {
      void (async () => {
        state.phase = 'folding';
        render();
        for (const fold of [...state.folds]) {
          await ctx.getScene().fold(fold);
          const index = state.folds.indexOf(fold);
          if (index >= 0) state.folds.splice(index, 1);
        }
        state.phase = 'reveal';
        render();
      })();
    });
    ctx.container.querySelector('#btnClear')!.addEventListener('click', () => {
      ctx.getPaper().clear();
      ctx.getScene().refresh();
    });
    ctx.container.querySelector('#btnBack')!.addEventListener('click', () => ctx.onExit());
  }

  function renderBusy(title: string, detail: string): void {
    ctx.container.appendChild(h(`
      <div class="pad">
        <h2>${esc(title)}</h2>
        <p class="hint">${esc(detail)}</p>
      </div>`));
  }

  function renderReveal(): void {
    const paper = ctx.getPaper();
    const mood = moodById(ctx.settings.moodId);
    const music = musicById(ctx.settings.music.musicId);
    ctx.container.appendChild(h(`
      <div class="pad">
        <h2>The blot</h2>
        <img class="thumb" id="blotThumb" alt="the ink blot" />
        <p class="hint">Folds on this blot: ${foldGeometry({ axis: 'vertical', direction: 'left' }).at === 0.5 ? 'centre crease' : 'off centre'}${state.folds.length ? ` · ${state.folds.length} still queued` : ''}</p>
        <label>Vision model (OpenRouter)
          <input type="text" id="orModel" value="${esc(ctx.settings.openrouterModel)}" />
        </label>
        <label>Vision prompt
          <textarea id="visionPrompt" rows="10">${esc(ctx.settings.visionPrompt)}</textarea>
        </label>
        <button class="secondary" id="btnResetVision">Reset this prompt</button>
        <p class="hint">
          The imagining runs under <strong>${esc(mood.label)}</strong> at
          ${ctx.settings.moodStrength.toFixed(2)} pressure and a <strong>${esc(music.label)}</strong> score at
          ${music.bpm} BPM. The clip it writes is at most ${MAX_ANGLE_SECONDS}s long, and the painting is over
          inside its first second.
        </p>
        <button class="primary" id="btnInterpret">Imagine this blot</button>
        <button class="secondary" id="btnMoreInk">Back to painting</button>
        <button class="ghost" id="btnHandoffDirect">Skip the imagining, hand it over</button>
      </div>`));
    (ctx.container.querySelector('#blotThumb') as HTMLImageElement).src = paper.toDataUri();
    ctx.container.querySelector('#orModel')!.addEventListener('change', (event) => {
      ctx.settings.openrouterModel = (event.target as HTMLInputElement).value;
      ctx.save();
    });
    ctx.container.querySelector('#visionPrompt')!.addEventListener('change', (event) => {
      ctx.settings.visionPrompt = (event.target as HTMLTextAreaElement).value;
      ctx.save();
    });
    ctx.container.querySelector('#btnResetVision')!.addEventListener('click', () => {
      ctx.settings.visionPrompt = DEFAULT_VISION_PROMPT;
      ctx.save();
      render();
    });
    ctx.container.querySelector('#btnMoreInk')!.addEventListener('click', () => {
      state.phase = 'paint';
      render();
    });
    ctx.container.querySelector('#btnInterpret')!.addEventListener('click', () => {
      void (async () => {
        state.phase = 'interpreting';
        render();
        try {
          state.interpretation = await api.interpret({
            image: ctx.getPaper().toDataUri(),
            model: ctx.settings.openrouterModel,
            // the mood and the score are settings like any other: the imagining
            // is made under them rather than beside them
            visionPrompt: composeBlotClipBrief({
              basePrompt: ctx.settings.visionPrompt,
              mood,
              music,
              moodStrength: ctx.settings.moodStrength,
              seconds: MAX_ANGLE_SECONDS,
            }),
          });
          state.error = undefined;
        } catch (error) {
          state.interpretation = undefined;
          state.error = error instanceof Error ? error.message : String(error);
        }
        state.phase = 'review';
        render();
      })();
    });
    ctx.container.querySelector('#btnHandoffDirect')!.addEventListener('click', () => handOver());
  }

  function renderReview(): void {
    const paper = ctx.getPaper();
    ctx.container.appendChild(h(`
      <div class="pad">
        <h2>${state.interpretation ? 'What it could be' : 'Imagination failed'}</h2>
        <img class="thumb" id="blotThumb2" alt="the ink blot" />
        ${state.interpretation
          ? `<div class="quote">${esc(state.interpretation)}</div>`
          : `<p class="hint" style="color:var(--bad)">${esc(state.error ?? 'unknown error')}</p>`}
        <button class="primary" id="btnHandoff">Hand this blot to the film</button>
        <button class="secondary" id="btnAgain">Try the imagining again</button>
        <button class="secondary" id="btnBackToPaint">Back to painting</button>
        <button class="ghost" id="btnBack2">Back to the film</button>
      </div>`));
    (ctx.container.querySelector('#blotThumb2') as HTMLImageElement).src = paper.toDataUri();
    ctx.container.querySelector('#btnHandoff')!.addEventListener('click', () => handOver());
    ctx.container.querySelector('#btnAgain')!.addEventListener('click', () => {
      state.phase = 'reveal';
      state.interpretation = undefined;
      state.error = undefined;
      render();
    });
    ctx.container.querySelector('#btnBackToPaint')!.addEventListener('click', () => {
      state.phase = 'paint';
      render();
    });
    ctx.container.querySelector('#btnBack2')!.addEventListener('click', () => ctx.onExit());
  }

  function handOver(): void {
    const paper = ctx.getPaper();
    const snapshot = snapshotPaper(paper);
    const recipe: InkRecipe = {
      ...ctx.settings.ink,
      seed: parseSeed(`${ctx.settings.ink.seed}-by-hand-${Date.now()}`),
      canvas: paper.spec,
      folds: [],
    };
    state.interpretation = undefined;
    state.error = undefined;
    state.phase = 'paint';
    void snapshot.blob.then((blob) => ctx.onHandoff(blob, snapshot.thumbDataUri, recipe));
  }

  render();
  return {
    rerender: render,
    phase: () => state.phase,
  };
}
