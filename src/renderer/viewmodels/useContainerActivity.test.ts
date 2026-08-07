// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ClaudeStatus, DevContainer } from '../../models/index.js';
import { asContainerId } from '../../models/index.js';
import { devContainer } from '../test-fixtures.js';
import { fakeApi } from './test-api.js';
import { stubNotices } from './test-notices.js';
import { ACTIVITY_INTERVAL_MS, useContainerActivity } from './useContainerActivity.js';

const RUNNING = devContainer({ id: asContainerId('a'.repeat(64)) });
const ALSO_RUNNING = devContainer({ id: asContainerId('b'.repeat(64)) });
const STOPPED = devContainer({
  id: asContainerId('c'.repeat(64)),
  runtime: { state: 'exited', exitCode: 0, finishedAt: new Date('2026-07-27T09:00:00Z') },
});

const SESSION: ClaudeStatus = {
  kind: 'running',
  sessions: [{ pid: 412, command: 'claude', activity: { kind: 'idle' }, elapsed: '1h12m33.0s' }],
};

describe('useClaudeStatus', () => {
  it('returns nothing and calls nothing without a preload bridge', () => {
    const notices = stubNotices();
    const { result } = renderHook(() => useContainerActivity(undefined, notices, [RUNNING]));

    expect(result.current.statuses).toEqual({});
    expect(notices.showError).not.toHaveBeenCalled();
  });

  it('takes a reading immediately rather than waiting out the first interval', async () => {
    const api = fakeApi({ claude: SESSION });
    const notices = stubNotices();
    const { result } = renderHook(() => useContainerActivity(api, notices, [RUNNING]));

    await waitFor(() => {
      expect(result.current.claudeFor(RUNNING.id)).toEqual(SESSION);
    });
  });

  /**
   * The reason this poll exists separately from discovery: `top` is one Docker
   * call per container, and a stopped container has no process table to read.
   */
  it('asks only about containers that are live', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    renderHook(() => useContainerActivity(api, notices, [RUNNING, STOPPED]));

    await waitFor(() => {
      expect(api.containerActivity).toHaveBeenCalledWith([RUNNING.id]);
    });
  });

  it('does not call at all when nothing is live', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    renderHook(() => useContainerActivity(api, notices, [STOPPED]));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.containerActivity).not.toHaveBeenCalled();
  });

  /**
   * `containers` is a fresh array on every discovery poll — every five seconds.
   * If this hook depended on its identity rather than its contents it would
   * restart its effect three times per tick and never reach its own cadence.
   */
  it('does not re-poll when the container list is rebuilt with the same ids', async () => {
    const api = fakeApi({ claude: SESSION });
    const notices = stubNotices();

    const { rerender } = renderHook(
      ({ containers }: { containers: readonly DevContainer[] }) =>
        useContainerActivity(api, notices, containers),
      { initialProps: { containers: [RUNNING] as readonly DevContainer[] } },
    );
    await waitFor(() => {
      expect(api.containerActivity).toHaveBeenCalledTimes(1);
    });

    // A new array, same contents — what discovery hands over every 5s.
    rerender({ containers: [devContainer({ id: asContainerId('a'.repeat(64)) })] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(api.containerActivity).toHaveBeenCalledTimes(1);
  });

  it('polls again when a container starts', async () => {
    const api = fakeApi({ claude: SESSION });
    const notices = stubNotices();

    const { rerender } = renderHook(
      ({ containers }: { containers: readonly DevContainer[] }) =>
        useContainerActivity(api, notices, containers),
      { initialProps: { containers: [RUNNING] as readonly DevContainer[] } },
    );
    await waitFor(() => {
      expect(api.containerActivity).toHaveBeenCalledTimes(1);
    });

    rerender({ containers: [RUNNING, ALSO_RUNNING] });
    await waitFor(() => {
      expect(api.containerActivity).toHaveBeenCalledWith([RUNNING.id, ALSO_RUNNING.id]);
    });
  });

  /**
   * A container that leaves the list takes its badge with it — otherwise a
   * long-lived window accumulates statuses for containers removed hours ago.
   */
  it('drops the status of a container that has left the list', async () => {
    const api = fakeApi({ claude: SESSION });
    const notices = stubNotices();

    const { result, rerender } = renderHook(
      ({ containers }: { containers: readonly DevContainer[] }) =>
        useContainerActivity(api, notices, containers),
      { initialProps: { containers: [RUNNING, ALSO_RUNNING] as readonly DevContainer[] } },
    );
    await waitFor(() => {
      expect(Object.keys(result.current.statuses)).toHaveLength(2);
    });

    rerender({ containers: [RUNNING] });
    expect(Object.keys(result.current.statuses)).toEqual([RUNNING.id]);
  });

  it('reports a failed check through notices, without clearing what it had', async () => {
    const api = fakeApi({ claude: SESSION });
    const notices = stubNotices();

    const { result, rerender } = renderHook(
      ({ containers }: { containers: readonly DevContainer[] }) =>
        useContainerActivity(api, notices, containers),
      { initialProps: { containers: [RUNNING] as readonly DevContainer[] } },
    );
    await waitFor(() => {
      expect(result.current.claudeFor(RUNNING.id)).toEqual(SESSION);
    });

    api.containerActivity.mockRejectedValueOnce(new Error('socket went away'));
    rerender({ containers: [RUNNING, ALSO_RUNNING] });

    await waitFor(() => {
      expect(notices.showError).toHaveBeenCalledWith(expect.stringContaining('socket went away'));
    });
    // A failed poll must not blank the badge: losing it would make the Stop
    // button look safe for a container that has an agent in it.
    expect(result.current.claudeFor(RUNNING.id)).toEqual(SESSION);
  });

  /** What ComposeGroup's "Stop all" aggregates, in the group's own order. */
  it('reports a whole group in order, with a gap for anything unpolled', async () => {
    const api = fakeApi({ claude: SESSION });
    const notices = stubNotices();

    const { result } = renderHook(() => useContainerActivity(api, notices, [RUNNING, STOPPED]));
    await waitFor(() => {
      expect(result.current.claudeFor(RUNNING.id)).toEqual(SESSION);
    });

    // STOPPED was never asked about, so it has no entry — which is not the
    // same as `{ kind: 'none' }` and must not be flattened into it.
    expect(result.current.claudeForAll([RUNNING, STOPPED])).toEqual([SESSION, undefined]);
  });

  describe('cadence', () => {
    /**
     * The interval is a parameter so these run on real timers with a tiny one.
     * Vitest's fake timers also fake `queueMicrotask`, which React's scheduler
     * is built on, and `act()` then deadlocks against a queue nothing drains —
     * the symptom is a test that times out rather than fails.
     */
    const TICK_MS = 20;
    const afterATick = () => new Promise((resolve) => setTimeout(resolve, TICK_MS * 3));

    it('is slower than the discovery poll by default', () => {
      // Discovery runs at 5s. This costs one `top` per live container and
      // re-derives an answer that changes when a person starts an agent.
      expect(ACTIVITY_INTERVAL_MS).toBeGreaterThan(5_000);
    });

    it('keeps polling on its own interval', async () => {
      const api = fakeApi({ claude: SESSION });
      const notices = stubNotices();
      renderHook(() => useContainerActivity(api, notices, [RUNNING], TICK_MS));

      await waitFor(() => {
        expect(api.containerActivity.mock.calls.length).toBeGreaterThan(2);
      });
    });

    /**
     * The discovery poll runs regardless of focus, because the container list
     * is what a user comes back to look at. This one guards a click, and a
     * hidden window has no clicks in it.
     */
    it('skips the tick while the window is hidden, and reads again on return', async () => {
      const api = fakeApi({ claude: SESSION });
      const notices = stubNotices();
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

      renderHook(() => useContainerActivity(api, notices, [RUNNING], TICK_MS));

      // The initial reading is unconditional — the window may have been hidden
      // since before the app rendered, and the first paint still needs data.
      await waitFor(() => {
        expect(api.containerActivity).toHaveBeenCalledTimes(1);
      });

      await afterATick();
      expect(api.containerActivity).toHaveBeenCalledTimes(1);

      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => {
        expect(api.containerActivity).toHaveBeenCalledTimes(2);
      });

      hidden.mockRestore();
    });
  });
});
