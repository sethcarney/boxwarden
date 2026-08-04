// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DevContainerProject } from '../../models/index.js';
import { asProjectId } from '../../models/index.js';
import { devContainer } from '../test-fixtures.js';
import { fakeApi, projectScan } from './test-api.js';
import { stubNotices } from './test-notices.js';
import { useProjects } from './useProjects.js';

const project: DevContainerProject = {
  id: asProjectId('/home/dev/code/api/.devcontainer/devcontainer.json'),
  name: 'Payments API',
  folder: { kind: 'posix', path: '/home/dev/code/api' },
  configPath: '/home/dev/code/api/.devcontainer/devcontainer.json',
  configLabel: '.devcontainer/devcontainer.json',
  root: '/home/dev',
};

describe('useProjects', () => {
  it('scans once on open and never on a timer', async () => {
    const api = fakeApi({ scan: projectScan({ projects: [project] }) });
    const notices = stubNotices();
    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));

    await waitFor(() => {
      expect(result.current.unbuilt).toHaveLength(1);
    });
    expect(api.scanProjects).toHaveBeenCalledTimes(1);
  });

  /**
   * The panel's whole job is the gap between disk and Docker. A project already
   * in the container list is not in that gap, and repeating it there would make
   * "not built yet" a lie.
   */
  it('moves a project to built once a container claims its folder', async () => {
    const api = fakeApi({ scan: projectScan({ projects: [project] }) });
    const claimed = devContainer({ localFolder: { kind: 'posix', path: '/home/dev/code/api' } });
    const notices = stubNotices();

    const { result } = renderHook(() => useProjects(api, notices, 'vscode', [claimed]));

    await waitFor(() => {
      expect(result.current.built).toHaveLength(1);
    });
    expect(result.current.unbuilt).toHaveLength(0);
    expect(result.current.summary).toContain('has been built');
  });

  it('surfaces a truncated scan rather than reporting a short list as complete', async () => {
    const api = fakeApi({ scan: projectScan({ truncated: true }) });
    const notices = stubNotices();
    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));

    await waitFor(() => {
      expect(result.current.truncated).toBe(true);
    });
  });

  it('rescans after a root is added', async () => {
    const api = fakeApi();
    const notices = stubNotices();
    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));
    await waitFor(() => {
      expect(api.scanProjects).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      result.current.addRoot();
      await vi.waitFor(() => {
        expect(api.scanProjects).toHaveBeenCalledTimes(2);
      });
    });
  });

  /** A user who thought better of the folder picker has changed nothing. */
  it('does not rescan when the folder picker was cancelled', async () => {
    const api = fakeApi();
    api.addProjectRoot.mockResolvedValue({ ok: true, cancelled: true });
    const notices = stubNotices();

    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));
    await waitFor(() => {
      expect(api.scanProjects).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      result.current.addRoot();
      await vi.waitFor(() => {
        expect(api.addProjectRoot).toHaveBeenCalled();
      });
    });
    expect(api.scanProjects).toHaveBeenCalledTimes(1);
  });

  it('reports a failure to change the roots', async () => {
    const api = fakeApi();
    api.removeProjectRoot.mockResolvedValue({ ok: false, message: 'preferences are read-only' });
    const notices = stubNotices();

    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));
    await waitFor(() => {
      expect(api.scanProjects).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      result.current.removeRoot('/home/dev');
      await vi.waitFor(() => {
        expect(notices.showError).toHaveBeenCalledWith('preferences are read-only');
      });
    });
  });

  /**
   * The folder opening locally looks like the wrong thing happened unless the
   * user is told the container comes from the editor's own prompt.
   */
  it('names the next step when a project opens', async () => {
    const api = fakeApi({ scan: projectScan({ projects: [project] }) });
    const notices = stubNotices();
    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));
    await waitFor(() => {
      expect(result.current.unbuilt).toHaveLength(1);
    });

    await act(async () => {
      result.current.openProject(project);
      await vi.waitFor(() => {
        expect(notices.showInfo).toHaveBeenCalled();
      });
    });
    expect(notices.showInfo.mock.calls[0]?.[0]).toContain('reopen it in a container');
  });

  it('keeps the URI when opening a project fails', async () => {
    const api = fakeApi({ scan: projectScan({ projects: [project] }) });
    api.openProject = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        code: 'editor-not-found' as const,
        message: 'no code binary',
        uri: 'file:///home/dev/code/api',
      }),
    ) as unknown as typeof api.openProject;
    const notices = stubNotices();

    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));
    await waitFor(() => {
      expect(result.current.unbuilt).toHaveLength(1);
    });

    await act(async () => {
      result.current.openProject(project);
      await vi.waitFor(() => {
        expect(notices.showLaunchFailure).toHaveBeenCalledWith('no code binary', {
          label: 'Copy URI',
          value: 'file:///home/dev/code/api',
        });
      });
    });
  });

  it('stays idle until the first scan returns, so the panel can hide', () => {
    const api = fakeApi();
    const notices = stubNotices();
    const { result } = renderHook(() => useProjects(api, notices, 'vscode', []));
    // Synchronously after mount the scan is in flight, so the panel is not idle.
    expect(result.current.scan).toBeUndefined();
  });
});
