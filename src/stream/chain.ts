import type { StudioStatus } from '../state';

export type HandoffPolicy = 'continue' | 'turn';

export interface ChainDecisionInput {
  status: StudioStatus;
  fatal: boolean;
  autoChain: boolean;
  /** Wall-clock seconds this session has been live. */
  elapsedSeconds: number;
  /** The server's own ceiling, when it declares one. */
  maxSessionSeconds: number | null;
  /** Retire the session this many seconds before the server would end it. */
  safetySeconds: number;
  /** Whether a fresh session is affordable right now. */
  budgetAllows: boolean;
  budgetDetail?: string;
  /** Give up after this many consecutive failed sessions. */
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  /** Optional hard limit on how many sessions a single run may open. */
  chainCount: number;
  maxChains: number;
}

export type ChainAction = 'keep' | 'chain' | 'stop';

export interface ChainDecision {
  action: ChainAction;
  reason: string;
}

export const DEFAULT_SAFETY_SECONDS = 5;
export const DEFAULT_MAX_CHAINS = 20;
export const DEFAULT_MAX_FAILURES = 3;

/**
 * Decides whether the film should hand over to a fresh session.
 *
 * A Director session is not resumable, so "continuous" is only ever achieved by
 * chaining: retire this one just before the server would, and open the next with
 * the previous picture's final frame as its exact first frame.
 */
export function decideChain(input: ChainDecisionInput): ChainDecision {
  if (input.fatal) return { action: 'stop', reason: 'the session reported an unrecoverable error' };
  if (input.status === 'stopping' || input.status === 'ended' || input.status === 'failed') {
    return { action: 'stop', reason: `the session is ${input.status}` };
  }
  if (!input.budgetAllows) {
    return { action: 'stop', reason: input.budgetDetail ?? 'the budget for this run is used up' };
  }
  if (input.consecutiveFailures >= input.maxConsecutiveFailures) {
    return { action: 'stop', reason: `${input.consecutiveFailures} sessions in a row failed to start` };
  }
  if (!input.autoChain) {
    return input.status === 'live'
      ? { action: 'keep', reason: 'chaining is off' }
      : { action: 'keep', reason: 'waiting' };
  }
  if (typeof input.maxSessionSeconds === 'number' && input.maxSessionSeconds > 0) {
    const retireAt = Math.max(1, input.maxSessionSeconds - input.safetySeconds);
    if (input.elapsedSeconds >= retireAt) {
      return {
        action: 'chain',
        reason: `retiring before the ${input.maxSessionSeconds}s session ceiling so the handover is ours, not the server's`,
      };
    }
  }
  return { action: 'keep', reason: 'the session still has room' };
}

/**
 * Which still opens the next session.
 *
 * 'continue' reuses the last frame of the previous stream, so the seam is
 * invisible. 'turn' deliberately opens on a different camera angle of the
 * current blot: the world holds and the viewpoint changes, which reads as a cut
 * inside one continuous film rather than a continuation.
 */
export function chooseHandoffImage(
  policy: HandoffPolicy,
  lastFrame: string | null | undefined,
  angleView: string | null | undefined,
): { url: string | null; used: HandoffPolicy } {
  if (policy === 'turn' && angleView) return { url: angleView, used: 'turn' };
  if (lastFrame) return { url: lastFrame, used: 'continue' };
  if (angleView) return { url: angleView, used: 'turn' };
  return { url: null, used: 'continue' };
}

/** Exponential backoff for a session that refused to open. */
export function backoffDelayMs(attempt: number, baseMs = 2000, maxMs = 30000): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** safeAttempt);
}

export interface ChainControllerOptions {
  autoChain: boolean;
  safetySeconds?: number;
  maxChains?: number;
  maxConsecutiveFailures?: number;
}

/**
 * Bookkeeping for a chain of sessions: how many have run, how many failed, and
 * whether it is time to hand over.
 */
export class ChainController {
  private sessionCountValue = 0;
  private chainCountValue = 0;
  private failuresValue = 0;
  private consecutiveFailuresValue = 0;

  constructor(private options: ChainControllerOptions) {}

  get sessionCount(): number {
    return this.sessionCountValue;
  }

  get chainCount(): number {
    return this.chainCountValue;
  }

  get failures(): number {
    return this.failuresValue;
  }

  get consecutiveFailures(): number {
    return this.consecutiveFailuresValue;
  }

  get autoChain(): boolean {
    return this.options.autoChain;
  }

  /** Chaining can be switched off mid-run from the UI. */
  setAutoChain(value: boolean): void {
    this.options.autoChain = value;
  }

  get safetySeconds(): number {
    return this.options.safetySeconds ?? DEFAULT_SAFETY_SECONDS;
  }

  get maxChains(): number {
    return this.options.maxChains ?? DEFAULT_MAX_CHAINS;
  }

  get maxConsecutiveFailures(): number {
    return this.options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
  }

  decide(input: {
    status: StudioStatus;
    fatal: boolean;
    elapsedSeconds: number;
    maxSessionSeconds: number | null;
    budgetAllows: boolean;
    budgetDetail?: string;
  }): ChainDecision {
    const base = decideChain({
      ...input,
      autoChain: this.autoChain,
      safetySeconds: this.safetySeconds,
      consecutiveFailures: this.consecutiveFailuresValue,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      chainCount: this.chainCountValue,
      maxChains: this.maxChains,
    });
    if (base.action === 'chain' && this.chainCountValue >= this.maxChains) {
      return { action: 'stop', reason: `reached the limit of ${this.maxChains} sessions for one run` };
    }
    return base;
  }

  recordStart(): void {
    this.sessionCountValue += 1;
    if (this.sessionCountValue > 1) this.chainCountValue += 1;
  }

  recordOpened(): void {
    this.consecutiveFailuresValue = 0;
  }

  recordFailure(): void {
    this.failuresValue += 1;
    this.consecutiveFailuresValue += 1;
  }

  reset(): void {
    this.sessionCountValue = 0;
    this.chainCountValue = 0;
    this.failuresValue = 0;
    this.consecutiveFailuresValue = 0;
  }
}
