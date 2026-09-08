import { app } from '../main';
import { saveSettings, estimateCost, DEFAULT_VISION_PROMPT, type Phase } from '../state';
import { api } from '../api/client';

const panelRoot = document.getElementById('panel')!;

function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPanel(): void {
  const p: Phase = app.phase;
  panelRoot.innerHTML = '';
  const settings = app.settings;
  if (p === 'paint') {
    panelRoot.appendChild(h(`
      <div>
        <h2>Ink & Paper</h2>
        <label>Ink color</label>
        <input type="color" id="inkColor" value="${app.dropOptions.color}" />
        <label>Drop size: <span id="dropSizeVal">${app.dropOptions.radius}</span> px</label>
        <input type="range" id="dropSize" min="10" max="120" value="${app.dropOptions.radius}" />
        <label>Wetness (splatter): <span id="wetVal">${app.dropOptions.wetness.toFixed(2)}</span></label>
        <input type="range" id="wetness" min="0" max="1" step="0.05" value="${app.dropOptions.wetness}" />
        <div class="hint">Click the paper to drop ink. Drag for a trail.</div>
        <hr style="border-color:#3d3d48; margin:14px 0" />
        <h2>Folds</h2>
        <div id="foldList"></div>
        <div class="row">
          <button class="secondary" id="addFoldV">+ Vertical fold</button>
          <button class="secondary" id="addFoldH">+ Horizontal fold</button>
        </div>
        <button id="btnFold">Fold paper</button>
        <button class="secondary" id="btnClear">Clear paper</button>
      </div>`));
    const upd = (): void => {
      app.dropOptions.color = (panelRoot.querySelector('#inkColor') as HTMLInputElement).value;
      app.dropOptions.radius = Number((panelRoot.querySelector('#dropSize') as HTMLInputElement).value);
      app.dropOptions.wetness = Number((panelRoot.querySelector('#wetness') as HTMLInputElement).value);
      (panelRoot.querySelector('#dropSizeVal') as HTMLElement).textContent = String(app.dropOptions.radius);
      (panelRoot.querySelector('#wetVal') as HTMLElement).textContent = app.dropOptions.wetness.toFixed(2);
    };
    panelRoot.querySelector('#inkColor')!.addEventListener('input', upd);
    panelRoot.querySelector('#dropSize')!.addEventListener('input', upd);
    panelRoot.querySelector('#wetness')!.addEventListener('input', upd);
    const renderFolds = (): void => {
      const list = panelRoot.querySelector('#foldList')!;
      list.innerHTML = app.folds.map((f, i) =>
        `<div class="fold-item">Fold ${i + 1}: ${f.axis} (${f.direction} half folds over)
          <button data-i="${i}" class="rm">x</button></div>`).join('') ||
        '<div class="hint">No folds yet - the blot will stay unsymmetric.</div>';
      list.querySelectorAll<HTMLButtonElement>('.rm').forEach((b) =>
        b.addEventListener('click', () => { app.folds.splice(Number(b.dataset.i), 1); renderFolds(); }));
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
    panelRoot.querySelector('#btnFold')!.addEventListener('click', async () => {
      app.phase = 'folding';
      renderPanel();
      const toDo = [...app.folds];
      for (const f of toDo) {
        await app.scene.fold(f);
        const idx = app.folds.indexOf(f);
        if (idx >= 0) app.folds.splice(idx, 1);
      }
      app.phase = 'reveal';
      renderPanel();
    });
    panelRoot.querySelector('#btnClear')!.addEventListener('click', () => {
      app.paper.clear(); app.scene.refresh();
    });
  } else if (p === 'reveal') {
    panelRoot.appendChild(h(`
      <div>
        <h2>The Blot</h2>
        <img class="thumb" id="blotThumb" alt="ink blot" />
        <label>Vision model (OpenRouter)</label>
        <input type="text" id="orModel" value="${esc(settings.openrouterModel)}" />
        <label>Vision prompt (what the AI looks for)</label>
        <textarea id="visionPrompt">${esc(settings.visionPrompt)}</textarea>
        <button class="secondary" id="btnResetVision">Reset vision prompt</button>
        <button id="btnInterpret">Interpret with vision AI</button>
        <button class="secondary" id="btnMoreInk">Back to painting</button>
      </div>`));
    (panelRoot.querySelector('#blotThumb') as HTMLImageElement).src = app.paper.toDataUri();
    panelRoot.querySelector('#orModel')!.addEventListener('change', (e) => {
      settings.openrouterModel = (e.target as HTMLInputElement).value; saveSettings(settings);
    });
    panelRoot.querySelector('#visionPrompt')!.addEventListener('change', (e) => {
      settings.visionPrompt = (e.target as HTMLTextAreaElement).value; saveSettings(settings);
    });
    panelRoot.querySelector('#btnResetVision')!.addEventListener('click', () => {
      settings.visionPrompt = DEFAULT_VISION_PROMPT; saveSettings(settings); renderPanel();
    });
    panelRoot.querySelector('#btnMoreInk')!.addEventListener('click', () => { app.phase = 'paint'; renderPanel(); });
    panelRoot.querySelector('#btnInterpret')!.addEventListener('click', async () => {
      const btn = panelRoot.querySelector('#btnInterpret') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Imagining...';
      try {
        const interpretation = await api.interpret(
          app.paper.toDataUri(), settings.openrouterModel, settings.visionPrompt);
        window.lastInterpretation = interpretation;
        app.phase = 'review';
        renderPanel();
      } catch (e) {
        alert('Vision failed: ' + (e instanceof Error ? e.message : String(e)));
        btn.disabled = false;
        btn.textContent = 'Interpret with vision AI';
      }
    });
  } else if (p === 'interpreting' || p === 'folding' || p === 'video') {
    const labels: Record<string, string> = {
      interpreting: 'Vision AI is imagining...',
      folding: 'Folding paper...',
      video: 'Generating video...',
    };
    panelRoot.appendChild(h(`<div><h2>${labels[p]}</h2>
      <div class="hint">This can take 10-60 seconds.</div></div>`));
  } else if (p === 'review') {
    // APPROVAL GATE: editable video prompt + full video config + cost estimate
    const v = settings.video;
    panelRoot.appendChild(h(`
      <div>
        <h2>AI Interpretation</h2>
        <img class="thumb" id="blotThumb2" alt="ink blot" />
        <div class="hint">Edit the prompt below, then generate. This is the approval gate.</div>
        <label>Video prompt</label>
        <textarea id="videoPrompt">${esc(window.lastInterpretation ?? '')}</textarea>
        <div class="row">
          <button class="secondary" id="btnReInterpret">Re-interpret</button>
        </div>
        <hr style="border-color:#3d3d48; margin:14px 0" />
        <h2>Video settings (fal.ai)</h2>
        <label>FAL model endpoint</label>
        <input type="text" id="falModel" value="${esc(v.falModel)}" />
        <div class="hint">Default schema: h3-max-turbo (image_url, prompt, duration, resolution, prompt_expansion_mode, seed). Other endpoints may need different fields - use Extra params.</div>
        <label>Duration: <span id="durVal">${v.duration}</span> s (5-15)</label>
        <input type="range" id="duration" min="5" max="15" step="1" value="${v.duration}" />
        <label>Resolution</label>
        <select id="resolution">
          <option value="480P" ${v.resolution === '480P' ? 'selected' : ''}>480P ($0.025/s)</option>
          <option value="768P" ${v.resolution === '768P' ? 'selected' : ''}>768P ($0.04/s)</option>
        </select>
        <label>Prompt expansion mode</label>
        <select id="pem">
          <option value="fast" ${v.promptExpansionMode === 'fast' ? 'selected' : ''}>fast (keeps your wording)</option>
          <option value="balanced" ${v.promptExpansionMode === 'balanced' ? 'selected' : ''}>balanced</option>
          <option value="quality" ${v.promptExpansionMode === 'quality' ? 'selected' : ''}>quality (richer rewrite)</option>
        </select>
        <label>Seed (blank = random)</label>
        <input type="text" id="seed" value="${v.seed ?? ''}" />
        <label>Extra params JSON (advanced, merged into FAL payload)</label>
        <textarea id="extraJson" style="min-height:60px">${esc(v.extraParamsJson)}</textarea>
        <div class="hint">Estimated cost: $<span id="cost">${estimateCost(v).toFixed(3)}</span></div>
        <button id="btnGenerate">Generate video</button>
        <button class="secondary" id="btnBackPaint">Start over (new painting)</button>
      </div>`));
    (panelRoot.querySelector('#blotThumb2') as HTMLImageElement).src = app.paper.toDataUri();
    const syncCost = (): void => {
      (panelRoot.querySelector('#cost') as HTMLElement).textContent = estimateCost(v).toFixed(3);
    };
    const bind = (sel: string, fn: (el: HTMLInputElement) => void, ev = 'change'): void => {
      panelRoot.querySelector(sel)!.addEventListener(ev, (e) => {
        fn(e.target as HTMLInputElement); saveSettings(settings);
      });
    };
    bind('#duration', (el) => {
      v.duration = Number(el.value);
      (panelRoot.querySelector('#durVal') as HTMLElement).textContent = el.value;
      syncCost();
    }, 'input');
    bind('#resolution', (el) => { v.resolution = el.value as '480P' | '768P'; syncCost(); });
    bind('#pem', (el) => { v.promptExpansionMode = el.value as 'fast' | 'balanced' | 'quality'; });
    bind('#seed', (el) => { v.seed = el.value === '' ? null : Number(el.value); });
    bind('#extraJson', (el) => { v.extraParamsJson = el.value; });
    panelRoot.querySelector('#falModel')!.addEventListener('change', (e) => {
      v.falModel = (e.target as HTMLInputElement).value; saveSettings(settings);
    });
    panelRoot.querySelector('#btnGenerate')!.addEventListener('click', async () => {
      if (v.extraParamsJson.trim() !== '') {
        try { JSON.parse(v.extraParamsJson); } catch {
          alert('Extra params JSON is invalid - fix it before generating.'); return;
        }
      }
      const prompt = (panelRoot.querySelector('#videoPrompt') as HTMLTextAreaElement).value;
      if (prompt.trim().length < 5) { alert('Video prompt is empty.'); return; }
      app.phase = 'video'; renderPanel();
      try {
        const sub = await api.submitVideo({ image: app.paper.toDataUri(), prompt, config: v });
        window._lastSubmitUrls = { status_url: sub.status_url, response_url: sub.response_url };
        await pollVideo(sub.request_id);
      } catch (e) {
        alert('Video submit failed: ' + (e instanceof Error ? e.message : String(e)));
        app.phase = 'review'; renderPanel();
      }
    });
    panelRoot.querySelector('#btnReInterpret')!.addEventListener('click', () => { app.phase = 'reveal'; renderPanel(); });
    panelRoot.querySelector('#btnBackPaint')!.addEventListener('click', () => { resetAll(); });
  } else if (p === 'done') {
    panelRoot.appendChild(h(`
      <div>
        <h2>Your Video</h2>
        <video id="resultVideo" controls autoplay loop></video>
        <a id="downloadLink" class="hint" download="ink-video.mp4">Download mp4</a>
        <button class="secondary" id="btnNewPainting">New painting</button>
        <button class="secondary" id="btnAnother">Regenerate video (same blot)</button>
      </div>`));
    const vid = panelRoot.querySelector('#resultVideo') as HTMLVideoElement;
    vid.src = window.lastVideoUrl ?? '';
    (panelRoot.querySelector('#downloadLink') as HTMLAnchorElement).href = window.lastVideoUrl ?? '';
    panelRoot.querySelector('#btnNewPainting')!.addEventListener('click', () => resetAll());
    panelRoot.querySelector('#btnAnother')!.addEventListener('click', () => {
      window.lastVideoUrl = undefined;
      app.phase = 'review'; renderPanel();
    });
  }
}

async function pollVideo(requestId: string): Promise<void> {
  // submitVideo returned urls are carried via window through the closure below
  const urls = window._lastSubmitUrls!;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const st = await api.videoStatus(urls.status_url, urls.response_url);
      if (st.status === 'COMPLETED' && st.videoUrl) {
        window.lastVideoUrl = st.videoUrl;
        app.phase = 'done'; renderPanel();
        return;
      }
      if (st.status === 'FAILED' || st.status === 'ERROR') {
        alert('Video generation failed: ' + (st.error ?? 'unknown'));
        app.phase = 'review'; renderPanel();
        return;
      }
    } catch (e) {
      console.warn('poll error, retrying', e);
    }
  }
}

function resetAll(): void {
  app.paper.clear();
  app.scene.refresh();
  app.folds.length = 0;
  window.lastVideoUrl = undefined;
  window.lastInterpretation = undefined;
  app.phase = 'paint';
  renderPanel();
}

declare global {
  interface Window {
    _lastSubmitUrls?: { status_url: string; response_url: string };
  }
}
