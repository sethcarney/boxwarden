import { describe, expect, it } from 'vitest';
import type { Advice, AdviceSeverity } from '../models/index.js';
import {
  parseHiddenAdvice,
  partitionAdvice,
  setupBadge,
  setupSummary,
  startsExpanded,
  withHidden,
  withoutHidden,
} from './advisories.js';

function advice(id: string, severity: AdviceSeverity = 'info'): Advice {
  return { id, severity, title: id, body: '', commands: [], links: [] };
}

describe('partitionAdvice', () => {
  it('splits what the user put away from what is still on screen', () => {
    const all = [advice('a'), advice('b'), advice('c')];
    const { active, hidden } = partitionAdvice(all, ['b']);
    expect(active.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(hidden.map((entry) => entry.id)).toEqual(['b']);
  });

  /**
   * `adviseEnvironment` emits most urgent first. Re-ordering here would
   * silently disagree with it — the setup page would rank a note above a
   * blocking error.
   */
  it('keeps the order the advice arrived in', () => {
    const all = [advice('a', 'error'), advice('b'), advice('c', 'warning')];
    expect(partitionAdvice(all, []).active.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  /**
   * The hidden list outlives the condition that produced it: a stopped WSL
   * distro comes back, an engine is restarted. An id nothing currently matches
   * is not an error and must not throw the rest of the split off.
   */
  it('ignores hidden ids that no advisory carries this scan', () => {
    const { active, hidden } = partitionAdvice([advice('a')], ['gone', 'a']);
    expect(active).toEqual([]);
    expect(hidden.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('startsExpanded', () => {
  it('opens what is blocking and folds away what is merely true', () => {
    expect(startsExpanded('error')).toBe(true);
    expect(startsExpanded('warning')).toBe(true);
    expect(startsExpanded('info')).toBe(false);
  });
});

describe('setupBadge', () => {
  it('counts only what is still on the main screen', () => {
    const badge = setupBadge(partitionAdvice([advice('a'), advice('b')], ['b']));
    expect(badge.count).toBe(1);
  });

  it('takes its tone from the worst active advisory', () => {
    expect(setupBadge(partitionAdvice([advice('a', 'info'), advice('b', 'error')], [])).tone).toBe(
      'error',
    );
    expect(
      setupBadge(partitionAdvice([advice('a', 'info'), advice('b', 'warning')], [])).tone,
    ).toBe('warning');
    expect(setupBadge(partitionAdvice([], [])).tone).toBe('none');
  });

  /**
   * The one lie this feature could tell: a count of zero on a button behind
   * which four hidden warnings are sitting. The count stays honest about what
   * is active and the tooltip accounts for the rest.
   */
  it('says how many are hidden even though it does not count them', () => {
    const badge = setupBadge(partitionAdvice([advice('a'), advice('b')], ['a', 'b']));
    expect(badge.count).toBe(0);
    expect(badge.title).toContain('2 hidden');
  });

  it('says nothing about hidden advisories when there are none', () => {
    expect(setupBadge(partitionAdvice([advice('a')], [])).title).not.toContain('hidden');
  });
});

describe('setupSummary', () => {
  it('distinguishes a clean machine from one with everything hidden', () => {
    expect(setupSummary(partitionAdvice([], []))).toContain('nothing to advise');
    expect(setupSummary(partitionAdvice([advice('a')], ['a']))).toContain('hidden from the main');
  });
});

describe('withHidden / withoutHidden', () => {
  it('does not store an id twice when a button is clicked twice', () => {
    expect(withHidden(withHidden([], 'a'), 'a')).toEqual(['a']);
  });

  it('restores one without disturbing the others', () => {
    expect(withoutHidden(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});

describe('parseHiddenAdvice', () => {
  it('reads a stored list back', () => {
    expect(parseHiddenAdvice(['a', 'b'])).toEqual(['a', 'b']);
  });

  it.each([[undefined], [null], ['a'], [42], [{ a: true }]])(
    'treats %p as nothing hidden rather than failing',
    (raw) => {
      expect(parseHiddenAdvice(raw)).toEqual([]);
    },
  );

  it('drops non-string entries and duplicates from a hand-edited store', () => {
    expect(parseHiddenAdvice(['a', 7, 'a', null, 'b'])).toEqual(['a', 'b']);
  });
});
