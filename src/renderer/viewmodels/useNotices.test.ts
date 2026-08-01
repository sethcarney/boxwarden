// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useNotices } from './useNotices.js';

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  });
}

describe('useNotices', () => {
  beforeEach(() => {
    stubClipboard(() => Promise.resolve());
  });

  it('reports a thrown value that is not an Error without losing it', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showThrown('the socket closed');
    });
    expect(result.current.notice).toEqual({ tone: 'error', message: 'the socket closed' });
  });

  it('keeps the URI of a failed open alongside the message', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showOpenFailure('could not spawn code', 'vscode-remote://x');
    });
    expect(result.current.notice?.tone).toBe('error');
    expect(result.current.lastFailedUri).toBe('vscode-remote://x');
  });

  /** `withBusy` shows the message itself; setting both would render it twice. */
  it('can remember a URI without touching the notice', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.rememberFailedUri('vscode-remote://y');
    });
    expect(result.current.lastFailedUri).toBe('vscode-remote://y');
    expect(result.current.notice).toBeUndefined();
  });

  it('dismisses the message and the URI together', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showOpenFailure('nope', 'vscode-remote://x');
    });
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.notice).toBeUndefined();
    expect(result.current.lastFailedUri).toBeUndefined();
  });

  it('confirms a copied URI and clears it', async () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showOpenFailure('nope', 'vscode-remote://x');
    });

    await act(async () => {
      result.current.copyFailedUri();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.notice?.message).toContain('Copied');
    });
    expect(result.current.lastFailedUri).toBeUndefined();
  });

  /**
   * A refused clipboard write must say so. Dropping it silently would leave the
   * user believing they had the URI.
   */
  it('says so when the clipboard refuses', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showOpenFailure('nope', 'vscode-remote://x');
    });

    await act(async () => {
      result.current.copyFailedUri();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.notice).toEqual({
        tone: 'error',
        message: 'Could not write to the clipboard.',
      });
    });
  });
});
