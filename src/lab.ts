/**
 * The blot lab: the automatic ink engine, on a page of its own.
 *
 * In the studio a blot is only ever seen as a 176px frame on a rail card, and
 * what is known about it is printed somewhere else again. That is the wrong end
 * of the problem when the blot itself is what looks wrong: the shapes have to be
 * looked at side by side, rolled again, and looked at once more on the same seed
 * after a change to the engine. So this page does what the studio cannot:
 *
 * - it paints a batch of invented blots at full size through the same call the
 *   rail's `invent` port makes, so the lab cannot drift from the engine;
 * - it keeps the batch's seeds in storage, so an edit to `recipe.ts` and a
 *   reload show the same blots rather than a fresh handful of random ones;
 * - it steps one blot through the beats it is painted in, and can draw the op
 *   log over the ink - which is how a layout that reads as a grid of blobs
 *   rather than as a blot gets found;
 * - it lays the batch out as one row per blot, so a number can be read down a
 *   column instead of hunted for in a card's wrapped caption, and the whole row
 *   opens the blot full size.
 *
 * Dev-only: Vite serves it at /lab.html while the dev server runs. It talks to
 * no server and spends nothing, so paper physics and composition can be tuned
 * without waiting on a single frame of film.
 */

import { Paper, uvToPixels } from './ink/paper';
import { MIN_INK_COVERAGE, inkCoverage } from './ink/coverage';
import { BLOT_MARKS, MAX_FOLDS, inkRecipeFromSeed, renderOps } from './ink/recipe';
import { paintBeats, type PaintBeat } from './ink/paintReel';
import { clamp, parseSeed } from './ink/rng';
import {
  INK_TOOLS,
  canvasForAspect,
  type AspectRatio,
  type CanvasSpec,
  type InkOp,
  type InkRecipe,
  type InkToolId,
} from './ink/types';
import { DEFAULT_MOOD_ID, MOOD_IDS, MOODS, type MoodId } from './presets/moods';
import { createPrefsStore } from './ui/prefs';
import { applyTheme, otherTheme } from './ui/theme';

const LS_KEY = 'inkfilm.lab.v1';

/** One colour per tool, so the op map over the ink is readable at a glance. */
const TOOL_COLORS: Record<InkToolId, string> = {
  drop: '#e11d48',
  splatter: '#f59e0b',
  streak: '#2563eb',
  curve: '#7c3aed',
  pool: '#059669',
  drag: '#db2777',
  spray: '#0891b2',
  backrun: '#64748b',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function rollSeeds(count: number): number[] {
  return Array.from({ length: count }, () => parseSeed(null));
}

// ----------------------------------------------------------------- state

export interface LabState {
  moodId: MoodId;
  aspect: AspectRatio;
  /** How many blots the batch holds. */
  count: number;
  /** The batch itself. Kept in storage so a reload shows the same blots. */
  seeds: number[];
  /** null hands that value back to the engine's own roll for the blot. */
  wetness: number | null;
  bleed: number | null;
  grain: number | null;
  /**
   * 'engine' keeps the weighted fold plan, 'none' drops the creases so the ink
   * can be judged on its own, and a number takes that many of the plan's own
   * creases - a prefix, not a fresh plan, so the seed keeps the creases it drew.
   */
  folds: 'engine' | 'none' | number;
}

export function defaultLabState(): LabState {
  return {
    moodId: DEFAULT_MOOD_ID,
    aspect: '16:9',
    count: 9,
    seeds: rollSeeds(9),
    wetness: null,
    bleed: null,
    grain: null,
    folds: 'engine',
  };
}

export function loadLabState(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LabState {
  const state = defaultLabState();
  if (!storage) return state;
  try {
    const raw = storage.getItem(LS_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return state;
    if (typeof parsed.moodId === 'string' && MOOD_IDS.includes(parsed.moodId as MoodId)) {
      state.moodId = parsed.moodId as MoodId;
    }
    if (parsed.aspect === '16:9' || parsed.aspect === '9:16' || parsed.aspect === '1:1') {
      state.aspect = parsed.aspect;
    }
    if (typeof parsed.count === 'number' && Number.isFinite(parsed.count)) {
      state.count = clamp(Math.round(parsed.count), 1, 24);
    }
    if (Array.isArray(parsed.seeds)) {
      const seeds = parsed.seeds
        .filter((seed): seed is number => typeof seed === 'number' && Number.isFinite(seed))
        .map((seed) => Math.abs(Math.floor(seed)));
      if (seeds.length > 0) state.seeds = seeds.slice(0, 24);
    }
    for (const key of ['wetness', 'bleed', 'grain'] as const) {
      const value = parsed[key];
      if (typeof value === 'number' && Number.isFinite(value)) state[key] = clamp(value, 0, 1);
    }
    if (parsed.folds === 'engine' || parsed.folds === 'none') state.folds = parsed.folds;
    else if (typeof parsed.folds === 'number' && Number.isFinite(parsed.folds)) {
      state.folds = clamp(Math.round(parsed.folds), 1, MAX_FOLDS);
    }
  } catch {
    /* corrupt payload, blocked storage: the defaults are the answer */
  }
  return state;
}

export function saveLabState(state: LabState, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode: the lab simply does not remember */
  }
}

// ------------------------------------------------------------ the engine

/**
 * The recipe the rail's own `invent` port would have made for this seed.
 *
 * It goes through `inkRecipeFromSeed` with the mood's tools and `folds: 'auto'`
 * exactly as the studio does, so the blot on this page is the blot the film
 * would have been given. A mood is a tool set here and nothing more: no palette
 * is handed in, because the engine draws each blot's own colours.
 */
export function recipeFor(state: LabState, seed: number): InkRecipe {
  const mood = MOODS[state.moodId] ?? MOODS[DEFAULT_MOOD_ID];
  const recipe = inkRecipeFromSeed({
    seed,
    canvas: canvasForAspect(state.aspect),
    tools: mood.tools,
    folds: 'auto',
    ...(state.wetness === null ? {} : { wetness: state.wetness }),
    ...(state.bleed === null ? {} : { bleed: state.bleed }),
    ...(state.grain === null ? {} : { grain: state.grain }),
  });
  if (state.folds === 'none') recipe.folds = [];
  else if (typeof state.folds === 'number') recipe.folds = recipe.folds.slice(0, state.folds);
  return recipe;
}

export interface LabMeasurement {
  recipe: InkRecipe;
  ops: InkOp[];
  coverage: number;
  /** The blot had to be grown to reach the floor, so the sheet is not what was drawn. */
  grown: boolean;
  tools: Array<{ tool: InkToolId; count: number }>;
}

/** The op log a recipe replays, with the numbers that describe it. */
export function measure(state: LabState, seed: number): LabMeasurement {
  const recipe = recipeFor(state, seed);
  const ops = renderOps(recipe);
  const coverage = inkCoverage(ops, recipe.canvas);
  const counts = new Map<InkToolId, number>();
  for (const op of ops) counts.set(op.tool, (counts.get(op.tool) ?? 0) + 1);
  const tools = [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  // growth stops on the floor itself, so a blot landing there was grown to it
  return { recipe, ops, coverage, grown: coverage <= MIN_INK_COVERAGE * 1.005, tools };
}

/** Paints a recipe onto a fresh sheet, at the canvas' own full size. */
export function paintRecipe(recipe: InkRecipe): HTMLCanvasElement {
  const paper = new Paper(recipe.canvas);
  paper.render(recipe);
  return paper.canvas;
}

export interface LabBeat {
  beat: PaintBeat;
  uri: string;
}

/**
 * The painting, one frame per beat, full size.
 *
 * The rail's own reel is 176px per frame, which is enough to watch ink arrive
 * and nowhere near enough to judge it: this is the same pass at the size the
 * vision model sees, so a fold that prints the ink as a mirror rather than as a
 * transfer can be caught here.
 */
export function beatFrames(recipe: InkRecipe, quality = 0.86): LabBeat[] {
  const paper = new Paper(recipe.canvas);
  const frames: LabBeat[] = [];
  paper.renderInStages(recipe, (beat) => {
    frames.push({ beat, uri: paper.canvas.toDataURL('image/jpeg', quality) });
  });
  return frames;
}

/**
 * The finished blot with its op log drawn over it: every mark's footprint, the
 * path it was stamped along, and its index in the table beside the picture.
 * This is the view that answers "why does the page look like a grid", because
 * the circles are the estimator's own read of where the ink went.
 */
export function layoutOverlay(canvas: HTMLCanvasElement, ops: readonly InkOp[], spec: CanvasSpec): string {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(canvas, 0, 0);
  ctx.lineWidth = Math.max(2, canvas.width * 0.0035);
  ctx.font = `${Math.round(canvas.width * 0.026)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  ops.forEach((op, index) => {
    const color = TOOL_COLORS[op.tool] ?? '#111111';
    const radius = uvToPixels(op.width, spec);
    const first = op.points[0];
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    if (first) {
      ctx.beginPath();
      ctx.arc(first.x * spec.width, first.y * spec.height, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (op.points.length > 1) {
      ctx.beginPath();
      op.points.forEach((point, at) => {
        const x = point.x * spec.width;
        const y = point.y * spec.height;
        if (at === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.setLineDash([canvas.width * 0.014, canvas.width * 0.012]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (first) {
      ctx.fillStyle = color;
      ctx.fillText(String(index + 1), first.x * spec.width + radius * 0.12, first.y * spec.height - radius * 0.12);
    }
  });
  return copy.toDataURL('image/jpeg', 0.9);
}

// ------------------------------------------------------------------ page

interface LabRow {
  seed: number;
  canvas: HTMLCanvasElement;
  measurement: LabMeasurement;
}

export function mountLab(container: HTMLElement): void {
  const prefs = createPrefsStore();
  // index.html's boot script already did this before the first paint; doing it
  // again through the store makes the store the authority, not the copy
  applyTheme(prefs.state().theme);
  let state = loadLabState();
  /**
   * A first visit rolls a batch, and the batch has to be written back straight
   * away: a store that is only written on a change would roll a *new* batch on
   * the next reload, which is the one thing this page cannot do - the whole
   * point is that the same blots come back after an edit to the engine.
   */
  saveLabState(state);
  let focused: number | null = null;
  const focusPanel = document.getElementById('labfocus');

  const write = (patch: Partial<LabState>): void => {
    state = { ...state, ...patch };
    saveLabState(state);
    render();
  };

  function toolbarMarkup(): string {
    const moodOptions = MOOD_IDS
      .map((id) => `<option value="${id}"${id === state.moodId ? ' selected' : ''}>${esc(MOODS[id].label)}</option>`)
      .join('');
    const aspects: AspectRatio[] = ['16:9', '9:16', '1:1'];
    const aspectOptions = aspects
      .map((a) => `<option value="${a}"${a === state.aspect ? ' selected' : ''}>${a}</option>`)
      .join('');
    const foldOptions = [
      `<option value="engine"${state.folds === 'engine' ? ' selected' : ''}>engine's own plan</option>`,
      `<option value="none"${state.folds === 'none' ? ' selected' : ''}>no creases</option>`,
      ...Array.from({ length: MAX_FOLDS }, (_, i) => i + 1)
        .map((n) => `<option value="${n}"${state.folds === n ? ' selected' : ''}>exactly ${n}</option>`),
    ].join('');
    const numberField = (key: 'wetness' | 'bleed' | 'grain'): string => {
      const value = state[key];
      return `<label>${key}<input type="number" min="0" max="1" step="0.05" data-number="${key}" value="${value === null ? '' : value}" placeholder="engine" /></label>`;
    };
    return `
      <label>mood<select data-change="moodId">${moodOptions}</select></label>
      <label>aspect<select data-change="aspect">${aspectOptions}</select></label>
      <label>blots<input type="number" min="1" max="24" data-number="count" value="${state.count}" /></label>
      <button data-action="roll">roll new</button>
      <label>pin a seed<input type="text" data-seed placeholder="e.g. 12345" /></label>
      <button data-action="render-seed">render seed</button>
      <label>creases<select data-change="folds">${foldOptions}</select></label>
      ${numberField('wetness')}
      ${numberField('bleed')}
      ${numberField('grain')}
      <span class="spacer"></span>
      <button data-action="theme">${otherTheme(prefs.state().theme)} page</button>
      <button data-action="forget">forget these seeds</button>`;
  }

  function summaryLine(batch: readonly LabMeasurement[]): string {
    if (batch.length === 0) return 'no blots';
    const coverages = batch.map((m) => m.coverage).sort((a, b) => a - b);
    const first = coverages[0] ?? 0;
    const last = coverages[coverages.length - 1] ?? 0;
    const median = coverages[Math.floor(coverages.length / 2)] ?? 0;
    const grown = batch.filter((m) => m.grown).length;
    const creases = new Map<number, number>();
    const marks = new Map<number, number>();
    const tools = new Map<InkToolId, number>();
    for (const m of batch) {
      creases.set(m.recipe.folds.length, (creases.get(m.recipe.folds.length) ?? 0) + 1);
      marks.set(m.ops.length, (marks.get(m.ops.length) ?? 0) + 1);
      for (const entry of m.tools) tools.set(entry.tool, (tools.get(entry.tool) ?? 0) + entry.count);
    }
    const creaseLine = [...creases.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}:${c}`).join('  ');
    // the mark count is rolled per blot now, so the batch's spread is the number
    // worth reading here: seven on every row is what the roll was added to fix
    const markLine = [...marks.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}:${c}`).join('  ');
    const toolLine = [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([tool, count]) => `${tool} ${count}`).join(' · ');
    return [
      `${batch.length} blots · ink ${(first * 100).toFixed(1)}–${(last * 100).toFixed(1)}% (median ${(median * 100).toFixed(1)}%)`,
      `grown to the ${Math.round(MIN_INK_COVERAGE * 100)}% floor (*): ${grown}/${batch.length}`,
      `creases ${creaseLine}`,
      `marks(1-${BLOT_MARKS}) ${markLine}`,
      toolLine,
      `engine: 1-${BLOT_MARKS} marks rolled per blot, fold cap ${MAX_FOLDS}`,
    ].join('  ·  ');
  }

  function openFocus(seed: number): void {
    focused = seed;
    drawFocus();
  }

  function closeFocus(): void {
    focused = null;
    if (focusPanel) {
      focusPanel.hidden = true;
      focusPanel.innerHTML = '';
    }
  }

  /**
   * The focused blot: the painting, a beat at a time, with the finished sheet,
   * the op map, the recipe and the op table all on one screen.
   */
  function drawFocus(): void {
    if (!focusPanel || focused === null) return;
    const seed = focused;
    const measurement = measure(state, seed);
    const canvas = paintRecipe(measurement.recipe);
    const frames = beatFrames(measurement.recipe);
    const overlay = layoutOverlay(canvas, measurement.ops, measurement.recipe.canvas);
    const opsRows = measurement.ops.map((op, index) => {
      const points = op.points.map((p) => `${p.x},${p.y}`).join(' → ');
      return `<tr>
        <td>${index + 1}</td>
        <td style="color:${TOOL_COLORS[op.tool] ?? 'inherit'}">${op.tool}</td>
        <td>${op.width.toFixed(3)}</td>
        <td>${op.alpha.toFixed(2)}</td>
        <td>${op.wetness.toFixed(2)}</td>
        <td><span class="swatch" style="background:${op.color}"></span>${op.color}</td>
        <td title="${points}">${op.points.length}</td>
      </tr>`;
    }).join('');
    focusPanel.hidden = false;
    focusPanel.innerHTML = `
      <div class="focus-card">
        <header>
          <h2>blot #${seed}</h2>
          <span class="muted">${measurement.recipe.folds.length} creases · ${measurement.ops.length} marks · ink ${(measurement.coverage * 100).toFixed(1)}%</span>
          <button class="spacer-action" data-action="close-focus">close</button>
        </header>
        <div class="focus-body">
          <div class="focus-view">
            <img class="focus-img" src="${overlay}" alt="" />
            <label class="map-toggle"><input type="checkbox" data-focus="map" checked /> op map</label>
            <div class="steps">
              <button data-action="step" data-delta="-1">prev</button>
              <input type="range" min="0" max="${frames.length - 1}" value="${frames.length - 1}" data-focus="step" />
              <button data-action="step" data-delta="1">next</button>
            </div>
            <p class="beat" data-beat></p>
          </div>
          <div class="focus-side">
            <pre class="json">${esc(JSON.stringify(measurement.recipe, null, 2))}</pre>
            <table class="ops">
              <thead><tr><th>#</th><th>tool</th><th>width</th><th>alpha</th><th>wet</th><th>colour</th><th>pts</th></tr></thead>
              <tbody>${opsRows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    const range = focusPanel.querySelector('[data-focus="step"]') as HTMLInputElement | null;
    setStep(Number(range?.value ?? frames.length - 1));

    /** One beat of the painting, or the finished sheet with the op map over it. */
    function setStep(index: number): void {
      const frame = frames[index];
      const image = focusPanel!.querySelector('.focus-img') as HTMLImageElement | null;
      const beatLine = focusPanel!.querySelector('[data-beat]') as HTMLElement | null;
      const mapped = (focusPanel!.querySelector('[data-focus="map"]') as HTMLInputElement | null)?.checked ?? false;
      const onLast = index >= frames.length - 1;
      if (image) image.src = onLast && mapped ? overlay : frame?.uri ?? overlay;
      if (beatLine) {
        beatLine.textContent = onLast && mapped
          ? `the finished sheet, op map over it · ${measurement.ops.length} marks`
          : frame
            ? `${index + 1}/${frames.length} · ${frame.beat.kind}${frame.beat.label === '' ? '' : ` · ${frame.beat.label}`} · held ${frame.beat.holdMs}ms`
            : '';
      }
      const slider = focusPanel!.querySelector('[data-focus="step"]') as HTMLInputElement | null;
      if (slider && Number(slider.value) !== index) slider.value = String(index);
    }

    focusPanel.onclick = (event) => {
      const target = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!target) return;
      if (target.dataset.action === 'close-focus') closeFocus();
      if (target.dataset.action === 'step') {
        const delta = Number(target.dataset.delta ?? 0);
        const current = Number((focusPanel!.querySelector('[data-focus="step"]') as HTMLInputElement).value);
        setStep(clamp(current + delta, 0, frames.length - 1));
      }
    };
    focusPanel.oninput = (event) => {
      const target = event.target as HTMLElement;
      if (target.dataset.focus === 'step') setStep(Number((target as HTMLInputElement).value));
      if (target.dataset.focus === 'map') setStep(Number((focusPanel!.querySelector('[data-focus="step"]') as HTMLInputElement).value));
    };
  }

  function savePng(seed: number): void {
    const measurement = measure(state, seed);
    const canvas = paintRecipe(measurement.recipe);
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `blot-${seed}.png`;
    link.click();
  }

  async function copyRecipe(seed: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(recipeFor(state, seed), null, 2));
    } catch {
      /* the clipboard can refuse; the recipe is on screen in the focus view */
    }
  }

  function render(): void {
    container.innerHTML = `
      <header class="lab-head">
        <h1>The blot lab</h1>
        <p>the automatic engine, full size, off the film's clock — <a href="/">back to the studio</a></p>
      </header>
      <div class="bar">${toolbarMarkup()}</div>
      <p class="summary" id="lab-summary"></p>
      <div class="lab-batch" id="lab-batch"></div>`;
    const batch = container.querySelector('#lab-batch') as HTMLElement;
    batch.append(headRow());
    const measurements: LabMeasurement[] = [];
    state.seeds.forEach((seed, index) => {
      const measurement = measure(state, seed);
      const canvas = paintRecipe(measurement.recipe);
      measurements.push(measurement);
      batch.append(rowElement({ seed, canvas, measurement }, index));
    });
    (container.querySelector('#lab-summary') as HTMLElement).textContent = summaryLine(measurements);
    if (focused !== null) drawFocus();
    else closeFocus();
  }

  /**
   * The column names, in the order of the shared template in `lab.html`. The
   * head is its own row rather than a real `<thead>`, so the sheet below it is
   * a canvas in a grid cell and not a table cell a canvas would have to fight.
   */
  function headRow(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'lab-row head';
    head.innerHTML = `
      <div class="lab-cell">blot</div>
      <div class="lab-cell num">seed</div>
      <div class="lab-cell num" title="share of the sheet the ink wets; the floor is ${Math.round(MIN_INK_COVERAGE * 100)}%, and * means the blot was grown to it">ink</div>
      <div class="lab-cell num" title="marks in the op log">marks</div>
      <div class="lab-cell num" title="creases the fold plan printed">creases</div>
      <div class="lab-cell num" title="the recipe's global wetness">wet</div>
      <div class="lab-cell num" title="the recipe's global bleed">bleed</div>
      <div class="lab-cell num" title="the recipe's paper grain">grain</div>
      <div class="lab-cell" title="the tools this blot reached for, and how many marks each made">tools</div>
      <div class="lab-cell">actions</div>`;
    return head;
  }

  /**
   * One blot as one row: the sheet, then its numbers in the columns the head
   * named, then what can be done with it.
   *
   * The row itself carries the focus action, so the sheet is the click target -
   * it was the one thing on the card that was not clickable, and it is the one
   * thing the page exists to show. A button inside the row still wins, because
   * the delegated handler looks at the click's own target first.
   */
  function rowElement(row: LabRow, index: number): HTMLElement {
    const { measurement: m, canvas } = row;
    const element = document.createElement('div');
    element.className = 'lab-row';
    element.tabIndex = 0;
    element.dataset.action = 'focus';
    element.dataset.blot = String(row.seed);
    element.title = 'open this blot full size, beat by beat';
    // Chips read in the engine's own tool order rather than by count: a count
    // sort puts the same tool in a different place in every row, which is the
    // one thing a table is for.
    const chips = [...m.tools]
      .sort((a, b) => INK_TOOLS.indexOf(a.tool) - INK_TOOLS.indexOf(b.tool))
      .map((entry) => `<span class="lab-chip"><i style="background:${TOOL_COLORS[entry.tool] ?? '#888888'}"></i>${entry.tool} ${entry.count}</span>`)
      .join('');
    element.innerHTML = `
      <div class="lab-thumb"><span class="lab-zoom">view full</span></div>
      <div class="lab-cell seed num">#${row.seed}</div>
      <div class="lab-cell num" title="${m.grown ? 'grown to the ink floor' : 'as the engine drew it'}">${(m.coverage * 100).toFixed(1)}%${m.grown ? '<span class="star"> *</span>' : ''}</div>
      <div class="lab-cell num">${m.ops.length}</div>
      <div class="lab-cell num">${m.recipe.folds.length}</div>
      <div class="lab-cell num">${m.recipe.wetness.toFixed(2)}</div>
      <div class="lab-cell num">${m.recipe.bleed.toFixed(2)}</div>
      <div class="lab-cell num">${m.recipe.grain.toFixed(2)}</div>
      <div class="lab-cell lab-tools">${chips}</div>
      <div class="lab-actions">
        <button data-action="focus" data-blot="${row.seed}">view</button>
        <button data-action="reroll" data-index="${index}">new seed</button>
        <button data-action="copy" data-blot="${row.seed}">copy recipe</button>
        <button data-action="png" data-blot="${row.seed}">save png</button>
      </div>`;
    // No class on the canvas: `blot` is the rail card's own class in the app's
    // stylesheet, and it would put a panel ground, a border and 9px of padding
    // around a sheet that is meant to be bare white paper.
    (element.querySelector('.lab-thumb') as HTMLElement).append(canvas);
    return element;
  }

  container.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case 'roll':
        write({ seeds: rollSeeds(state.count) });
        return;
      case 'render-seed': {
        const field = container.querySelector('[data-seed]') as HTMLInputElement | null;
        const seed = parseSeed(field?.value ?? null);
        const seeds = [seed, ...state.seeds.slice(1)];
        write({ seeds, count: Math.max(1, state.count) });
        openFocus(seed);
        return;
      }
      case 'focus': {
        const seed = Number(target.dataset.blot);
        if (Number.isFinite(seed)) openFocus(seed);
        return;
      }
      case 'reroll': {
        const index = Number(target.dataset.index);
        const seeds = [...state.seeds];
        seeds[index] = parseSeed(null);
        write({ seeds });
        return;
      }
      case 'copy':
        void copyRecipe(Number(target.dataset.blot));
        return;
      case 'png':
        savePng(Number(target.dataset.blot));
        return;
      case 'theme': {
        const next = otherTheme(prefs.state().theme);
        applyTheme(next);
        prefs.set('theme', next);
        render();
        return;
      }
      case 'forget':
        state = defaultLabState();
        saveLabState(state);
        focused = null;
        render();
        return;
      default:
        return;
    }
  });

  container.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const change = target.dataset.change;
    if (change === 'moodId') {
      write({ moodId: target.value as MoodId });
      return;
    }
    if (change === 'aspect') {
      write({ aspect: target.value as AspectRatio });
      return;
    }
    if (change === 'folds') {
      const raw = target.value;
      write({ folds: raw === 'engine' || raw === 'none' ? raw : clamp(Number(raw), 1, MAX_FOLDS) });
      return;
    }
    const number = target.dataset.number;
    if (number === 'count') {
      const count = clamp(Math.round(Number(target.value) || 1), 1, 24);
      // a batch of a new size is a new batch: keep what is there, roll the rest
      const seeds = Array.from({ length: count }, (_, index) => state.seeds[index] ?? parseSeed(null));
      write({ count, seeds });
      return;
    }
    if (number === 'wetness' || number === 'bleed' || number === 'grain') {
      const raw = target.value.trim();
      write({ [number]: raw === '' ? null : clamp(Number(raw), 0, 1) } as Partial<LabState>);
    }
  });

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const target = event.target as HTMLElement;
    if (target.dataset.seed !== undefined) {
      (container.querySelector('[data-action="render-seed"]') as HTMLElement | null)?.click();
      return;
    }
    // a row is a control, so Enter opens it the way a click does
    if (target.dataset.blot !== undefined) {
      const seed = Number(target.dataset.blot);
      if (Number.isFinite(seed)) openFocus(seed);
    }
  });

  render();
}

/**
 * Mounts itself when the page is the lab.
 *
 * Guarded twice over: node has no document, and any other page that imports
 * this module has no `#lab`, so a unit test can reach the pure half of the file
 * without a browser.
 */
if (typeof document !== 'undefined') {
  const host = document.getElementById('lab');
  if (host) mountLab(host);
}
