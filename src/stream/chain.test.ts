import { describe, it, expect } from 'vitest';
import {
  ChainController,
  backoffDelayMs,
  chooseHandoffImage,
  decideChain,
  DEFAULT_MAX_CHAINS,
  DEFAULT_SAFETY_SECONDS,
  type ChainDecisionInput,
} from './chain';
import { frameIsStale, scaledFrameSize } from './frameGrabber';

const input = (overrides: Partial<ChainDecisionInput> = {}): ChainDecisionInput => ({
  status: 'live',
  fatal: false,
  autoChain: true,
  elapsedSeconds: 60,
  maxSessionSeconds: 120,
  safetySeconds: DEFAULT_SAFETY_SECONDS,
  budgetAllows: true,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  chainCount: 0,
  maxChains: DEFAULT_MAX_CHAINS,
  ...overrides,
});

describe('decideChain', () => {
  it('keeps the session while it still has room', () => {
    expect(decideChain(input({ elapsedSeconds: 60 }))).toMatchObject({ action: 'keep' });
  });

  it('retires before the server ceiling rather than at it', () => {
    const decision = decideChain(input({ elapsedSeconds: 115, maxSessionSeconds: 120, safetySeconds: 5 }));
    expect(decision.action).toBe('chain');
    expect(decision.reason).toMatch(/ceiling/);
    // the handover happens while the server still thinks we are live
    expect(decideChain(input({ elapsedSeconds: 114, maxSessionSeconds: 120, safetySeconds: 5 })).action).toBe('keep');
  });

  it('never chains when the server has not declared a ceiling', () => {
    expect(decideChain(input({ elapsedSeconds: 10_000, maxSessionSeconds: null })).action).toBe('keep');
  });

  it('does not chain when chaining is switched off', () => {
    const decision = decideChain(input({ autoChain: false, elapsedSeconds: 10_000 }));
    expect(decision.action).toBe('keep');
    expect(decision.reason).toMatch(/chaining is off/);
  });

  it('stops when the budget is exhausted, and says why', () => {
    const decision = decideChain(input({ budgetAllows: false, budgetDetail: 'daily cap of $20.00 reached' }));
    expect(decision.action).toBe('stop');
    expect(decision.reason).toBe('daily cap of $20.00 reached');
  });

  it('stops after the session reports an unrecoverable error', () => {
    expect(decideChain(input({ fatal: true })).action).toBe('stop');
  });

  it('stops once the session has already ended', () => {
    expect(decideChain(input({ status: 'ended' })).action).toBe('stop');
    expect(decideChain(input({ status: 'failed' })).action).toBe('stop');
    expect(decideChain(input({ status: 'stopping' })).action).toBe('stop');
  });

  it('stops after too many sessions in a row failed to open', () => {
    const decision = decideChain(input({ consecutiveFailures: 3, maxConsecutiveFailures: 3, elapsedSeconds: 200 }));
    expect(decision.action).toBe('stop');
    expect(decision.reason).toMatch(/3 sessions in a row/);
  });

  it('does not chain before the budget is even consulted for a keep', () => {
    expect(decideChain(input({ status: 'connecting', elapsedSeconds: 0 })).action).toBe('keep');
  });
});

describe('chooseHandoffImage', () => {
  it('continues on the previous stream frame by default', () => {
    expect(chooseHandoffImage('continue', 'https://fal.media/last.jpg', 'https://fal.media/angle.png'))
      .toEqual({ url: 'https://fal.media/last.jpg', used: 'continue' });
  });

  it('turns to an angle view when a turn was asked for', () => {
    expect(chooseHandoffImage('turn', 'https://fal.media/last.jpg', 'https://fal.media/angle.png'))
      .toEqual({ url: 'https://fal.media/angle.png', used: 'turn' });
  });

  it('falls back to the last frame when a turn has no angle available', () => {
    expect(chooseHandoffImage('turn', 'https://fal.media/last.jpg', null))
      .toEqual({ url: 'https://fal.media/last.jpg', used: 'continue' });
  });

  it('uses an angle view when there is no last frame', () => {
    expect(chooseHandoffImage('continue', null, 'https://fal.media/angle.png'))
      .toEqual({ url: 'https://fal.media/angle.png', used: 'turn' });
  });

  it('has nothing to hand over when neither exists', () => {
    expect(chooseHandoffImage('continue', null, null)).toEqual({ url: null, used: 'continue' });
  });
});

describe('backoffDelayMs', () => {
  it('doubles then caps', () => {
    expect(backoffDelayMs(0)).toBe(2000);
    expect(backoffDelayMs(1)).toBe(4000);
    expect(backoffDelayMs(2)).toBe(8000);
    expect(backoffDelayMs(10)).toBe(30000);
    expect(backoffDelayMs(-3)).toBe(2000);
  });
});

describe('ChainController', () => {
  it('counts sessions and chains separately', () => {
    const controller = new ChainController({ autoChain: true });
    controller.recordStart();
    expect(controller.sessionCount).toBe(1);
    expect(controller.chainCount).toBe(0);
    controller.recordStart();
    expect(controller.sessionCount).toBe(2);
    expect(controller.chainCount).toBe(1);
  });

  it('tracks consecutive failures and clears them when a session opens', () => {
    const controller = new ChainController({ autoChain: true });
    controller.recordFailure();
    controller.recordFailure();
    expect(controller.consecutiveFailures).toBe(2);
    expect(controller.failures).toBe(2);
    controller.recordOpened();
    expect(controller.consecutiveFailures).toBe(0);
    expect(controller.failures).toBe(2);
  });

  it('stops at the session limit even with budget to spare', () => {
    const controller = new ChainController({ autoChain: true, maxChains: 2 });
    controller.recordStart();
    controller.recordStart();
    controller.recordStart();
    const decision = controller.decide({
      status: 'live', fatal: false, elapsedSeconds: 200, maxSessionSeconds: 120, budgetAllows: true,
    });
    expect(decision.action).toBe('stop');
    expect(decision.reason).toMatch(/limit of 2 sessions/);
  });

  it('uses the configured safety margin', () => {
    const controller = new ChainController({ autoChain: true, safetySeconds: 20 });
    expect(controller.safetySeconds).toBe(20);
    const decision = controller.decide({
      status: 'live', fatal: false, elapsedSeconds: 100, maxSessionSeconds: 120, budgetAllows: true,
    });
    expect(decision.action).toBe('chain');
  });

  it('resets everything for a fresh run', () => {
    const controller = new ChainController({ autoChain: true });
    controller.recordStart();
    controller.recordStart();
    controller.recordFailure();
    controller.reset();
    expect(controller.sessionCount).toBe(0);
    expect(controller.chainCount).toBe(0);
    expect(controller.failures).toBe(0);
    expect(controller.consecutiveFailures).toBe(0);
  });
});

describe('frameGrabber helpers', () => {
  it('knows when the rolling frame is stale', () => {
    expect(frameIsStale(null, 1000, 2000)).toBe(true);
    expect(frameIsStale(1000, 1500, 2000)).toBe(false);
    expect(frameIsStale(1000, 3000, 2000)).toBe(true);
  });

  it('scales a frame down to the model working size', () => {
    expect(scaledFrameSize(1344, 768, 1344)).toEqual({ width: 1344, height: 768 });
    expect(scaledFrameSize(2688, 1536, 1344)).toEqual({ width: 1344, height: 768 });
    expect(scaledFrameSize(768, 1344, 1344)).toEqual({ width: 768, height: 1344 });
    expect(scaledFrameSize(3840, 2160, 1344)).toEqual({ width: 1344, height: 756 });
  });

  it('never produces a zero-sized frame', () => {
    expect(scaledFrameSize(0, 0, 1344)).toEqual({ width: 1, height: 1 });
    expect(scaledFrameSize(2, 1, 1344)).toEqual({ width: 2, height: 1 });
  });
});
