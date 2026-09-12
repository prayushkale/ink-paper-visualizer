import { DEFAULT_STUDIO_PROMPT, type Settings } from '../state';
import type { HealthResponse } from '../api/client';
import { downloadBlob } from '../api/client';
import { shareUrl } from '../share/recipe';
import { renderPoster } from './poster';
import type { InkStudio, StudioView } from '../studio/studio';
import { renderControls, type ControlActions } from './controls';
import { renderHud, renderPreparing, renderStatusPill, renderTelemetry } from './hud';
import { renderRail } from './rail';
import { renderPaintingStage } from './paint';
import { renderViewer, type ViewerModel } from './viewer';
import { createSectionStore, isSectionId } from './sections';
import type { UiPrefsStore } from './prefs';
import { applyTheme, otherTheme } from './theme';
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
  /** Leaves the hand-painted route and gives the settings column back. */
  exitManual(): void;
  /** Empties the last run's leavings - the blots, the log, the recording. */
  clearSession(): void;
}

export interface ShellElements {
  app: HTMLElement;
  topbar: HTMLElement;
  rail: HTMLElement;
  filmstrip: HTMLElement;
  hud: HTMLElement;
  /** The element that carries the film; double-clicking it goes fullscreen. */
  film: HTMLElement;
  /** The transport over a take being replayed: pause and the scrubber. */
  playback: HTMLElement;
  /** Where a blot's own painting plays, large, while the rail is warming up. */
  painting: HTMLElement;
  /** The full-screen blot viewer, filled from the rail on demand. */
  viewer: HTMLElement;
  /** The pre-flight overlay, drawn over the film while blots are prepared. */
  preparing: HTMLElement;
  /** The scrolling column; holds telemetry and the control body. */
  controls: HTMLElement;
  /** Where the settings sections render. Replaced on change, not on every tick. */
  controlBody: HTMLElement;
  telemetry: HTMLElement;
  /** The column transient notices stack in: top right, out of the flow. */
  toasts: HTMLElement;
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

/** A take's clock, as a player writes it: `1:07`. */
function clockLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The film is the picture: while one of these is the status, the stage belongs to
 * the live stream and not to a take being replayed.
 */
const FILM_STATUSES = new Set(['preflight', 'connecting', 'live', 'chaining']);

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
  /** The notes the last render had to make, so only the new ones are said. */
  private lastNotes: string[] = [];
  /** Which sidebar sections are open: read once on load, written through on toggle. */
  private readonly sections = createSectionStore();
  /** The blot whose picture is open in the viewer, or null when it is closed. */
  private zoomedBlotId: string | null = null;
  /** The poster on screen, kept with its blob so Download saves what is shown. */
  private poster: { blob: Blob; url: string; filename: string } | null = null;
  /** The finished take playing back on the stage, or null when none is. */
  private replay: { url: string; index: number } | null = null;
  /** The one-shot listener that reports a take this browser cannot play. */
  private replayError: (() => void) | null = null;
  /** True while the user is dragging the take's scrubber, so a `timeupdate`
   *  landing mid-drag does not yank the thumb back under the pointer. */
  private draggingScrub = false;

  constructor(
    private readonly elements: ShellElements,
    private readonly studio: InkStudio,
    private readonly actions: ShellActions,
    private readonly getSettings: () => Settings,
    private readonly getHealth: () => HealthResponse | null,
    /** The page's own memory: mute, spectator mode. Settings live elsewhere. */
    private readonly prefs: UiPrefsStore,
  ) {
    elements.controls.addEventListener('click', (event) => this.onClick(event));
    elements.controls.addEventListener('change', (event) => this.onChange(event));
    elements.controls.addEventListener('input', (event) => this.onInput(event));
    elements.controls.addEventListener('pointerup', () => {
      this.draggingSlider = false;
    });
    // `toggle` does not bubble, so the capture phase is what hears the sections
    // in the settings column open and close
    elements.controls.addEventListener('toggle', (event) => this.onSectionToggle(event), true);
    // `#telemetry` lives *inside* `#controls`, so a click in it already bubbles
    // through the listener above: a second one here fired every handler twice,
    // which is what made one Download click save two files.
    elements.topbar.addEventListener('click', (event) => this.onClick(event));
    // the blot cards are not controls: they open their own picture
    elements.rail.addEventListener('click', (event) => this.onBlotClick(event));
    elements.filmstrip.addEventListener('click', (event) => this.onBlotClick(event));
    elements.viewer.addEventListener('click', (event) => this.onViewerClick(event));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.viewerOpen) this.closeViewer();
    });
    // double-click the picture for fullscreen, the way a video player behaves
    elements.film.addEventListener('dblclick', () => void this.toggleFullscreen());
    // The transport is not inside a panel, so it carries its own listeners; a
    // double-click on it must not fall through to the stage's fullscreen.
    elements.playback.addEventListener('click', (event) => this.onPlaybackClick(event));
    elements.playback.addEventListener('dblclick', (event) => event.stopPropagation());
    elements.playback.addEventListener('input', (event) => this.onScrub(event));
    elements.playback.addEventListener('change', (event) => this.onScrub(event, true));
    // A take plays on the same element as the live stream, so the transport reads
    // its clock and its play state straight off the element rather than tracking
    // either of them itself.
    const player = elements.app.querySelector('video');
    if (player) {
      for (const name of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'seeked'] as const) {
        player.addEventListener(name, () => this.syncPlayback());
      }
    }
  }

  /** The stage's one video element: the live stream, or a take replayed on it. */
  private player(): HTMLVideoElement | null {
    return this.elements.app.querySelector('video');
  }

  /** Clicking the transport: pause/resume the take, or take it off the stage. */
  private onPlaybackClick(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    switch (button?.dataset.action) {
      case 'toggle-replay': {
        const player = this.player();
        if (!player) return;
        if (player.paused) void player.play().catch(() => {});
        else player.pause();
        break;
      }
      case 'stop-replay': this.endReplay(); this.render(this.studio.view); break;
      default: break;
    }
  }

  /** Dragging the scrubber seeks the take; the guard keeps `timeupdate` off it. */
  private onScrub(event: Event, done = false): void {
    const input = event.target as HTMLInputElement | null;
    if (!input || input.dataset.scrub === undefined) return;
    const player = this.player();
    if (!player) return;
    this.draggingScrub = !done;
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    if (duration > 0) player.currentTime = (Number(input.value) / Number(input.max)) * duration;
    this.syncPlayback();
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
      case 'clear': this.endReplay(); this.actions.clearSession(); break;
      case 'poster': void this.viewPoster(); break;
      case 'play-recording': {
        // The button reads Stop while its take is on the stage, so the same click
        // has to take it off again instead of restarting it from the top.
        const index = Number(button.dataset.index ?? 0);
        if (this.replay?.index === index) this.endReplay();
        else this.replayRecording(index);
        break;
      }
      case 'show-controls': this.setWatch(false); break;
      case 'mute': this.toggleSound(); break;
      case 'theme': this.toggleTheme(); break;
      case 'manual': this.actions.enterManual(); break;
      case 'back-to-film': this.actions.exitManual(); break;
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

  /** Opens a blot's own picture, full screen, with everything the run knows. */
  private onBlotClick(event: Event): void {
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-zoom]');
    const id = card?.dataset.zoom;
    if (!id) return;
    this.zoomedBlotId = id;
    this.renderViewer();
  }

  /** True while the overlay is showing something. */
  private get viewerOpen(): boolean {
    return this.zoomedBlotId !== null || this.poster !== null;
  }

  /** Closes the overlay, and with the poster goes the object URL it was shown from. */
  private onViewerClick(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    switch (button?.dataset.action) {
      case 'close-viewer': this.closeViewer(); break;
      case 'download-poster': this.savePoster(); break;
      default: break;
    }
  }

  private closeViewer(): void {
    this.zoomedBlotId = null;
    if (this.poster) {
      URL.revokeObjectURL(this.poster.url);
      this.poster = null;
    }
    this.renderViewer();
  }

  /**
   * Redraws the viewer, and closes it when its blot is no longer on the rail -
   * a cleared session or a fresh run must not leave a picture of a blot that
   * does not exist hanging over the film.
   */
  private renderViewer(): void {
    const blot = this.zoomedBlotId === null
      ? null
      : this.studio.view.rail.find((item) => item.id === this.zoomedBlotId) ?? null;
    if (!blot) this.zoomedBlotId = null;
    const model: ViewerModel | null = this.poster
      ? { kind: 'poster', url: this.poster.url, filename: this.poster.filename }
      : blot ? { kind: 'blot', blot } : null;
    renderViewer(this.elements.viewer, model);
  }

  /**
   * Composes the run's poster and puts it on screen.
   *
   * The poster is a still of everything the rail has, composed at the same 16:9
   * as the stream, and it used to go straight to the downloads folder - so the
   * only way to see what the run looked like as a poster was to save a file and
   * open it elsewhere. Composing it is free and takes a moment, so it is shown
   * first and saved from inside the viewer.
   */
  private async viewPoster(): Promise<void> {
    let blob: Blob;
    try {
      blob = await renderPoster(this.studio.view, this.getSettings());
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'the poster failed', 'error');
      return;
    }
    const filename = `ink-film-poster-${this.getSettings().ink.seed}.png`;
    // a second Poster click composes a fresh one: the old URL must be let go
    this.closeViewer();
    this.poster = { blob, url: URL.createObjectURL(blob), filename };
    this.renderViewer();
  }

  /** Writes the poster that is on screen. Nothing else in the viewer is saved. */
  private savePoster(): void {
    if (!this.poster) return;
    downloadBlob(this.poster.blob, this.poster.filename);
    this.toast(`Saved ${this.poster.filename}`);
  }

  /**
   * Plays a finished take back on the stage.
   *
   * A session's stream dies with the session, so once the film is over the
   * picture element has nothing left to show and the take the run just paid for
   * exists only as a file in the telemetry column. Playing it back is the same
   * element pointed at that file instead of at the stream, which is what keeps
   * the stage, fullscreen and the sound button working exactly as they did while
   * the film was live. It loops, because a take is short and a still frame with
   * a Play button is how a run looks like it failed.
   */
  private replayRecording(index: number): void {
    const { parts, result } = this.studio.view.recording;
    const chosen = parts[index] ?? result;
    const player = this.elements.app.querySelector('video');
    if (!chosen || !player) return;
    const url = URL.createObjectURL(chosen.blob);
    this.endReplay();
    this.replay = { url, index };
    // the stream is closed: clearing it is what lets `src` be the thing playing
    player.srcObject = null;
    player.poster = '';
    player.src = url;
    player.loop = true;
    // A take this browser cannot decode would otherwise leave a black stage and
    // no explanation, which reads as a broken app rather than an old container.
    this.replayError = () => this.toast('this browser cannot play that take back — download the file instead', 'error');
    player.addEventListener('error', this.replayError, { once: true });
    this.showPlayback();
    void player.play().catch(() => this.toast('press play on the film to start the take'));
  }

  /** Gives the stage back to the live session and lets the take's file go. */
  private endReplay(): void {
    if (!this.replay) return;
    const { url } = this.replay;
    this.replay = null;
    const player = this.elements.app.querySelector('video');
    if (player) {
      if (this.replayError) player.removeEventListener('error', this.replayError);
      player.pause();
      player.removeAttribute('src');
      player.loop = false;
      player.load();
    }
    this.replayError = null;
    this.hidePlayback();
    URL.revokeObjectURL(url);
  }

  /**
   * The transport over a replayed take: a pause toggle, the clock, and a
   * scrubber to jump anywhere in it. It is built once when the take lands on the
   * stage and then read off the element's own events, so nothing here is a second
   * source of truth for where the picture is.
   */
  private showPlayback(): void {
    const host = this.elements.playback;
    host.hidden = false;
    host.innerHTML = `
      <button class="ghost playback-toggle" data-action="toggle-replay" title="Pause or resume this take">Pause</button>
      <input class="playback-scrub" type="range" min="0" max="1000" step="1" value="0"
             data-scrub aria-label="Jump to any point in this take" />
      <span class="playback-clock" data-slot="clock">0:00 / 0:00</span>
      <button class="ghost playback-stop" data-action="stop-replay" title="Take the take off the stage">Stop</button>`;
    this.syncPlayback();
  }

  private hidePlayback(): void {
    const host = this.elements.playback;
    host.hidden = true;
    host.innerHTML = '';
    this.draggingScrub = false;
  }

  /** Mirrors the element's clock and play state into the transport. */
  private syncPlayback(): void {
    if (!this.replay) return;
    const player = this.player();
    if (!player) return;
    const host = this.elements.playback;
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const scrub = host.querySelector<HTMLInputElement>('.playback-scrub');
    if (scrub && !this.draggingScrub) {
      scrub.value = String(duration > 0 ? Math.round((player.currentTime / duration) * Number(scrub.max)) : 0);
    }
    const clock = host.querySelector('[data-slot="clock"]');
    if (clock) clock.textContent = `${clockLabel(player.currentTime)} / ${clockLabel(duration)}`;
    const toggle = host.querySelector<HTMLElement>('[data-action="toggle-replay"]');
    if (toggle) toggle.textContent = player.paused ? 'Play' : 'Pause';
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

  /** Spectator mode: no configuration, just the film on a screen. */
  setWatch(watch: boolean): void {
    this.elements.app.dataset.watch = watch ? '1' : '0';
    // A watched link is the only way into this mode, so leaving it has to take
    // the hash out too: otherwise the next refresh walks straight back in.
    if (!watch) this.dropWatchFromHash();
    this.prefs.set('watch', watch);
    this.lastControlsKey = '';
    this.render(this.studio.view);
  }

  /** Removes `watch` from the URL without reloading or losing a share code. */
  private dropWatchFromHash(): void {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash === '' || !/(^|&)watch(=1)?$/.test(hash)) return;
    const kept = hash.split('&').filter((part) => !/^watch(=|$)/.test(part));
    const next = kept.length > 0 ? `#${kept.join('&')}` : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', next);
  }

  get watchOnly(): boolean {
    return this.elements.app.dataset.watch === '1';
  }

  /** The film has sound; this is the escape hatch, not the default. */
  private toggleSound(): void {
    const player = this.elements.app.querySelector('video');
    if (!player) return;
    player.muted = !player.muted;
    this.prefs.set('muted', player.muted);
    this.lastTopKey = '';
    this.render(this.studio.view);
  }

  /**
   * Light and dark. The palette follows the attribute, but the WebGL stage and
   * the browser-chrome tint are told directly (see `theme.ts`).
   */
  private toggleTheme(): void {
    const next = otherTheme(this.prefs.state().theme);
    this.prefs.set('theme', next);
    applyTheme(next);
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

  /**
   * A notice that comes and goes, in the top right corner.
   *
   * Transient things - a stalled rail, a copied link - must not be pinned into
   * the page, where a message about a condition that has already passed sits
   * under the bar for the rest of the run. The bar's height is measured rather
   * than assumed, because it wraps to two rows on a narrow window and a notice
   * that lands behind the buttons is worse than none.
   */
  private toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    const host = this.elements.toasts;
    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;
    node.textContent = message;
    host.style.setProperty('--toast-top', `${Math.round(this.elements.topbar.getBoundingClientRect().height) + 12}px`);
    host.appendChild(node);
    // oldest first out, so a burst does not stack past the edge of the window
    while (host.childElementCount > 4) host.firstElementChild?.remove();
    setTimeout(() => this.dismissToast(node), kind === 'info' ? 4000 : 7000);
  }

  /** Fades a notice out before taking it out of the page. */
  private dismissToast(node: HTMLElement): void {
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 240);
  }

  /** Shows every alert the studio has queued since the last render. */
  private renderAlerts(view: StudioView): void {
    for (const alert of view.alerts) {
      if (alert.id <= this.lastAlertId) continue;
      this.lastAlertId = alert.id;
      this.toast(alert.text, alert.kind);
    }
  }

  /** Remembers a section the user opened or closed, so the next visit keeps it. */
  private onSectionToggle(event: Event): void {
    const node = event.target as HTMLDetailsElement | null;
    const id = node?.dataset?.section;
    if (!node || !isSectionId(id)) return;
    this.sections.set(id, node.open);
  }

  /**
   * Puts each section back the way the user left it. The column is rebuilt from
   * scratch whenever settings change, and every section is written closed, so
   * this is the only thing that remembers the layout.
   */
  private applySectionState(): void {
    const state = this.sections.state();
    for (const node of Array.from(this.elements.controlBody.querySelectorAll<HTMLDetailsElement>('details[data-section]'))) {
      const id = node.dataset.section;
      if (isSectionId(id)) node.open = state[id];
    }
  }

  /** Re-renders everything, bypassing the change guard. Used on mode switch. */
  refresh(): void {
    this.lastControlsKey = '';
    this.render(this.studio.view);
  }

  /** One line the run has to say, as a toast: the bar keeps no notes any more. */
  showNote(text: string): void {
    this.toast(text, 'warn');
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
    // The rail is not always on screen - a narrow window hides it and the strip
    // below 1080px used to never show - so the blot being painted is shown large
    // over the stage while the film has no picture yet. Once the film is live the
    // picture itself is the thing to watch and this steps out of the way.
    const preparing = view.status === 'preflight' || view.status === 'connecting';
    const painting = preparing
      ? view.rail.find((blot) => blot.painting && (blot.paint?.length ?? 0) > 0) ?? null
      : null;
    renderPaintingStage(
      this.elements.painting,
      painting?.paint ? { id: painting.id, paint: painting.paint } : null,
    );
    // A replay belongs to a run that is over: the moment a new session opens, or
    // the next pre-flight starts warming the rail, the element has to be free for
    // the live stream again.
    if (this.replay && FILM_STATUSES.has(view.status)) this.endReplay();
    renderPreparing(this.elements.preparing, view);
    this.renderViewer();
    renderTelemetry(this.elements.telemetry, view, this.replay?.index ?? null);
    this.renderControlsIfNeeded(view, settings);
    this.renderNotes(view, health);
    this.renderAlerts(view);
  }

  /**
   * Rebuilds the settings column only when it would actually differ. A blind
   * innerHTML on every heartbeat would fight the user's focus, their slider
   * drags, and any open section.
   */
  private renderControlsIfNeeded(view: StudioView, settings: Settings): void {
    // the hand-painted route owns this column while it is open: a studio
    // heartbeat (health resolving, the rail pumping) would otherwise rebuild
    // the settings over the paint pad mid-brush
    if (this.elements.app.dataset.mode === 'manual') return;
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
    this.lastControlsKey = key;
    renderControls(this.elements.controlBody, view, settings, this.actions);
    this.applySectionState();
  }

  private renderTopActions(busy: boolean, view: StudioView): void {
    const slot = this.elements.topbar.querySelector('[data-slot="actions"]');
    if (!slot) return;
    // The hand-painted route is a place of its own, and the bar is how a person
    // gets out of it: the pad's own Back button is the last line of a column
    // that scrolls, which is not a way out anybody finds.
    if (this.elements.app.dataset.mode === 'manual') {
      const palette = this.prefs.state().theme === 'dark'
        ? '<button class="ghost" data-action="theme" title="Use the light palette">Light</button>'
        : '<button class="ghost" data-action="theme" title="Use the dark palette">Dark</button>';
      slot.innerHTML = `<button class="primary" data-action="back-to-film">Back to the film</button>${palette}`;
      return;
    }
    const player = this.elements.app.querySelector('video');
    const sound = player && !player.muted
      ? '<button class="ghost" data-action="mute" title="Mute the film">Sound on</button>'
      : '<button class="ghost" data-action="mute" title="Unmute the film">Muted</button>';
    const fullscreen = '<button class="ghost" data-action="fullscreen" title="Double-click the film for fullscreen">Fullscreen</button>';
    // the label names the palette the click would give you, not the one you are in
    const theme = this.prefs.state().theme === 'dark'
      ? '<button class="ghost" data-action="theme" title="Use the light palette">Light</button>'
      : '<button class="ghost" data-action="theme" title="Use the dark palette">Dark</button>';
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
           ${fullscreen}${theme}${sound}<button class="danger" data-action="stop">Stop the film</button>`
        : `<button class="primary" data-action="start">Start the film</button>
           ${sound}
           ${theme}
           <button class="ghost" data-action="show-controls">Show everything</button>`;
      return;
    }
    slot.innerHTML = busy
      ? `${view.status === 'paused'
          ? '<button class="secondary" data-action="resume-film" title="Open a new session on the frozen frame and play">Play the film <span class="muted">new session</span></button>'
          : '<button class="secondary" data-action="pause-film" title="Close the session now so nothing more is billed">Pause the film</button>'}
         ${fullscreen}
         ${theme}
         ${sound}
         <button class="danger" data-action="stop">Stop the film</button>`
      : `<button class="primary" data-action="start" ${view.status === 'preflight' ? 'disabled' : ''}>
           Start the film <span class="muted">≈${usd(estimate.totalUsd)} up to ${minutesLabel(this.getSettings().budget.sessionCapSeconds)}</span>
         </button>
         <button class="secondary" data-action="poster" ${view.rail.length > 0 ? '' : 'disabled'}
                 title="Compose this run's poster and look at it before saving anything">Poster</button>
         <button class="ghost" data-action="clear" ${this.nothingToClear(view) ? 'disabled' : ''}
                 title="Clear the last session's blots, log and recording. Every setting is kept.">Clear</button>
         ${fullscreen}
         ${theme}
         ${sound}
         <button class="ghost" data-action="manual">Paint one myself</button>`;
  }

  /** True while the last session has left nothing behind to clear. */
  private nothingToClear(view: StudioView): boolean {
    return view.rail.length === 0
      && view.recording.parts.length === 0
      && view.recording.result === null
      && view.log.length === 0
      && view.warnings.length === 0;
  }

  /**
   * Everything the run has to say, as a toast.
   *
   * This used to be a strip of notes pinned under the bar, and a note outlives
   * the condition that made it: "the rail ran dry" sat there for the rest of a
   * run that had long since caught up. A toast comes and goes, so only what is
   * true now is on screen - and each note is said once, when it appears, rather
   * than repainted on every heartbeat.
   */
  private renderNotes(view: StudioView, health: HealthResponse | null): void {
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
    const notes = [...messages, ...view.warnings.slice(-3)];
    for (const text of notes) {
      if (!this.lastNotes.includes(text)) this.toast(text, 'warn');
    }
    this.lastNotes = notes;
  }
}
