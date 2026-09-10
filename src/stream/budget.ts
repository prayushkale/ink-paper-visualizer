import { directorRate, multiAngleRate, type AngleResolution, type BudgetConfig } from '../state';

/** Where the day's spend is remembered between reloads. */
export interface SpendStore {
  read(): number;
  write(value: number): void;
}

export function createLocalSpendStore(key = 'ink-paper-spend-v1'): SpendStore {
  return {
    read(): number {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return 0;
        const parsed = JSON.parse(raw) as { dayKey?: string; usd?: number };
        if (parsed.dayKey !== dayKeyFor(new Date())) return 0;
        return typeof parsed.usd === 'number' && Number.isFinite(parsed.usd) ? Math.max(0, parsed.usd) : 0;
      } catch {
        return 0;
      }
    },
    write(value: number): void {
      try {
        localStorage.setItem(key, JSON.stringify({ dayKey: dayKeyFor(new Date()), usd: Math.round(value * 10000) / 10000 }));
      } catch {
        /* quota or private mode: the day's meter simply does not persist */
      }
    },
  };
}

/** Local calendar day, so the daily cap resets at the user's midnight. */
export function dayKeyFor(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function costOfDirectorSeconds(seconds: number, now: Date = new Date()): number {
  return Math.max(0, seconds) * directorRate(now);
}

export function costOfAngleTakes(takes: number, secondsPerTake: number, resolution: AngleResolution, now: Date = new Date()): number {
  return Math.max(0, takes) * Math.max(0, secondsPerTake) * multiAngleRate(resolution, now);
}

export type BudgetReason = 'ok' | 'session-cap-usd' | 'session-cap-seconds' | 'daily-cap';

export interface BudgetVerdict {
  ok: boolean;
  reason: BudgetReason;
  detail: string;
}

const OK: BudgetVerdict = { ok: true, reason: 'ok', detail: '' };

export interface BudgetLimits extends Pick<BudgetConfig, 'sessionCapUsd' | 'dailyCapUsd' | 'sessionCapSeconds'> {
  angleResolution?: AngleResolution;
  angleSecondsPerTake?: number;
  /** A demo run: nothing is spent and nothing is blocked. */
  dryRun?: boolean;
  /**
   * Ceiling the live session itself declared. Set when `session_info` arrives and
   * cleared by `beginSession`, because the next session declares its own.
   */
  maxSessionSeconds?: number | null;
}

export interface BudgetOptions {
  now?: () => Date;
  store?: SpendStore;
  /** Ceiling reported by the session itself, when it declares one. */
  maxSessionSeconds?: number | null;
}

/**
 * The one thing a per-second video model needs and a per-request one does not:
 * a meter that can stop the film.
 *
 * Director bills for every second it generates, with a 60 second floor per
 * session, so a run that is left alone will happily spend until the balance is
 * gone. Every chunk and every orbit take is added here, and the stream is
 * stopped by this guard rather than by the user noticing.
 */
export class BudgetGuard {
  private sessionDirectorSecondsValue = 0;
  private sessionAngleTakesValue = 0;
  private todayUsdValue = 0;
  private readonly now: () => Date;
  private readonly store: SpendStore;

  constructor(private readonly limits: BudgetLimits, private readonly options: BudgetOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? createLocalSpendStore();
    this.todayUsdValue = this.store.read();
  }

  get dryRun(): boolean {
    return this.limits.dryRun === true;
  }

  get sessionDirectorSeconds(): number {
    return this.sessionDirectorSecondsValue;
  }

  get sessionAngleTakes(): number {
    return this.sessionAngleTakesValue;
  }

  get sessionUsd(): number {
    if (this.dryRun) return 0;
    return costOfDirectorSeconds(this.sessionDirectorSecondsValue, this.now())
      + costOfAngleTakes(
        this.sessionAngleTakesValue,
        this.limits.angleSecondsPerTake ?? 5,
        this.limits.angleResolution ?? '480P',
        this.now(),
      );
  }

  get todayUsd(): number {
    return this.dryRun ? 0 : this.todayUsdValue;
  }

  get remainingSessionUsd(): number {
    return Math.max(0, this.limits.sessionCapUsd - this.sessionUsd);
  }

  get remainingTodayUsd(): number {
    return Math.max(0, this.limits.dailyCapUsd - this.todayUsd);
  }

  get remainingSessionSeconds(): number {
    return Math.max(0, this.limits.sessionCapSeconds - this.sessionDirectorSecondsValue);
  }

  /** The hard wall for this session: the cap, or the server's own ceiling. */
  get effectiveSessionCapSeconds(): number {
    const declared = this.limits.maxSessionSeconds ?? this.options.maxSessionSeconds;
    if (typeof declared === 'number' && declared > 0) {
      return Math.min(this.limits.sessionCapSeconds, declared);
    }
    return this.limits.sessionCapSeconds;
  }

  /**
   * Re-reads the caps from settings. The guard is built once when the studio is
   * created, but the sliders and the quality presets are edited long after, so
   * the live values must be pushed in rather than snapshotted.
   */
  updateLimits(patch: Partial<BudgetLimits>): void {
    Object.assign(this.limits, patch);
  }

  /** Resets the per-session counters. Call before each new session in a chain. */
  beginSession(): void {
    this.sessionDirectorSecondsValue = 0;
    this.sessionAngleTakesValue = 0;
    // the previous session's ceiling said nothing about this one
    this.limits.maxSessionSeconds = undefined;
  }

  /** Records a generated chunk. This is the money clock. */
  addChunk(seconds: number): BudgetVerdict {
    this.sessionDirectorSecondsValue += Math.max(0, seconds);
    return this.evaluate();
  }

  /** Records an orbit take, which bills on the Multi Angle meter. */
  addAngleTake(secondsPerTake?: number): BudgetVerdict {
    this.sessionAngleTakesValue += 1;
    void secondsPerTake;
    return this.evaluate();
  }

  /** Whether a new session may be opened at all. */
  checkBeforeSession(): BudgetVerdict {
    if (this.dryRun) return OK;
    if (this.todayUsdValue >= this.limits.dailyCapUsd) {
      return {
        ok: false,
        reason: 'daily-cap',
        detail: `daily cap of $${this.limits.dailyCapUsd.toFixed(2)} reached ($${this.todayUsdValue.toFixed(2)} spent today)`,
      };
    }
    if (this.sessionUsd >= this.limits.sessionCapUsd) {
      return {
        ok: false,
        reason: 'session-cap-usd',
        detail: `session cap of $${this.limits.sessionCapUsd.toFixed(2)} reached`,
      };
    }
    return OK;
  }

  /** Whether an orbit take may be afforded right now. */
  checkBeforeAngleTake(): BudgetVerdict {
    if (this.dryRun) return OK;
    const takeCost = costOfAngleTakes(1, this.limits.angleSecondsPerTake ?? 5, this.limits.angleResolution ?? '480P', this.now());
    if (this.sessionUsd + takeCost > this.limits.sessionCapUsd) {
      return { ok: false, reason: 'session-cap-usd', detail: `an orbit take would exceed the $${this.limits.sessionCapUsd.toFixed(2)} session cap` };
    }
    if (this.todayUsdValue + takeCost > this.limits.dailyCapUsd) {
      return { ok: false, reason: 'daily-cap', detail: 'an orbit take would exceed the daily cap' };
    }
    return OK;
  }

  /** The verdict for the current position in the run. */
  evaluate(): BudgetVerdict {
    if (this.dryRun) return OK;
    if (this.sessionUsd >= this.limits.sessionCapUsd) {
      return {
        ok: false,
        reason: 'session-cap-usd',
        detail: `session cap of $${this.limits.sessionCapUsd.toFixed(2)} reached`,
      };
    }
    if (this.sessionDirectorSecondsValue >= this.effectiveSessionCapSeconds) {
      return {
        ok: false,
        reason: 'session-cap-seconds',
        detail: `session time cap of ${this.effectiveSessionCapSeconds}s reached`,
      };
    }
    if (this.todayUsdValue >= this.limits.dailyCapUsd) {
      return {
        ok: false,
        reason: 'daily-cap',
        detail: `daily cap of $${this.limits.dailyCapUsd.toFixed(2)} reached`,
      };
    }
    return OK;
  }

  /** Folds the session's spend into the day's total and persists it. */
  commitSession(): number {
    if (this.dryRun) return 0;
    this.todayUsdValue += this.sessionUsd;
    this.store.write(this.todayUsdValue);
    return this.todayUsdValue;
  }

  reset(): void {
    this.sessionDirectorSecondsValue = 0;
    this.sessionAngleTakesValue = 0;
    this.todayUsdValue = 0;
    this.store.write(0);
  }
}
