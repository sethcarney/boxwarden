// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { UpdateStatus } from '../../models/index.js';
import { fakeApi, updateAvailable } from './test-api.js';
import { useUpdate } from './useUpdate.js';

const NOW = new Date('2026-08-03T12:00:00Z').getTime();

/** An hour, so the interval never fires inside a test. */
const NEVER = 3_600_000;

describe('useUpdate', () => {
  it('asks on open, without forcing — the daily gate is the main process’s', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useUpdate(api, NOW, NEVER));

    await waitFor(() => {
      expect(result.current.summary.label).toBe('boxwarden 1.1.0 · up to date');
    });
    expect(api.updateStatus).toHaveBeenCalledWith(false);
  });

  it('shows no banner when there is nothing to say', async () => {
    const { result } = renderHook(() => useUpdate(fakeApi(), NOW, NEVER));
    await waitFor(() => {
      expect(result.current.summary.label).toContain('up to date');
    });
    expect(result.current.panel).toBeUndefined();
  });

  it('offers the banner and the footer line together when a release is newer', async () => {
    const api = fakeApi({ update: updateAvailable() });
    const { result } = renderHook(() => useUpdate(api, NOW, NEVER));

    await waitFor(() => {
      expect(result.current.panel).toBeDefined();
    });
    expect(result.current.panel?.headline).toBe('boxwarden 1.2.0 is available');
    expect(result.current.summary.label).toBe('boxwarden 1.1.0 · 1.2.0 available');
  });

  describe('dismissing', () => {
    it('takes the banner down and leaves the footer saying it exists', async () => {
      const dismissed = updateAvailable({
        outcome: { ...updateAvailable().outcome, dismissed: true } as UpdateStatus['outcome'],
      });
      const api = fakeApi({ update: updateAvailable() });
      api.dismissUpdate.mockResolvedValue(dismissed);

      const { result } = renderHook(() => useUpdate(api, NOW, NEVER));
      await waitFor(() => {
        expect(result.current.panel).toBeDefined();
      });

      await act(async () => {
        result.current.dismiss();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.panel).toBeUndefined();
      });
      // The one thing a dismissal must NOT do: make the update invisible.
      expect(result.current.summary.label).toBe('boxwarden 1.1.0 · 1.2.0 available');
    });

    it('names no version, so the renderer cannot silence one it was never shown', async () => {
      const api = fakeApi({ update: updateAvailable() });
      const { result } = renderHook(() => useUpdate(api, NOW, NEVER));
      await waitFor(() => {
        expect(result.current.panel).toBeDefined();
      });

      await act(async () => {
        result.current.dismiss();
        await Promise.resolve();
      });

      expect(api.dismissUpdate).toHaveBeenCalledWith();
    });

    it('brings a dismissed banner back when the footer line is clicked', async () => {
      const dismissed = updateAvailable({
        outcome: { ...updateAvailable().outcome, dismissed: true } as UpdateStatus['outcome'],
      });
      const api = fakeApi({ update: dismissed });
      const { result } = renderHook(() => useUpdate(api, NOW, NEVER));

      await waitFor(() => {
        expect(result.current.summary.label).toContain('1.2.0 available');
      });
      expect(result.current.panel).toBeUndefined();

      await act(async () => {
        result.current.act();
        await Promise.resolve();
      });

      // A dismissal the user cannot undo would hide the install instructions
      // until the NEXT release.
      await waitFor(() => {
        expect(result.current.panel).toBeDefined();
      });
    });
  });

  describe('the footer button', () => {
    it('forces a check when checks are on', async () => {
      const api = fakeApi();
      const { result } = renderHook(() => useUpdate(api, NOW, NEVER));
      await waitFor(() => {
        expect(api.updateStatus).toHaveBeenCalledWith(false);
      });

      await act(async () => {
        result.current.act();
        await Promise.resolve();
      });

      expect(api.updateStatus).toHaveBeenCalledWith(true);
      expect(api.setUpdateChecks).not.toHaveBeenCalled();
    });

    it('turns checks back on when they are off, rather than forcing a check that cannot happen', async () => {
      const off: UpdateStatus = { currentVersion: '1.1.0', outcome: { kind: 'disabled' } };
      const api = fakeApi({ update: off });
      const { result } = renderHook(() => useUpdate(api, NOW, NEVER));

      await waitFor(() => {
        expect(result.current.summary.label).toBe('boxwarden 1.1.0 · update checks off');
      });

      await act(async () => {
        result.current.act();
        await Promise.resolve();
      });

      expect(api.setUpdateChecks).toHaveBeenCalledWith(true);
    });
  });

  it('turns checks off through the bridge, so the choice outlives the window', async () => {
    const api = fakeApi({ update: updateAvailable() });
    const { result } = renderHook(() => useUpdate(api, NOW, NEVER));
    await waitFor(() => {
      expect(result.current.panel).toBeDefined();
    });

    await act(async () => {
      result.current.disable();
      await Promise.resolve();
    });

    expect(api.setUpdateChecks).toHaveBeenCalledWith(false);
  });

  it('reports a failed check where the answer would have been, not in the message bar', async () => {
    const api = fakeApi();
    api.updateStatus.mockRejectedValue(new Error('the bridge is gone'));
    const { result } = renderHook(() => useUpdate(api, NOW, NEVER));

    await waitFor(() => {
      expect(result.current.summary.label).toContain('update check failed');
    });
    // "Could not tell" must never render as "up to date".
    expect(result.current.summary.title).toContain('the bridge is gone');
  });

  it('does nothing at all without a bridge', () => {
    const { result } = renderHook(() => useUpdate(undefined, NOW, NEVER));
    expect(result.current.panel).toBeUndefined();
    expect(result.current.summary.label).toBe('boxwarden');
  });
});
