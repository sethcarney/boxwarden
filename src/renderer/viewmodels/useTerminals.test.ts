// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { devContainer } from '../test-fixtures.js';
import { fakeApi } from './test-api.js';
import { stubNotices } from './test-notices.js';
import { useTerminals } from './useTerminals.js';

const GNOME = { id: 'gnome-terminal', displayName: 'GNOME Terminal', available: true } as const;
const XTERM = { id: 'xterm', displayName: 'xterm', available: true } as const;
const MISSING = { id: 'konsole', displayName: 'Konsole', available: false } as const;

describe('useTerminals', () => {
  /**
   * The probe order in src/main/terminal/targets.ts IS the preference order, so
   * "first available" is the whole selection rule. Picking the first entry
   * regardless would default a GNOME user to a Konsole that is not installed.
   */
  it('defaults to the first emulator that was actually found', async () => {
    const api = fakeApi({ terminals: [MISSING, GNOME, XTERM] });
    const { result } = renderHook(() => useTerminals(api, stubNotices()));

    await waitFor(() => {
      expect(result.current.terminalId).toBe('gnome-terminal');
    });
    expect(result.current.terminalAvailable).toBe(true);
    expect(result.current.terminalName).toBe('GNOME Terminal');
  });

  /**
   * Unlike editors there is no fixed fallback: no terminal emulator ships on
   * every machine. Undefined is what disables the button with a reason instead
   * of offering a dead one.
   */
  it('selects nothing when none was found', async () => {
    const api = fakeApi({ terminals: [MISSING] });
    const { result } = renderHook(() => useTerminals(api, stubNotices()));

    await waitFor(() => {
      expect(result.current.terminals).toHaveLength(1);
    });
    expect(result.current.terminalId).toBeUndefined();
    expect(result.current.terminalName).toBeUndefined();
    expect(result.current.terminalAvailable).toBe(false);
    expect(result.current.anyAvailable).toBe(false);
  });

  it('lets the user pick another', async () => {
    const api = fakeApi({ terminals: [GNOME, XTERM] });
    const { result } = renderHook(() => useTerminals(api, stubNotices()));

    await waitFor(() => {
      expect(result.current.terminalId).toBe('gnome-terminal');
    });
    act(() => {
      result.current.chooseTerminal('xterm');
    });
    expect(result.current.terminalName).toBe('xterm');
  });

  it('survives a bridge that cannot list terminals, without a notice', async () => {
    const api = fakeApi();
    api.listTerminals.mockRejectedValue(new Error('bridge gone'));
    const notices = stubNotices();
    const { result } = renderHook(() => useTerminals(api, notices));

    await waitFor(() => {
      expect(api.listTerminals).toHaveBeenCalled();
    });
    expect(result.current.terminalId).toBeUndefined();
    // The per-card hint already explains a disabled button; a notice here would
    // fire before the user has done anything.
    expect(notices.showError).not.toHaveBeenCalled();
  });

  describe('startup commands', () => {
    /**
     * Keyed by host folder rather than container id, so a rebuild — which
     * recreates the container under a new id — does not lose the command.
     */
    it('looks a command up by the container settings key', async () => {
      const container = devContainer();
      const api = fakeApi({ startupCommands: { '/home/dev/code/webapp': 'bun run dev' } });
      const { result } = renderHook(() => useTerminals(api, stubNotices()));

      await waitFor(() => {
        expect(result.current.startupCommandFor(container)).toBe('bun run dev');
      });
    });

    it('reports no command as an empty string, so the input stays controlled', async () => {
      const api = fakeApi();
      const { result } = renderHook(() => useTerminals(api, stubNotices()));

      await waitFor(() => {
        expect(api.getStartupCommands).toHaveBeenCalled();
      });
      expect(result.current.startupCommandFor(devContainer())).toBe('');
    });

    /**
     * Compose members share one `devcontainer.local_folder`, so the folder
     * alone would give a project's app and db the same command.
     */
    it('distinguishes compose siblings', async () => {
      const app = devContainer({
        name: 'platform-app-1',
        labels: { localFolderRaw: '/home/dev/platform', composeProject: 'platform' },
      });
      const db = devContainer({
        name: 'platform-db-1',
        labels: { localFolderRaw: '/home/dev/platform', composeProject: 'platform' },
      });
      const api = fakeApi({
        startupCommands: { '/home/dev/platform::platform-app-1': 'bun run dev' },
      });
      const { result } = renderHook(() => useTerminals(api, stubNotices()));

      await waitFor(() => {
        expect(result.current.startupCommandFor(app)).toBe('bun run dev');
      });
      expect(result.current.startupCommandFor(db)).toBe('');
    });

    it('sends the container id, never the key it derived', async () => {
      const container = devContainer();
      const api = fakeApi();
      const { result } = renderHook(() => useTerminals(api, stubNotices()));

      await act(async () => {
        result.current.setStartupCommand(container, '  make watch  ');
        await vi.waitFor(() => {
          expect(api.setStartupCommand).toHaveBeenCalledWith(container.id, '  make watch  ');
        });
      });
    });

    it('mirrors the trimmed value the main process stored', async () => {
      const container = devContainer();
      const api = fakeApi();
      const { result } = renderHook(() => useTerminals(api, stubNotices()));

      act(() => {
        result.current.setStartupCommand(container, '  make watch  ');
      });
      // `waitFor` from Testing Library, not vitest's: the mirror is React
      // state, so the assertion has to run inside act for the update to have
      // been flushed.
      await waitFor(() => {
        expect(result.current.startupCommandFor(container)).toBe('make watch');
      });
    });

    it('does not mirror a value the main process refused', async () => {
      const container = devContainer();
      const api = fakeApi();
      api.setStartupCommand.mockResolvedValue({ ok: false, message: 'no longer in the last scan' });
      const notices = stubNotices();
      const { result } = renderHook(() => useTerminals(api, notices));

      await act(async () => {
        result.current.setStartupCommand(container, 'make watch');
        await vi.waitFor(() => {
          expect(notices.showError).toHaveBeenCalledWith('no longer in the last scan');
        });
      });
      expect(result.current.startupCommandFor(container)).toBe('');
    });
  });
});
