// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { GitStatus } from '../../models/index.js';
import { asContainerId } from '../../models/index.js';
import { devContainer } from '../test-fixtures.js';
import { fakeApi } from './test-api.js';
import { stubNotices } from './test-notices.js';
import { useGitStatus } from './useGitStatus.js';

const RUNNING = devContainer({ id: asContainerId('a'.repeat(64)) });
const STOPPED = devContainer({
  id: asContainerId('c'.repeat(64)),
  runtime: { state: 'exited', exitCode: 0, finishedAt: new Date('2026-07-27T09:00:00Z') },
});

const ON_MAIN: GitStatus = { kind: 'branch', branch: 'main' };

describe('useGitStatus', () => {
  it('returns nothing and calls nothing without a preload bridge', () => {
    const notices = stubNotices();
    const { result } = renderHook(() => useGitStatus(undefined, notices, [RUNNING]));

    expect(result.current.statuses).toEqual({});
    expect(notices.showError).not.toHaveBeenCalled();
  });

  it('takes a reading immediately rather than waiting out the first interval', async () => {
    const api = fakeApi({ git: ON_MAIN });
    const notices = stubNotices();
    const { result } = renderHook(() => useGitStatus(api, notices, [RUNNING]));

    await waitFor(() => {
      expect(result.current.statusFor(RUNNING.id)).toEqual(ON_MAIN);
    });
  });

  /**
   * The difference from `useClaudeStatus`, and the reason it is worth a test:
   * there is no process table involved. The folder is on disk whether the
   * container is running or not, and "which branch was that stopped one on?"
   * is exactly the question asked before starting it.
   */
  it('asks about stopped containers too', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    renderHook(() => useGitStatus(api, notices, [RUNNING, STOPPED]));

    await waitFor(() => {
      expect(api.gitStatus).toHaveBeenCalledWith([RUNNING.id, STOPPED.id]);
    });
  });

  it('does not call at all when there are no containers', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    renderHook(() => useGitStatus(api, notices, []));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.gitStatus).not.toHaveBeenCalled();
  });

  /** A rebuilt list must not make the poll restart — see the note on `allKey`. */
  it('does not re-ask when the container array is rebuilt with the same ids', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    const { rerender } = renderHook(({ containers }) => useGitStatus(api, notices, containers), {
      initialProps: { containers: [RUNNING] },
    });

    await waitFor(() => {
      expect(api.gitStatus).toHaveBeenCalledTimes(1);
    });

    rerender({ containers: [{ ...RUNNING }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.gitStatus).toHaveBeenCalledTimes(1);
  });

  it('reports a failed read through the notices rather than a second channel', async () => {
    const api = fakeApi();
    api.gitStatus.mockRejectedValue(new Error('EPERM'));
    const notices = stubNotices();
    renderHook(() => useGitStatus(api, notices, [RUNNING]));

    await waitFor(() => {
      expect(notices.showError).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
    });
  });

  /**
   * Losing every chip for a beat because one poll failed would be a worse lie
   * than a stale branch: a card with no chip reads as "not a checkout".
   */
  it('keeps the last known branches when a later poll fails', async () => {
    const api = fakeApi({ git: ON_MAIN });
    const notices = stubNotices();
    const { result } = renderHook(() => useGitStatus(api, notices, [RUNNING]));

    await waitFor(() => {
      expect(result.current.statusFor(RUNNING.id)).toEqual(ON_MAIN);
    });

    api.gitStatus.mockRejectedValue(new Error('gone'));
    result.current.refresh();

    await waitFor(() => {
      expect(notices.showError).toHaveBeenCalled();
    });
    expect(result.current.statusFor(RUNNING.id)).toEqual(ON_MAIN);
  });

  it('drops containers that have left the list', async () => {
    const api = fakeApi({ git: ON_MAIN });
    const notices = stubNotices();
    const { result, rerender } = renderHook(
      ({ containers }) => useGitStatus(api, notices, containers),
      { initialProps: { containers: [RUNNING, STOPPED] } },
    );

    await waitFor(() => {
      expect(result.current.statusFor(STOPPED.id)).toEqual(ON_MAIN);
    });

    rerender({ containers: [RUNNING] });
    expect(result.current.statusFor(STOPPED.id)).toBeUndefined();
    expect(result.current.statusFor(RUNNING.id)).toEqual(ON_MAIN);
  });
});
