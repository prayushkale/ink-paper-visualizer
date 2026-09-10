import { DEFAULT_STUDIO_PROMPT, type Settings } from '../state';
import type { HealthResponse } from '../api/client';
import { downloadBlob } from '../api/client';
import { shareUrl } from '../share/recipe';
import type { InkStudio, StudioView } from '../studio/studio';
import { renderControls, type ControlActions } from './controls';
import { renderHud, renderStatusPill, renderTelemetry } from './hud';
import { renderRail } from './rail';
import { estimateRun, minutesLabel, usd } from '../state';

/** Everything the settings column depends on, cheap enough to compare per tick. */
function controlsKey(view: StudioView, settings: Settings): string {
  const live = view.status === 'live' || view.status === 'connecting' || view.status === 'chaining' || view.status === 'paused';
  return JSON.stringify([
    live,
    view.music.status,
    view.music.resolvedUrl,
    view.current ? 'live-blot' : 'idle',
    settings,
  ]);
}

export interface ShellActions extends ControlActions {
  start(): void;
  stop(): void;
  pauseRecording(): void;
  resumeRecording(): void;
  enterManual(): void;
}

export interface ShellElements {
  app: HTMLElement;
  topbar: HTMLElement;
  rail: HTMLElement;
  filmstrip: HTMLElement;
  hud: HTMLElement;
  /** The scrolling column; holds telemetry and the control body. */
  controls: HTMLElement;
  /** Where the settings sections render. Replaced on change, not on every tick. */
  controlBody: HTMLElement;
  telemetry: HTMLElement;
  preflight: HTMLElement;
}

/** Reads a DOM input into the shape the actions expect. */
function readValue(element: HTMLElement): string | boolean | number {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return element.checked;
    if (element.type === 'range' || element.type === 'number') return Number(element.value);
    return element.value;
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return element.value;
  return '';
}

const CAMERA_MOVE_SET = new Set([
  'orbit-right', 'orbit-left', 'push-in', 'pull-back', 'crane-up', 'fly-over', 'slow-drift',
]);

/**
 * The studio shell: one delegated listener for every control, and a render pass
 * that is a pure function of the studio's view.
 */
export class StudioShell {
  private lastControlsKey = '';
  private draggingSlider = false;

  constructor(
    private readonly elements: ShellElements,
    private readonly studio: InkStudio,
    private readonly actions: ShellActions,
    private readonly getSettings: () => Settings,
    private readonly getHealth: () => HealthResponse | null,
  ) {
    elements.controls.addEventListener('click', (event) => this.onClick(event));
    elements.controls.addEventListener('change', (event) => this.onChange(event));
    elements.controls.addEventListener('input', (event) => this.onInput(event));
    elements.controls.addEventListener('pointerup', () => {
      this.draggingSlider = false;
    });
    elements.telemetry.addEventListener('click', (event) => this.onClick(event));
    elements.topbar.addEventListener('click', (event) => this.onClick(event));
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLElement | null;
    const key = target?.dataset.input;
    if (!target || !key) return;
    const value = readValue(target);
    if (target instanceof HTMLInputElement && target.type === 'range') {
      // a re-render mid-drag would drop the pointer capture, so hold it off
      this.draggingSlider = true;
    }
    this.applyInput(key, value);
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLElement | null;
    const key = target?.dataset.change ?? target?.dataset.input;
    if (!target || !key) return;
    const value = readValue(target);
    if (target instanceof HTMLInputElement && target.type === 'file') {
      const file = target.files?.[0];
      if (file && key === 'music.file') void this.actions.setMusicFile(file);
      return;
    }
    this.draggingSlider = false;
    this.applyChange(key, value);
    this.render(this.studio.view);
  }

  private onClick(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const value = button.dataset.value;
    switch (action) {
      case 'start': void this.startRun(); break;
      case 'stop': void this.actions.stop(); break;
      case 'pause-recording': this.actions.pauseRecording(); break;
      case 'resume-recording': this.actions.resumeRecording(); break;
      case 'download': this.download(); break;
      case 'share': void this.copyShare(); break;
      case 'manual': this.actions.enterManual(); break;
      case 'mood': if (value) this.actions.setMood(value as never); break;
      case 'music': if (value) this.actions.setMusic(value as never); break;
      case 'music-mode': if (value) this.actions.setMusicMode(value as 'pinned' | 'generated'); break;
      case 'camera-move': if (value) this.toggleCameraMove(value); break;
      case 'release': this.actions.releaseCurrent(); break;
      case 'reroll': this.reroll(); break;
      case 'paint': this.actions.paintThisOne(); break;
      case 'reset-studio-prompt': this.actions.setStudioPrompt(DEFAULT_STUDIO_PROMPT); break;
      case 'palette':
        if (value) this.actions.setPalette(value);
        break;
      default:
        break;
    }
    if (action && !['download', 'share'].includes(action)) this.render(this.studio.view);
  }

  private applyInput(key: string, value: string | boolean | number): void {
    switch (key) {
      case 'stream.memory': this.actions.setStream({ memory: Math.round(Number(value)) }); break;
      case 'moodStrength': this.actions.setMoodStrength(Number(value)); break;
      case 'camera.anglesPerBlot': this.actions.setCamera({ anglesPerBlot: Math.round(Number(value)) }); break;
      case 'camera.duration': this.actions.setCamera({ duration: Math.round(Number(value)) }); break;
      case 'budget.sessionCapUsd': this.actions.setBudget({ sessionCapUsd: Number(value) }); break;
      case 'budget.dailyCapUsd': this.actions.setBudget({ dailyCapUsd: Number(value) }); break;
      case 'budget.sessionCapSeconds': this.actions.setBudget({ sessionCapSeconds: Math.round(Number(value)) }); break;
      case 'ink.seed': this.actions.setSeed(String(value)); break;
      case 'music.customUrl': this.actions.setMusicUrl(String(value)); break;
      case 'openrouterModel': this.actions.setVisionModel(String(value)); break;
      case 'studioPrompt': this.actions.setStudioPrompt(String(value)); break;
      default: break;
    }
  }

  private applyChange(key: string, value: string | boolean | number): void {
    switch (key) {
      case 'stream.resolution': this.actions.setResolution(String(value) as Settings['stream']['resolution']); break;
      case 'stream.aspectRatio': this.actions.setStream({ aspectRatio: String(value) as Settings['stream']['aspectRatio'] }); break;
      case 'stream.arrivalMode': this.actions.setStream({ arrivalMode: String(value) as 'hard' | 'soft' }); break;
      case 'stream.autoChain': this.actions.setStream({ autoChain: Boolean(value) }); break;
      case 'camera.enabled': this.actions.setCamera({ enabled: Boolean(value) }); break;
      case 'camera.repeatAngleCycle': this.actions.setCamera({ repeatAngleCycle: Boolean(value) }); break;
      case 'camera.resolution': this.actions.setCamera({ resolution: String(value) as '480P' | '768P' | '1080P' }); break;
      case 'camera.handoff': this.actions.setCamera({ handoff: String(value) as 'continue' | 'turn' }); break;
      case 'budget.dryRun': this.actions.setBudget({ dryRun: Boolean(value) }); break;
      case 'palette': this.actions.setPalette(String(value)); break;
      default: this.applyInput(key, value);
    }
  }

  private toggleCameraMove(move: string): void {
    if (!CAMERA_MOVE_SET.has(move)) return;
    const current = this.getSettings().camera.moves;
    const next = current.includes(move as never)
      ? current.filter((item) => item !== move)
      : [...current, move as never];
    this.actions.setCamera({ moves: next.length > 0 ? next : current });
  }

  private reroll(): void {
    this.actions.setSeed(String(Math.floor(Math.random() * 0xffffffff)));
  }

  private async startRun(): Promise<void> {
    this.actions.start();
  }

  private download(): void {
    const result = this.studio.view.recording.result;
    if (!result) return;
    const extension = result.container === 'mp4' ? 'mp4' : result.container === 'webm' ? 'webm' : 'bin';
    downloadBlob(result.blob, `ink-film-${this.getSettings().ink.seed}.${extension}`);
  }

  private async copyShare(): Promise<void> {
    const url = shareUrl(this.studio.sharePayload());
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Share link copied');
    } catch {
      this.toast(url);
    }
  }

  private toast(message: string): void {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    this.elements.app.appendChild(node);
    setTimeout(() => node.remove(), 4000);
  }

  /** Re-renders everything, bypassing the change guard. Used on mode switch. */
  refresh(): void {
    this.lastControlsKey = '';
    this.render(this.studio.view);
  }

  /** Shows a one-line note above the film. */
  showNote(text: string): void {
    this.elements.preflight.innerHTML = `<p class="note">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
  }

  render(view: StudioView): void {
    const settings = this.getSettings();
    const health = this.getHealth();
    const busy = view.status === 'live' || view.status === 'connecting' || view.status === 'chaining' || view.status === 'preflight' || view.status === 'paused';

    renderStatusPill(this.elements.topbar.querySelector('[data-slot="status"]')!, view);
    this.renderTopActions(busy, view);
    renderRail(this.elements.rail, view);
    renderRail(this.elements.filmstrip, view, { compact: true });
    renderHud(this.elements.hud, view);
    renderTelemetry(this.elements.telemetry, view, { downloadRecording: () => this.download() });
    this.renderControlsIfNeeded(view, settings);
    this.renderPreflight(view, health);
  }

  /**
   * Rebuilds the settings column only when it would actually differ. A blind
   * innerHTML on every heartbeat would fight the user's focus, their slider
   * drags, and any open section.
   */
  private renderControlsIfNeeded(view: StudioView, settings: Settings): void {
    const key = controlsKey(view, settings);
    if (key === this.lastControlsKey) return;
    if (this.draggingSlider) return;
    const open = Array.from(this.elements.controlBody.querySelectorAll('details')).map((node) => node.open);
    this.lastControlsKey = key;
    renderControls(this.elements.controlBody, view, settings, this.actions);
    if (open.length > 0) {
      Array.from(this.elements.controlBody.querySelectorAll('details')).forEach((node, index) => {
        if (index < open.length) node.open = open[index]!;
      });
    }
  }

  private renderTopActions(busy: boolean, view: StudioView): void {
    const slot = this.elements.topbar.querySelector('[data-slot="actions"]');
    if (!slot) return;
    const estimate = estimateRun({
      seconds: this.getSettings().budget.sessionCapSeconds,
      sessionCapSeconds: this.getSettings().budget.sessionCapSeconds,
      anglesPerBlot: this.getSettings().camera.enabled ? this.getSettings().camera.anglesPerBlot : 0,
      angleSeconds: this.getSettings().camera.duration,
      angleResolution: this.getSettings().camera.resolution,
    });
    slot.innerHTML = busy
      ? `${view.recording.state === 'paused'
          ? '<button class="secondary" data-action="resume-recording">Resume recording</button>'
          : '<button class="secondary" data-action="pause-recording">Pause recording</button>'}
         <button class="danger" data-action="stop">Stop the film</button>`
      : `<button class="primary" data-action="start" ${view.status === 'preflight' ? 'disabled' : ''}>
           Start the film <span class="muted">≈${usd(estimate.totalUsd)} up to ${minutesLabel(this.getSettings().budget.sessionCapSeconds)}</span>
         </button>
         <button class="secondary" data-action="share">Copy share link</button>
         <button class="ghost" data-action="manual">Paint one myself</button>`;
  }

  private renderPreflight(view: StudioView, health: HealthResponse | null): void {
    const messages: string[] = [];
    if (health && !health.fal) messages.push('FAL_KEY is missing from the server .env, so nothing can start.');
    if (health && !health.openrouter) messages.push('OPENROUTER_API_KEY is missing, so blots cannot be imagined.');
    if (health && !health.ffmpeg) messages.push('ffmpeg was not found: recordings will be webm and cannot be converted to mp4 here.');
    if (!view.spend.dryRun && this.getSettings().music.mode === 'pinned' && !view.music.resolvedUrl && view.status === 'idle') {
      messages.push('Pinned score selected. A track resolves when the run starts, or switch to a model-generated score.');
    }
    if (view.capabilities.sessionMaxSeconds !== null && !view.spend.dryRun) {
      messages.push(`This session will be cut off after ${view.capabilities.sessionMaxSeconds}s; the film hands over just before that.`);
    }
    const warnings = [...messages, ...view.warnings.slice(-3)];
    this.elements.preflight.innerHTML = warnings.length === 0
      ? ''
      : warnings.map((text) => `<p class="note">${text}</p>`).join('');
  }
}
