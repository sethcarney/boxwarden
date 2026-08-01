// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DevContainer, EngineId } from '../../models/index.js';
import type { ActionResult } from '../../shared/ipc.js';
import { devContainer } from '../test-fixtures.js';
import { stubNotices } from './test-notices.js';
import { fakeApi, snapshot, unreachableSnapshot } from './test-api.js';
import { useDiscovery } from './useDiscovery.js';

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
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));

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

    renderHook(() => useDiscovery(api, notices, 'vscode'));

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
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
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

  it('reports a lifecycle failure as a message rather than swallowing it', async () => {
    const api = fakeApi({ snapshot: snapshot({ containers: [stopped] }) });
    api.start.mockResolvedValue({ ok: false, message: 'no such image' });
    const notices = stubNotices();

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
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

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
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
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
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
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
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
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
    await waitFor(() => {
      expect(result.current.groups).toHaveLength(2);
    });
    expect(result.current.groups[0]?.kind).toBe('compose');
    expect(result.current.groups[1]?.kind).toBe('single');
  });

  it('reports the engine as unreachable rather than pretending the list is complete', async () => {
    const api = fakeApi({ snapshot: unreachableSnapshot() });
    const notices = stubNotices();
    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));

    await waitFor(() => {
      expect(result.current.snapshot).toBeDefined();
    });
    expect(result.current.dockerOk).toBe(false);
    expect(result.current.engine?.label).toBe('No container engine');
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

    const { result } = renderHook(() => useDiscovery(api, notices, 'vscode'));
    await waitFor(() => {
      expect(result.current.containers).toHaveLength(1);
    });

    await act(async () => {
      result.current.open(running as DevContainer);
      await vi.waitFor(() => {
        expect(notices.rememberFailedUri).toHaveBeenCalledWith(
          'vscode-remote://dev-container+abc/workspaces/webapp',
        );
      });
    });
    expect(notices.showError).toHaveBeenCalledWith('could not spawn code');
  });
});
