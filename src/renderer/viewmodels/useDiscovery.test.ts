// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DevContainer, EngineId } from '../../models/index.js';
import type { ActionResult } from '../../shared/ipc.js';
import { devContainer } from '../test-fixtures.js';
import { stubNotices } from './test-notices.js';
import { fakeApi, snapshot, unreachableSnapshot } from './test-api.js';
import { REFRESH_INTERVAL_MS, useDiscovery } from './useDiscovery.js';

/**
 * The Docker ViewModel, driven with no DOM beyond what `renderHook` needs and
 * no Docker at all. Everything asserted here used to live inside App.tsx, where
 * reaching it meant mounting the whole application.
 */

const running = devContainer();

const stopped = devContainer({
  id: devContainer().id,
  runtime: { state: 'exited', exitCode: 0, finishedAt: new Date('2026-08-01T11:00:00Z') },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useDiscovery', () => {
  it('takes a reading immediately, so the first paint is not an empty list', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));

    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });
    expect(result.current.loading).toBe(false);
    expect(api.discover).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected discover instead of showing an empty list', async () => {
    const api = fakeApi();
    api.discover.mockRejectedValue(new Error('socket gone'));
    const notices = stubNotices();

    renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));

    await waitFor(() => {
      expect(notices.showThrown).toHaveBeenCalled();
    });
  });

  /**
   * The busy set is what stops a card from looking actionable mid-stop, and the
   * re-read afterwards is what stops the row from showing the state we hoped
   * for rather than the one Docker reports.
   */
  it('marks a container busy for the duration of a start, then re-reads', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [stopped] }) });
    const gate = deferred<ActionResult>();
    api.start.mockReturnValue(gate.promise);

    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    act(() => {
      result.current.start(stopped);
    });
    await waitFor(() => {
      expect(result.current.isBusy(stopped.id)).toBe(true);
    });
    expect(result.current.anyBusy).toBe(true);

    await act(async () => {
      gate.resolve({ ok: true });
      await gate.promise;
    });

    await waitFor(() => {
      expect(result.current.isBusy(stopped.id)).toBe(false);
    });
    expect(api.discover).toHaveBeenCalledTimes(2);
  });

  /**
   * Stopping a container closes the editor window attached to it first, and
   * that half has to be VISIBLE — a Stop that silently failed to close a window
   * is indistinguishable from one that had no window to close.
   */
  it('reports the editor window a stop closed', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    api.stop.mockResolvedValue({
      ok: true,
      windows: { kind: 'closed', windows: 1, editors: ['vscode'] },
    });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.stop(running);
      await vi.waitFor(() => {
        expect(notices.showInfo).toHaveBeenCalledWith(
          expect.stringContaining('Closed the VS Code window') as unknown as string,
        );
      });
    });
  });

  /**
   * The arm that matters most: an editor IS attached and its window was not
   * found, so the user has been left with exactly the stranded window this
   * feature promised to close. It reports as an ERROR, not as silence.
   */
  it('reports an attached window it could not find', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    api.stop.mockResolvedValue({ ok: true, windows: { kind: 'not-found', editors: ['cursor'] } });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.stop(running);
      await vi.waitFor(() => {
        expect(notices.showError).toHaveBeenCalledWith(
          expect.stringContaining('could not find its window') as unknown as string,
        );
      });
    });
  });

  /**
   * A refused stop already reports its own message through `withBusy`. A second
   * notice about the same click would push the first one off the bar, which is
   * why `windowClosureNotice` stays quiet on this arm.
   */
  it('does not add a second notice when the stop was refused over an open window', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    api.stop.mockResolvedValue({
      ok: false,
      message: 'The editor window would not close — unsaved changes.',
      windows: { kind: 'still-open', windows: 1 },
    });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.stop(running);
      await vi.waitFor(() => {
        expect(notices.showError).toHaveBeenCalledTimes(1);
      });
    });
    expect(notices.showError).toHaveBeenCalledWith(
      'The editor window would not close — unsaved changes.',
    );
    expect(notices.showInfo).not.toHaveBeenCalled();
  });

  /** Nothing attached is the ordinary case, and it says nothing at all. */
  it('says nothing about windows when none was attached', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.stop(running);
      await vi.waitFor(() => {
        expect(api.stop).toHaveBeenCalled();
      });
    });
    expect(notices.showInfo).not.toHaveBeenCalled();
    expect(notices.showError).not.toHaveBeenCalled();
  });

  it('reports a lifecycle failure as a message rather than swallowing it', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [stopped] }) });
    api.start.mockResolvedValue({ ok: false, message: 'no such image' });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.start(stopped);
      await vi.waitFor(() => {
        expect(notices.showError).toHaveBeenCalledWith('no such image');
      });
    });
  });

  /**
   * `allSettled`, not `all`: one service failing to start must not abandon its
   * siblings half-started, and the failures are reported together.
   */
  it('starts every eligible member of a group and collects the failures', async () => {
    const a = devContainer({ name: 'db', runtime: stopped.runtime });
    const b = devContainer({ name: 'cache', runtime: stopped.runtime });
    const api = fakeApi({ snapshot: snapshot({ containers: [a, b] }) });
    api.start.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: false,
      message: 'port in use',
    });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(2);
    });

    await act(async () => {
      result.current.startAll([a, b]);
      await vi.waitFor(() => {
        expect(notices.showError).toHaveBeenCalled();
      });
    });

    expect(api.start).toHaveBeenCalledTimes(2);
    expect(notices.showError).toHaveBeenCalledWith(expect.stringContaining('1 of 2'));
    expect(notices.showError).toHaveBeenCalledWith(expect.stringContaining('port in use'));
  });

  /** A running container has nothing to start, so the group action is a no-op. */
  it('does not call start for a group whose members are all running', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    act(() => {
      result.current.startAll([running]);
    });
    expect(api.start).not.toHaveBeenCalled();
  });

  /**
   * Up to five seconds of showing containers from the engine the user just
   * switched away from would read as the setting having failed.
   */
  it('paints an engine change immediately and re-reads', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.snapshot).toBeDefined();
    });

    await act(async () => {
      result.current.selectEngine({ kind: 'only', id: 'unix:/var/run/docker.sock' as EngineId });
      await vi.waitFor(() => {
        expect(api.selectEngine).toHaveBeenCalled();
      });
    });

    await waitFor(() => {
      expect(api.discover).toHaveBeenCalledTimes(2);
    });
  });

  it('groups compose members together and leaves lone containers alone', async () => {
    const workspace = devContainer({
      name: 'ws',
      labels: { localFolderRaw: '/x', composeProject: 'app' },
    });
    const db = devContainer({
      name: 'db',
      labels: { localFolderRaw: '/x', composeProject: 'app' },
    });
    const lone = devContainer({ name: 'solo' });
    const api = fakeApi({ snapshot: snapshot({ containers: [workspace, db, lone] }) });

    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.groups).toHaveLength(2);
    });
    expect(result.current.groups[0]?.kind).toBe('compose');
    expect(result.current.groups[1]?.kind).toBe('single');
  });

  it('reports the engine as unreachable rather than pretending the list is complete', async () => {
    const api = fakeApi({ snapshot: unreachableSnapshot() });
    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));

    await waitFor(() => {
      expect(result.current.snapshot).toBeDefined();
    });
    expect(result.current.dockerOk).toBe(false);
    expect(result.current.engine?.label).toBe('No container engine');
  });

  /**
   * The default is FOCUS, not a new window, and it is the default all the way
   * down: the card omits the argument, the ViewModel supplies `reuse`, and the
   * CLI's own behaviour for a folder URI it already has open is to raise that
   * window. Getting this backwards would mean a second window every time
   * somebody clicked the card for a container they already had open.
   */
  it('asks to focus the existing window unless told otherwise', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    const { result } = renderHook(() => useDiscovery(api, stubNotices(), 'vscode', undefined));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.open(running as DevContainer);
      await vi.waitFor(() => {
        expect(api.openInEditor).toHaveBeenCalledWith(running.id, 'vscode', 'reuse');
      });
    });
  });

  it('asks for a second window only when the card says so', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', undefined));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.open(running as DevContainer, 'new-window');
      await vi.waitFor(() => {
        expect(api.openInEditor).toHaveBeenCalledWith(running.id, 'vscode', 'new-window');
      });
    });
    // Worded for what was asked for: "Opening webapp…" would read as a
    // duplicate having been created when one was only brought forward.
    expect(notices.showInfo).toHaveBeenCalledWith(
      expect.stringContaining('Opening a new window on'),
    );
  });

  it('keeps a failed open URI for the copy button', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [running] }) });
    api.openInEditor = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        code: 'launch-failed' as const,
        message: 'could not spawn code',
        uri: 'vscode-remote://dev-container+abc/workspaces/webapp',
      }),
    ) as unknown as typeof api.openInEditor;
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', 'gnome-terminal'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.open(running as DevContainer);
      await vi.waitFor(() => {
        expect(notices.rememberFallback).toHaveBeenCalledWith({
          label: 'Copy URI',
          value: 'vscode-remote://dev-container+abc/workspaces/webapp',
        });
      });
    });
    expect(notices.showError).toHaveBeenCalledWith('could not spawn code');
  });

  /**
   * The five-second poll is the most expensive thing this app does — a probe of
   * every candidate endpoint, then a list and an inspect per container, and on
   * Windows a pass through WSL discovery underneath all of it. Running it
   * against a minimised window is pure cost.
   */
  describe('while the window is hidden', () => {
    /**
     * `document.hidden` is a getter with no setter, so it is redefined on the
     * instance rather than assigned. Deleted again by the returned function,
     * which uncovers the prototype's own getter — leaving a jsdom global
     * patched leaks into whatever test runs next in this file.
     */
    function hide(hidden: boolean) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      return () => {
        // Reflect rather than `delete`: `Document.hidden` is readonly in the
        // DOM lib, so the operator is a type error even though the property is
        // an own, configurable one at runtime.
        Reflect.deleteProperty(document, 'hidden');
      };
    }

    /**
     * Fake timers, because the interval is a module constant: a real-time wait
     * short enough for a test never reaches the first tick, so the assertion
     * would pass whether or not the guard existed. The visible case below is
     * the control that proves this one is measuring something.
     */
    async function pollsIn(hidden: boolean, ms: number): Promise<number> {
      vi.useFakeTimers();
      const restore = hide(hidden);
      // Built ONCE, outside the render callback. `stubNotices()` returns a new
      // object each call, and a new notices object gives `refresh` a new
      // identity, which re-runs the poll effect — the test would then see the
      // mount reading several times and blame the interval. Same trap
      // CLAUDE.md describes for this exact hook.
      const notices = stubNotices();
      const api = fakeApi();

      try {
        renderHook(() => useDiscovery(api, notices, 'vscode', undefined));
        // The reading on mount happens either way: an empty list for five
        // seconds is the thing that reading exists to prevent, hidden or not.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(api.discover).toHaveBeenCalledTimes(1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
        return api.discover.mock.calls.length - 1;
      } finally {
        restore();
        vi.useRealTimers();
      }
    }

    it('does not poll', async () => {
      expect(await pollsIn(true, REFRESH_INTERVAL_MS * 6)).toBe(0);
    });

    it('polls normally when the window is visible', async () => {
      // The control. Without it, the assertion above would still pass if the
      // interval had been deleted outright.
      expect(await pollsIn(false, REFRESH_INTERVAL_MS * 6)).toBeGreaterThan(0);
    });

    it('catches up the moment the window comes back', async () => {
      const restore = hide(false);
      const notices = stubNotices();
      const api = fakeApi();

      try {
        const { result } = renderHook(() => useDiscovery(api, notices, 'vscode', undefined));

        // Waited to COMPLETION, not just to the call: `refresh` guards on an
        // in-flight request, so dispatching while the first one is still open
        // would be dropped and the test would blame the listener.
        await waitFor(() => {
          expect(result.current.snapshot).toBeDefined();
        });

        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
          await Promise.resolve();
        });

        // Containers are quite often started from a terminal while boxwarden is
        // in the background; waiting out the interval to notice is the
        // difference between "it saw that" and "I had to click something".
        await waitFor(() => {
          expect(api.discover).toHaveBeenCalledTimes(2);
        });
      } finally {
        restore();
      }
    });
  });
});
