import { app } from '../main';
import { DEFAULT_VISION_PROMPT, type Phase } from '../state';
import { api } from '../api/client';
import type { Fold } from '../ink/types';

const panelRoot = document.getElementById('panel')!;

function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const AXIS_LABEL: Record<Fold['axis'], string> = { vertical: 'vertical', horizontal: 'horizontal' };

/**
 * Hand-painted mode. It shares the paper physics, the fold geometry and the
 * vision interpreter with the automatic engine, and ends by handing the
 * finished blot to the live film instead of generating a one-off clip.
 */
export function renderPanel(): void {
  const phase: Phase = app.phase;
  panelRoot.innerHTML = '';
  if (phase === 'paint') renderPaint();
  else if (phase === 'folding') renderBusy('Folding paper...', 'Each fold mirrors one half onto the other.');
  else if (phase === 'reveal') renderReveal();
  else if (phase === 'interpreting') renderBusy('Imagining...', 'The vision model is reading the blot.');
  else if (phase === 'review') renderReview();
}

function renderPaint(): void {
  const drop = app.dropOptions;
  panelRoot.appendChild(h(`
    <div>
      <h2>Direct it yourself</h2>
      <div class="hint">Paint a blot by hand, then hand it to the film.</div>
      <label>Ink colour</label>
      <input type="color" id="inkColor" value="${drop.color}" />
      <label>Drop size: <span id="dropSizeVal">${drop.radius}</span> px</label>
      <input type="range" id="dropSize" min="10" max="120" value="${drop.radius}" />
      <label>Wetness (splatter): <span id="wetVal">${drop.wetness.toFixed(2)}</span></label>
      <input type="range" id="wetness" min="0" max="1" step="0.05" value="${drop.wetness}" />
      <div class="hint">Click the paper to drop ink. Drag for a trail.</div>
      <hr />
      <h2>Folds</h2>
      <div id="foldList"></div>
      <div class="row">
        <button class="secondary" id="addFoldV">+ Vertical</button>
        <button class="secondary" id="addFoldH">+ Horizontal</button>
      </div>
      <button id="btnFold">Fold paper</button>
      <button class="secondary" id="btnClear">Clear paper</button>
      <button class="secondary" id="btnBackStudio">Back to the studio</button>
    </div>`));

  const update = (): void => {
    app.dropOptions.color = (panelRoot.querySelector('#inkColor') as HTMLInputElement).value;
    app.dropOptions.radius = Number((panelRoot.querySelector('#dropSize') as HTMLInputElement).value);
    app.dropOptions.wetness = Number((panelRoot.querySelector('#wetness') as HTMLInputElement).value);
    (panelRoot.querySelector('#dropSizeVal') as HTMLElement).textContent = String(app.dropOptions.radius);
    (panelRoot.querySelector('#wetVal') as HTMLElement).textContent = app.dropOptions.wetness.toFixed(2);
  };
  panelRoot.querySelector('#inkColor')!.addEventListener('input', update);
  panelRoot.querySelector('#dropSize')!.addEventListener('input', update);
  panelRoot.querySelector('#wetness')!.addEventListener('input', update);

  const renderFolds = (): void => {
    const list = panelRoot.querySelector('#foldList')!;
    list.innerHTML = app.folds.length === 0
      ? '<div class="hint">No folds yet — the blot stays unsymmetric.</div>'
      : app.folds.map((fold, index) =>
        `<div class="fold-item">Fold ${index + 1}: ${AXIS_LABEL[fold.axis]}
          (${fold.direction} half folds over)
          <button data-i="${index}" class="rm">x</button></div>`).join('');
    list.querySelectorAll<HTMLButtonElement>('.rm').forEach((button) =>
      button.addEventListener('click', () => {
        app.folds.splice(Number(button.dataset.i), 1);
        renderFolds();
      }));
  };
  renderFolds();

  panelRoot.querySelector('#addFoldV')!.addEventListener('click', () => {
    app.folds.push({ axis: 'vertical', direction: app.folds.length % 2 === 0 ? 'left' : 'right' });
    renderFolds();
  });
  panelRoot.querySelector('#addFoldH')!.addEventListener('click', () => {
    app.folds.push({ axis: 'horizontal', direction: app.folds.length % 2 === 0 ? 'top' : 'bottom' });
    renderFolds();
  });
  panelRoot.querySelector('#btnFold')!.addEventListener('click', () => {
    void (async () => {
      app.phase = 'folding';
      renderPanel();
      for (const fold of [...app.folds]) {
        await app.scene.fold(fold);
        const index = app.folds.indexOf(fold);
        if (index >= 0) app.folds.splice(index, 1);
      }
      app.phase = 'reveal';
      renderPanel();
    })();
  });
  panelRoot.querySelector('#btnClear')!.addEventListener('click', () => {
    app.paper.clear();
    app.scene.refresh();
  });
  panelRoot.querySelector('#btnBackStudio')!.addEventListener('click', () => app.exitManualMode());
}

function renderBusy(title: string, detail: string): void {
  panelRoot.appendChild(h(`<div><h2>${esc(title)}</h2><div class="hint">${esc(detail)}</div></div>`));
}

function renderReveal(): void {
  const settings = app.settings;
  panelRoot.appendChild(h(`
    <div>
      <h2>The blot</h2>
      <img class="thumb" id="blotThumb" alt="ink blot" />
      <label>Vision model (OpenRouter)</label>
      <input type="text" id="orModel" value="${esc(settings.openrouterModel)}" />
      <label>Vision prompt</label>
      <textarea id="visionPrompt">${esc(settings.visionPrompt)}</textarea>
      <button class="secondary" id="btnResetVision">Reset vision prompt</button>
      <button id="btnInterpret">Imagine this blot</button>
      <button class="secondary" id="btnMoreInk">Back to painting</button>
    </div>`));
  (panelRoot.querySelector('#blotThumb') as HTMLImageElement).src = app.paper.toDataUri();
  panelRoot.querySelector('#orModel')!.addEventListener('change', (event) => {
    settings.openrouterModel = (event.target as HTMLInputElement).value;
    app.saveSettings();
  });
  panelRoot.querySelector('#visionPrompt')!.addEventListener('change', (event) => {
    settings.visionPrompt = (event.target as HTMLTextAreaElement).value;
    app.saveSettings();
  });
  panelRoot.querySelector('#btnResetVision')!.addEventListener('click', () => {
    settings.visionPrompt = DEFAULT_VISION_PROMPT;
    app.saveSettings();
    renderPanel();
  });
  panelRoot.querySelector('#btnMoreInk')!.addEventListener('click', () => {
    app.phase = 'paint';
    renderPanel();
  });
  panelRoot.querySelector('#btnInterpret')!.addEventListener('click', () => {
    void (async () => {
      const button = panelRoot.querySelector('#btnInterpret') as HTMLButtonElement;
      button.disabled = true;
      button.textContent = 'Imagining...';
      app.phase = 'interpreting';
      renderPanel();
      try {
        const text = await api.interpret({
          image: app.paper.toDataUri(),
          model: settings.openrouterModel,
          visionPrompt: settings.visionPrompt,
        });
        window.lastInterpretation = text;
        app.phase = 'review';
      } catch (error) {
        window.lastInterpretation = undefined;
        window.lastError = error instanceof Error ? error.message : String(error);
        app.phase = 'review';
      }
      renderPanel();
    })();
  });
}

function renderReview(): void {
  const text = window.lastInterpretation;
  const error = window.lastError;
  panelRoot.appendChild(h(`
    <div>
      <h2>${text ? 'What it could be' : 'Imagination failed'}</h2>
      <img class="thumb" id="blotThumb2" alt="ink blot" />
      ${text
        ? `<div class="quote">${esc(text)}</div>`
        : `<div class="hint error">${esc(error ?? 'unknown error')}</div>`}
      <button id="btnHandoff">Hand this blot to the film</button>
      <button class="secondary" id="btnAngle">Make an angle take</button>
      <button class="secondary" id="btnAgain">Re-imagine</button>
      <button class="secondary" id="btnBackStudio2">Back to the studio</button>
    </div>`));
  (panelRoot.querySelector('#blotThumb2') as HTMLImageElement).src = app.paper.toDataUri();
  panelRoot.querySelector('#btnHandoff')!.addEventListener('click', () => {
    app.handoff({ text, target: 'film' });
  });
  panelRoot.querySelector('#btnAngle')!.addEventListener('click', () => {
    app.handoff({ text, target: 'angle' });
  });
  panelRoot.querySelector('#btnAgain')!.addEventListener('click', () => {
    window.lastInterpretation = undefined;
    window.lastError = undefined;
    app.phase = 'reveal';
    renderPanel();
  });
  panelRoot.querySelector('#btnBackStudio2')!.addEventListener('click', () => app.exitManualMode());
}
