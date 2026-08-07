// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { BranchListing } from '../../models/index.js';
import { asContainerId } from '../../models/index.js';
import { fakeApi } from './test-api.js';
import { stubNotices } from './test-notices.js';
import { useBranches } from './useBranches.js';

const A = asContainerId('a'.repeat(64));
const B = asContainerId('b'.repeat(64));

const CLEAN: BranchListing = {
  kind: 'ready',
  tree: { kind: 'clean' },
  branches: [
    { name: 'main', current: true },
    { name: 'feature/dark-theme', current: false },
  ],
};

describe('useBranches', () => {
  it('does nothing at all without a preload bridge', () => {
    const notices = stubNotices();
    const { result } = renderHook(() => useBranches(undefined, notices, vi.fn()));

    act(() => {
      result.current.toggle(A);
    });

    // The menu still opens — it is renderer state — and reports that it could
    // not be filled rather than sitting on "Reading branches…" forever.
    expect(result.current.openFor).toBe(A);
    expect(notices.showError).not.toHaveBeenCalled();
  });

  it('loads the listing when a menu is opened, and only then', async () => {
    const api = fakeApi({ branches: CLEAN });
    const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

    expect(api.listBranches).not.toHaveBeenCalled();

    act(() => {
      result.current.toggle(A);
    });

    await waitFor(() => {
      expect(result.current.listing).toEqual(CLEAN);
    });
    expect(api.listBranches).toHaveBeenCalledWith(A);
  });

  it('closes when the same chip is clicked again', async () => {
    const api = fakeApi({ branches: CLEAN });
    const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

    act(() => {
      result.current.toggle(A);
    });
    await waitFor(() => {
      expect(result.current.listing).toEqual(CLEAN);
    });

    act(() => {
      result.current.toggle(A);
    });

    expect(result.current.openFor).toBeUndefined();
    // Discarded rather than cached: a listing goes stale the moment the user
    // runs git in a terminal, which is the machine this app is for.
    expect(result.current.listing).toBeUndefined();
  });

  /**
   * The bug this hook's `wanted` ref exists for. `listBranches` spawns git, so
   * opening one card's menu and then another's leaves two calls in flight; if
   * the first resolves last, card B renders card A's branches — a wrong answer
   * that looks exactly like a right one.
   */
  it('ignores a listing that arrives after the menu moved to another card', async () => {
    const api = fakeApi();
    const slow: BranchListing = { ...CLEAN, branches: [{ name: 'stale', current: true }] };
    const fast: BranchListing = { ...CLEAN, branches: [{ name: 'fresh', current: true }] };

    let releaseSlow = (): void => undefined;
    api.listBranches.mockImplementationOnce(
      () =>
        new Promise<BranchListing>((resolve) => {
          releaseSlow = () => {
            resolve(slow);
          };
        }),
    );
    api.listBranches.mockImplementationOnce(() => Promise.resolve(fast));

    const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

    act(() => {
      result.current.toggle(A);
    });
    act(() => {
      result.current.toggle(B);
    });

    await waitFor(() => {
      expect(result.current.listing).toEqual(fast);
    });

    await act(async () => {
      releaseSlow();
      await Promise.resolve();
    });

    expect(result.current.openFor).toBe(B);
    expect(result.current.listing).toEqual(fast);
  });

  it('never shows one card the listing of another, even for a frame', async () => {
    const api = fakeApi({ branches: CLEAN });
    const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

    act(() => {
      result.current.toggle(A);
    });
    await waitFor(() => {
      expect(result.current.listing).toEqual(CLEAN);
    });

    act(() => {
      result.current.toggle(B);
    });

    expect(result.current.openFor).toBe(B);
    expect(result.current.listing).toBeUndefined();
  });

  it('reports a failed listing inside the menu, not in the notice bar', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    api.listBranches.mockRejectedValueOnce(new Error('git exited 128'));

    const { result } = renderHook(() => useBranches(api, notices, vi.fn()));

    act(() => {
      result.current.toggle(A);
    });

    await waitFor(() => {
      expect(result.current.listing).toEqual({ kind: 'unavailable', reason: 'git exited 128' });
    });
    // Opening a menu is not an action that failed — the answer belongs in the
    // box the user is already looking at.
    expect(notices.showError).not.toHaveBeenCalled();
  });

  it('closes and refreshes the branch poll when a switch lands', async () => {
    const api = fakeApi({ branches: CLEAN });
    const onSwitched = vi.fn();
    const { result } = renderHook(() => useBranches(api, stubNotices(), onSwitched));

    act(() => {
      result.current.toggle(A);
    });
    await waitFor(() => {
      expect(result.current.listing).toEqual(CLEAN);
    });

    await act(async () => {
      result.current.switchTo(A, 'feature/dark-theme');
      await Promise.resolve();
    });

    expect(api.switchBranch).toHaveBeenCalledWith(A, 'feature/dark-theme');
    await waitFor(() => {
      expect(result.current.openFor).toBeUndefined();
    });
    // The join with `useGitStatus`: the chip re-reads now rather than in up to
    // thirty seconds.
    expect(onSwitched).toHaveBeenCalled();
  });

  /**
   * A refusal is data, not an exception, and the message is the sentence the
   * models layer wrote. The menu stays OPEN behind it because the user's next
   * move is usually a different branch.
   */
  it('shows a refusal and leaves the menu open', async () => {
    const api = fakeApi({ branches: CLEAN });
    const notices = stubNotices();
    api.switchBranch.mockResolvedValueOnce({
      ok: false,
      message: 'The workspace has 3 uncommitted changes.',
    });

    const { result } = renderHook(() => useBranches(api, notices, vi.fn()));

    act(() => {
      result.current.toggle(A);
    });
    await waitFor(() => {
      expect(result.current.listing).toEqual(CLEAN);
    });

    await act(async () => {
      result.current.switchTo(A, 'feature/dark-theme');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(notices.showError).toHaveBeenCalledWith('The workspace has 3 uncommitted changes.');
    });
    expect(result.current.openFor).toBe(A);
  });

  it('will not run two checkouts at once', () => {
    const api = fakeApi({ branches: CLEAN });
    api.switchBranch.mockImplementation(() => new Promise(() => undefined));

    const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

    act(() => {
      result.current.toggle(A);
    });
    act(() => {
      result.current.switchTo(A, 'feature/dark-theme');
    });
    act(() => {
      result.current.switchTo(A, 'main');
    });

    expect(api.switchBranch).toHaveBeenCalledTimes(1);
  });

  describe('bindingFor', () => {
    it('hands the listing only to the card whose menu is open', async () => {
      const api = fakeApi({ branches: CLEAN });
      const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

      act(() => {
        result.current.toggle(A);
      });
      await waitFor(() => {
        expect(result.current.listing).toEqual(CLEAN);
      });

      expect(result.current.bindingFor(A)).toMatchObject({ open: true, listing: CLEAN });
      expect(result.current.bindingFor(B)).toMatchObject({ open: false, listing: undefined });
    });

    it('binds each card to its own id', () => {
      const api = fakeApi({ branches: CLEAN });
      const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

      act(() => {
        result.current.bindingFor(B).onToggle();
      });

      expect(result.current.openFor).toBe(B);
      expect(api.listBranches).toHaveBeenCalledWith(B);
    });
  });

  it('closes on Escape', async () => {
    const api = fakeApi({ branches: CLEAN });
    const { result } = renderHook(() => useBranches(api, stubNotices(), vi.fn()));

    act(() => {
      result.current.toggle(A);
    });
    await waitFor(() => {
      expect(result.current.listing).toEqual(CLEAN);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(result.current.openFor).toBeUndefined();
  });
});
