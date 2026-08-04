// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Advice, AdviceSeverity } from '../../models/index.js';
import { useAdvisories } from './useAdvisories.js';

function advice(id: string, severity: AdviceSeverity = 'info'): Advice {
  return { id, severity, title: id, body: 'why', commands: [], links: [] };
}

const ADVICE = [advice('wsl-socat-missing', 'warning'), advice('docker-cli-missing')];

beforeEach(() => {
  window.localStorage.clear();
});

describe('useAdvisories', () => {
  it('shows everything until the user hides something', () => {
    const { result } = renderHook(() => useAdvisories(ADVICE));
    expect(result.current.active).toHaveLength(2);
    expect(result.current.hidden).toHaveLength(0);
    expect(result.current.badge.count).toBe(2);
  });

  it('moves a hidden advisory across rather than dropping it', () => {
    const { result } = renderHook(() => useAdvisories(ADVICE));
    act(() => {
      result.current.hide('docker-cli-missing');
    });

    expect(result.current.active.map((entry) => entry.id)).toEqual(['wsl-socat-missing']);
    expect(result.current.hidden.map((entry) => entry.id)).toEqual(['docker-cli-missing']);
    // The whole list is still computed and still reachable — hiding is a
    // rendering decision, never a deletion.
    expect(result.current.all).toHaveLength(2);
  });

  it('puts one back', () => {
    const { result } = renderHook(() => useAdvisories(ADVICE));
    act(() => {
      result.current.hide('docker-cli-missing');
    });
    act(() => {
      result.current.restore('docker-cli-missing');
    });
    expect(result.current.active).toHaveLength(2);
    expect(result.current.hidden).toHaveLength(0);
  });

  it('puts all of them back at once', () => {
    const { result } = renderHook(() => useAdvisories(ADVICE));
    act(() => {
      result.current.hide('docker-cli-missing');
      result.current.hide('wsl-socat-missing');
    });
    expect(result.current.active).toHaveLength(0);

    act(() => {
      result.current.restoreAll();
    });
    expect(result.current.active).toHaveLength(2);
  });

  /**
   * The functional-update case. Two Hide clicks in one tick both computed from
   * the pre-click list would leave the second one's advisory on screen.
   */
  it('keeps both when two are hidden in the same tick', () => {
    const { result } = renderHook(() => useAdvisories(ADVICE));
    act(() => {
      result.current.hide('docker-cli-missing');
      result.current.hide('wsl-socat-missing');
    });
    expect(result.current.hidden).toHaveLength(2);
  });

  it('remembers what was hidden across a reload', () => {
    const first = renderHook(() => useAdvisories(ADVICE));
    act(() => {
      first.result.current.hide('docker-cli-missing');
    });
    first.unmount();

    const second = renderHook(() => useAdvisories(ADVICE));
    expect(second.result.current.hidden.map((entry) => entry.id)).toEqual(['docker-cli-missing']);
  });

  /**
   * The condition behind an advisory comes and goes — a distro is started, an
   * engine is restarted. Forgetting the dismissal while the advisory happens
   * not to fire would bring it back the next time it did.
   */
  it('keeps a dismissal for an advisory that is not firing this scan', () => {
    const first = renderHook(() => useAdvisories(ADVICE));
    act(() => {
      first.result.current.hide('docker-cli-missing');
    });
    first.unmount();

    // A healthy scan: nothing to advise about at all.
    const healthy = renderHook(() => useAdvisories([]));
    expect(healthy.result.current.hidden).toHaveLength(0);
    healthy.unmount();

    const backAgain = renderHook(() => useAdvisories(ADVICE));
    expect(backAgain.result.current.active.map((entry) => entry.id)).toEqual(['wsl-socat-missing']);
  });

  describe('navigation', () => {
    it('starts on the container list', () => {
      const { result } = renderHook(() => useAdvisories(ADVICE));
      expect(result.current.page).toBe('containers');
    });

    it('goes to the setup page and back', () => {
      const { result } = renderHook(() => useAdvisories(ADVICE));
      act(() => {
        result.current.navigate('setup');
      });
      expect(result.current.page).toBe('setup');

      act(() => {
        result.current.navigate('containers');
      });
      expect(result.current.page).toBe('containers');
    });

    /**
     * Hiding the last advisory must not strand the user on a page that has
     * just emptied, and must not move them off one they navigated to. The two
     * are independent; only the counts change.
     */
    it('does not navigate on its own when the last advisory is hidden', () => {
      const { result } = renderHook(() => useAdvisories([advice('docker-cli-missing')]));
      act(() => {
        result.current.navigate('setup');
      });
      act(() => {
        result.current.hide('docker-cli-missing');
      });
      expect(result.current.page).toBe('setup');
      expect(result.current.badge.count).toBe(0);
      expect(result.current.hidden).toHaveLength(1);
    });
  });

  /**
   * The callbacks are handed to Views as `onClick` props, and `active` is
   * consumed by a memoised list. A fresh identity every render defeats both.
   */
  it('keeps its callbacks and its partition stable across renders', () => {
    const { result, rerender } = renderHook(() => useAdvisories(ADVICE));
    const before = {
      hide: result.current.hide,
      restore: result.current.restore,
      navigate: result.current.navigate,
      active: result.current.active,
    };
    rerender();
    expect(result.current.hide).toBe(before.hide);
    expect(result.current.restore).toBe(before.restore);
    expect(result.current.navigate).toBe(before.navigate);
    expect(result.current.active).toBe(before.active);
  });
});
