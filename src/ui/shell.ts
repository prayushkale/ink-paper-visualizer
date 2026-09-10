import { DEFAULT_STUDIO_PROMPT, type Settings } from '../state';
import type { HealthResponse } from '../api/client';
import { downloadBlob } from '../api/client';
import { shareUrl } from '../share/recipe';
import { renderPoster } from './poster';
import type { InkStudio, StudioView } from '../studio/studio';
import { renderControls, type ControlActions } from './controls';
import { renderHud, renderPreparing, renderStatusPill, renderTelemetry } from './hud';
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
  setProxyToken(token: string): void;
  start(): void;
  stop(): void;
  pauseFilm(): void;
  resumeFilm(): void;
  enterManual(): void;
}

export interface ShellElements {
  app: HTMLElement;
  topbar: HTMLElement;
  rail: HTMLElement;
  filmstrip: HTMLElement;
  hud: HTMLElement;
  /** The element that carries the film; double-clicking it goes fullscreen. */
  film: HTMLElement;
  /** The pre-flight overlay, drawn over the film while blots are prepared. */
  preparing: HTMLElement;
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
  /** Top-bar actions are cheap; this only avoids pointless churn. */
  private lastTopKey = '';
  private draggingSlider = false;
  /** Highest alert id already shown as a toast. */
  private lastAlertId = 0;

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
    // double-click the picture for fullscreen, the way a video player behaves
    elements.film.addEventListener('dblclick', () => void this.toggleFullscreen());
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
      case 'pause-film': this.actions.pauseFilm(); break;
      case 'resume-film': this.actions.resumeFilm(); break;
      case 'fullscreen': void this.toggleFullscreen(); break;
      case 'download': this.download(Number(button.dataset.index ?? 0)); break;
      case 'share': void this.copyShare(); break;
      case 'poster': void this.downloadPoster(); break;
      case 'show-controls': this.setWatch(false); break;
      case 'mute': this.toggleSound(); break;
      case 'manual': this.actions.enterManual(); break;
      case 'mood': if (value) this.actions.setMood(value as never); break;
      case 'quality': if (value) this.actions.setQuality(value as never); break;
      case 'music': if (value) this.actions.setMusic(value as never); break;
      case 'music-mode': if (value) this.actions.setMusicMode(value as 'pinned' | 'generated'); break;
      case 'camera-move': if (value) this.toggleCameraMove(value); break;
      case 'release': this.actions.releaseCurrent(); break;
      case 'reroll': this.reroll(); break;
      case 'paint': this.actions.paintThisOne(); break;
      case 'reset-studio-prompt': this.actions.setStudioPrompt(DEFAULT_STUDIO_PROMPT); break;
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
      case 'proxyToken': this.actions.setProxyToken(String(value)); break;
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
      default: this.applyInput(key, value);
    }
  }

  /** Toggles fullscreen on the element that carries the film. */
  private async toggleFullscreen(): Promise<void> {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const host = this.elements.film as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const current = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    try {
      if (current) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else await doc.webkitExitFullscreen?.();
      } else if (host.requestFullscreen) {
        await host.requestFullscreen();
      } else {
        await host.webkitRequestFullscreen?.();
      }
    } catch {
      this.toast('this browser refused fullscreen');
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

  private download(index = 0): void {
    const { parts, result } = this.studio.view.recording;
    const chosen = parts[index] ?? result;
    if (!chosen) return;
    const extension = chosen.container === 'mp4' ? 'mp4' : chosen.container === 'webm' ? 'webm' : 'bin';
    const suffix = parts.length > 1 ? `-part-${index + 1}` : '';
    downloadBlob(chosen.blob, `ink-film-${this.getSettings().ink.seed}${suffix}.${extension}`);
  }

  private async downloadPoster(): Promise<void> {
    try {
      const blob = await renderPoster(this.studio.view, this.getSettings());
      downloadBlob(blob, `ink-film-poster-${this.getSettings().ink.seed}.png`);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'the poster failed');
    }
  }

  /** Spectator mode: no configuration, just the film on a screen. */
  setWatch(watch: boolean): void {
    this.elements.app.dataset.watch = watch ? '1' : '0';
    this.lastControlsKey = '';
    this.render(this.studio.view);
  }

  get watchOnly(): boolean {
    return this.elements.app.dataset.watch === '1';
  }

  /** The film has sound; this is the escape hatch, not the default. */
  private toggleSound(): void {
    const player = this.elements.app.querySelector('video');
    if (!player) return;
    player.muted = !player.muted;
    this.lastTopKey = '';
    this.render(this.studio.view);
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

  private toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;
    node.textContent = message;
    this.elements.app.appendChild(node);
    setTimeout(() => node.remove(), kind === 'info' ? 4000 : 7000);
  }

  /** Shows every alert the studio has queued since the last render. */
  private renderAlerts(view: StudioView): void {
    for (const alert of view.alerts) {
      if (alert.id <= this.lastAlertId) continue;
      this.lastAlertId = alert.id;
      this.toast(alert.text, alert.kind);
    }
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
    renderPreparing(this.elements.preparing, view);
    renderTelemetry(this.elements.telemetry, view);
    this.renderControlsIfNeeded(view, settings);
    this.renderPreflight(view, health);
    this.renderAlerts(view);
  }

  /**
   * Rebuilds the settings column only when it would actually differ. A blind
   * innerHTML on every heartbeat would fight the user's focus, their slider
   * drags, and any open section.
   */
  private renderControlsIfNeeded(view: StudioView, settings: Settings): void {
    // spectator mode hides the controls entirely, so there is nothing to build
    if (this.watchOnly) {
      this.elements.controlBody.innerHTML = '';
      this.elements.telemetry.innerHTML = '';
      this.lastControlsKey = '';
      return;
    }
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
    const player = this.elements.app.querySelector('video');
    const sound = player && !player.muted
      ? '<button class="ghost" data-action="mute" title="Mute the film">Sound on</button>'
      : '<button class="ghost" data-action="mute" title="Unmute the film">Muted</button>';
    const fullscreen = '<button class="ghost" data-action="fullscreen" title="Double-click the film for fullscreen">Fullscreen</button>';
    const estimate = estimateRun({
      seconds: this.getSettings().budget.sessionCapSeconds,
      sessionCapSeconds: this.getSettings().budget.sessionCapSeconds,
      anglesPerBlot: this.getSettings().camera.enabled ? this.getSettings().camera.anglesPerBlot : 0,
      angleSeconds: this.getSettings().camera.duration,
      angleResolution: this.getSettings().camera.resolution,
    });
    if (this.watchOnly) {
      slot.innerHTML = busy
        ? `${view.status === 'paused' ? '<button class="secondary" data-action="resume-film" title="Open a new session and play">Play</button>' : '<button class="secondary" data-action="pause-film" title="Close the session and stop billing">Pause</button>'}
           ${fullscreen}${sound}<button class="danger" data-action="stop">Stop the film</button>`
        : `<button class="primary" data-action="start">Start the film</button>
           ${sound}
           <button class="ghost" data-action="show-controls">Show everything</button>`;
      return;
    }
    slot.innerHTML = busy
      ? `${view.status === 'paused'
          ? '<button class="secondary" data-action="resume-film" title="Open a new session on the frozen frame and play">Play the film <span class="muted">new session</span></button>'
          : '<button class="secondary" data-action="pause-film" title="Close the session now so nothing more is billed">Pause the film</button>'}
         ${fullscreen}
         ${sound}
         <button class="danger" data-action="stop">Stop the film</button>`
      : `<button class="primary" data-action="start" ${view.status === 'preflight' ? 'disabled' : ''}>
           Start the film <span class="muted">≈${usd(estimate.totalUsd)} up to ${minutesLabel(this.getSettings().budget.sessionCapSeconds)}</span>
         </button>
         <button class="secondary" data-action="share">Copy share link</button>
         <button class="secondary" data-action="poster" ${view.rail.length > 0 ? '' : 'disabled'}>Poster</button>
         ${fullscreen}
         ${sound}
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
    if (view.capabilities.sessionMaxSeconds !== null && !view.spend.dryRun && this.getSettings().stream.autoChain) {
      messages.push(`This session will be cut off after ${view.capabilities.sessionMaxSeconds}s; the film hands over just before that.`);
    }
    if (view.status === 'paused') {
      messages.push('Paused: the session is closed, so nothing more is being generated or billed. Play opens a new session on the frozen frame, which bills a fresh session minimum.');
    }
    const warnings = [...messages, ...view.warnings.slice(-3)];
    this.elements.preflight.innerHTML = warnings.length === 0
      ? ''
      : warnings.map((text) => `<p class="note">${text}</p>`).join('');
  }
}
