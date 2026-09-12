import { describe, expect, it } from 'vitest';
import { BLOT_MARKS, MIN_INK_COVERAGE } from './ink/recipe';
import { MOOD_IDS } from './presets/moods';
import { defaultLabState, loadLabState, measure, recipeFor, saveLabState, type LabState } from './lab';

/**
 * What the lab's page is built on: the batch has to come out of the engine the
 * studio uses, and it has to come out the *same* after a code change is saved
 * and the page reloaded - a lab that rolls new blots on every reload can never
 * show whether an edit helped.
 */
function withState(patch: Partial<LabState>): LabState {
  return { ...defaultLabState(), ...patch };
}

describe('the blot lab', () => {
  it('asks the engine for the studio\'s own blot', () => {
    const state = withState({ aspect: '1:1', moodId: 'serene', wetness: 0.5, bleed: 0.2, grain: 0.1 });
    const recipe = recipeFor(state, 4242);
    expect(recipe.canvas.width).toBe(recipe.canvas.height);
    expect(recipe.wetness).toBe(0.5);
    expect(recipe.bleed).toBe(0.2);
    expect(recipe.grain).toBe(0.1);
    expect(recipe.tools).toEqual(['pool', 'curve', 'drop', 'backrun']);
  });

  it('takes the creases it was asked for off the engine\'s own plan', () => {
    const auto = recipeFor(withState({}), 77).folds;
    expect(recipeFor(withState({ folds: 'none' }), 77).folds).toEqual([]);
    const two = recipeFor(withState({ folds: 2 }), 77).folds;
    expect(two).toEqual(auto.slice(0, 2));
  });

  it('gives the same blot back for the same seed', () => {
    const state = withState({ seeds: [1, 2, 3] });
    expect(JSON.stringify(measure(state, 99).recipe)).toBe(JSON.stringify(measure(state, 99).recipe));
  });

  it('measures a full blot from every mood', () => {
    for (const moodId of MOOD_IDS) {
      for (let seed = 1; seed <= 40; seed++) {
        const measurement = measure(withState({ moodId }), seed * 7919);
        expect(measurement.ops.length).toBeGreaterThanOrEqual(1);
        expect(measurement.ops.length).toBeLessThanOrEqual(BLOT_MARKS);
        expect(measurement.coverage).toBeGreaterThanOrEqual(MIN_INK_COVERAGE - 0.001);
        expect(measurement.tools.reduce((sum, entry) => sum + entry.count, 0)).toBe(measurement.ops.length);
      }
    }
  });

  it('reads a stored batch back, clamping what a hand-edited payload can say', () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    expect(loadLabState(storage).count).toBe(9);
    saveLabState(withState({ seeds: [7, 8], count: 2, folds: 'none', wetness: 0.35 }), storage);
    const restored = loadLabState(storage);
    expect(restored).toMatchObject({ seeds: [7, 8], count: 2, folds: 'none', wetness: 0.35 });
    stored.set('inkfilm.lab.v1', JSON.stringify({ count: 900, seeds: ['nope'], folds: 99, aspect: '4:3' }));
    const clamped = loadLabState(storage);
    expect(clamped.count).toBe(24);
    expect(clamped.seeds).toHaveLength(9);
    expect(clamped.folds).toBe(7);
    expect(clamped.aspect).toBe('16:9');
  });
});
