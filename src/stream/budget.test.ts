import { describe, it, expect, beforeEach } from 'vitest';
import {
  BudgetGuard,
  costOfAngleTakes,
  costOfDirectorSeconds,
  createLocalSpendStore,
  dayKeyFor,
  type BudgetLimits,
  type SpendStore,
} from './budget';

const PROMO = new Date('2026-09-10T12:00:00Z');
const LIST = new Date('2026-09-20T12:00:00Z');
const DAY = new Date('2026-09-10T09:30:00Z');

function memoryStore(initial = 0): SpendStore & { value: number } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (next: number) => { store.value = next; },
  };
  return store;
}

const limits = (overrides: Partial<BudgetLimits> = {}): BudgetLimits => ({
  sessionCapUsd: 5,
  dailyCapUsd: 20,
  sessionCapSeconds: 120,
  angleResolution: '480P',
  angleSecondsPerTake: 5,
  ...overrides,
});

describe('dayKeyFor', () => {
  it('is a local calendar day', () => {
    expect(dayKeyFor(new Date('2026-09-08T00:00:01Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayKeyFor(DAY)).toBe(dayKeyFor(new Date(DAY)));
  });
});

describe('cost helpers', () => {
  it('prices director seconds at the current rate', () => {
    expect(costOfDirectorSeconds(120, PROMO)).toBeCloseTo(2.4);
    expect(costOfDirectorSeconds(120, LIST)).toBeCloseTo(9.6);
    expect(costOfDirectorSeconds(-5, PROMO)).toBe(0);
  });
  it('prices orbit takes at the multi angle rate', () => {
    expect(costOfAngleTakes(8, 5, '480P', PROMO)).toBeCloseTo(0.5);
    expect(costOfAngleTakes(8, 5, '768P', LIST)).toBeCloseTo(3.2);
    expect(costOfAngleTakes(0, 5, '768P', PROMO)).toBe(0);
  });
});

describe('createLocalSpendStore', () => {
  it('reads zero when there is no storage', () => {
    expect(createLocalSpendStore().read()).toBe(0);
  });
});

describe('BudgetGuard', () => {
  let store: ReturnType<typeof memoryStore>;
  let guard: BudgetGuard;

  beforeEach(() => {
    store = memoryStore();
    guard = new BudgetGuard(limits(), { now: () => PROMO, store });
  });

  it('starts a session at zero', () => {
    expect(guard.sessionUsd).toBe(0);
    expect(guard.sessionDirectorSeconds).toBe(0);
    expect(guard.evaluate()).toMatchObject({ ok: true });
  });

  it('rises with each generated chunk', () => {
    // 10 s chunks at $0.02/s
    guard.addChunk(10);
    expect(guard.sessionUsd).toBeCloseTo(0.2);
    guard.addChunk(10);
    expect(guard.sessionUsd).toBeCloseTo(0.4);
    expect(guard.evaluate().ok).toBe(true);
  });

  it('stops the session when the dollar cap is reached', () => {
    for (let i = 0; i < 25; i++) guard.addChunk(10);
    const verdict = guard.evaluate();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('session-cap-usd');
    expect(verdict.detail).toMatch(/\$5\.00/);
  });

  it('stops the session when the seconds cap is reached', () => {
    const capped = new BudgetGuard(limits({ sessionCapSeconds: 60, sessionCapUsd: 100 }), { now: () => PROMO, store });
    capped.addChunk(50);
    expect(capped.evaluate().ok).toBe(true);
    const verdict = capped.addChunk(10);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('session-cap-seconds');
  });

  it('honours a ceiling the session itself declares', () => {
    const declared = new BudgetGuard(limits({ sessionCapSeconds: 900, sessionCapUsd: 100 }), {
      now: () => PROMO, store, maxSessionSeconds: 120,
    });
    expect(declared.effectiveSessionCapSeconds).toBe(120);
    declared.addChunk(120);
    expect(declared.evaluate().reason).toBe('session-cap-seconds');
  });

  it('ignores a declared ceiling that is wider than the user cap', () => {
    const declared = new BudgetGuard(limits({ sessionCapSeconds: 60, sessionCapUsd: 100 }), {
      now: () => PROMO, store, maxSessionSeconds: 900,
    });
    expect(declared.effectiveSessionCapSeconds).toBe(60);
  });

  it('honours a ceiling that arrives with the live session', () => {
    // the server only declares its ceiling after the session opens, so it has to
    // reach the guard that enforces it rather than being known and ignored
    const guard2 = new BudgetGuard(limits({ sessionCapSeconds: 900, sessionCapUsd: 100 }), { now: () => PROMO, store });
    expect(guard2.effectiveSessionCapSeconds).toBe(900);
    guard2.updateLimits({ maxSessionSeconds: 120 });
    expect(guard2.effectiveSessionCapSeconds).toBe(120);
    guard2.addChunk(120);
    expect(guard2.evaluate().reason).toBe('session-cap-seconds');
    // the next session declares its own ceiling; the last one must not linger
    guard2.beginSession();
    expect(guard2.effectiveSessionCapSeconds).toBe(900);
  });

  it('re-reads the caps when they are edited after construction', () => {
    const live = new BudgetGuard(limits({ sessionCapSeconds: 900, sessionCapUsd: 100 }), { now: () => PROMO, store });
    live.addChunk(30);
    expect(live.evaluate().ok).toBe(true);
    // the user picks the low preset mid-run: the shorter cap must take hold
    live.updateLimits({ sessionCapSeconds: 30 });
    expect(live.effectiveSessionCapSeconds).toBe(30);
    expect(live.evaluate().reason).toBe('session-cap-seconds');
    live.updateLimits({ sessionCapSeconds: 900, sessionCapUsd: 0.5 });
    expect(live.evaluate().reason).toBe('session-cap-usd');
  });

  it('counts orbit takes on their own meter', () => {
    guard.addChunk(60);            // $1.20
    guard.addAngleTake();          // $0.0625
    guard.addAngleTake();
    expect(guard.sessionUsd).toBeCloseTo(1.325);
    expect(guard.remainingSessionUsd).toBeCloseTo(3.675);
  });

  it('refuses an orbit take that would break the cap', () => {
    const tight = new BudgetGuard(limits({ sessionCapUsd: 5, sessionCapSeconds: 10000, angleResolution: '1080P', angleSecondsPerTake: 15 }), {
      now: () => LIST, store,
    });
    tight.addChunk(100);           // $8 at list -> already over
    const verdict = tight.checkBeforeAngleTake();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('session-cap-usd');
  });

  it('folds session spend into the day and persists it', () => {
    guard.addChunk(120);
    expect(guard.commitSession()).toBeCloseTo(2.4);
    expect(store.value).toBeCloseTo(2.4);
    guard.beginSession();
    expect(guard.sessionUsd).toBe(0);
    expect(guard.todayUsd).toBeCloseTo(2.4);
  });

  it('stops a new session once the daily cap is reached', () => {
    const spender = new BudgetGuard(limits({ dailyCapUsd: 3 }), { now: () => PROMO, store });
    spender.addChunk(120);
    spender.commitSession();       // $2.40 of the $3 day
    spender.beginSession();
    expect(spender.checkBeforeSession().ok).toBe(true);
    spender.addChunk(60);          // +$1.20 -> $3.60 today
    spender.commitSession();
    spender.beginSession();
    const verdict = spender.checkBeforeSession();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('daily-cap');
  });

  it('reports what is left, never negative', () => {
    const tiny = new BudgetGuard(limits({ sessionCapUsd: 0.5, dailyCapUsd: 1 }), { now: () => PROMO, store });
    tiny.addChunk(120);
    expect(tiny.remainingSessionUsd).toBe(0);
    expect(tiny.remainingTodayUsd).toBe(1);
  });

  it('spends nothing and blocks nothing in a dry run', () => {
    const dry = new BudgetGuard(limits({ dryRun: true, sessionCapUsd: 0.0001, sessionCapSeconds: 1 }), { now: () => PROMO, store });
    for (let i = 0; i < 100; i++) dry.addChunk(10);
    expect(dry.sessionUsd).toBe(0);
    expect(dry.evaluate().ok).toBe(true);
    expect(dry.checkBeforeSession().ok).toBe(true);
    expect(dry.checkBeforeAngleTake().ok).toBe(true);
    expect(dry.commitSession()).toBe(0);
    expect(store.value).toBe(0);
  });

  it('resets the session counters without touching the day', () => {
    guard.addChunk(120);
    guard.commitSession();
    guard.beginSession();
    guard.addChunk(10);
    expect(guard.sessionUsd).toBeCloseTo(0.2);
    expect(guard.todayUsd).toBeCloseTo(2.4);
  });

  it('reset() clears everything including the stored day', () => {
    guard.addChunk(120);
    guard.commitSession();
    guard.reset();
    expect(guard.todayUsd).toBe(0);
    expect(store.value).toBe(0);
  });

  it('ignores a negative chunk rather than refunding', () => {
    guard.addChunk(-100);
    expect(guard.sessionDirectorSeconds).toBe(0);
    expect(guard.sessionUsd).toBe(0);
  });
});
