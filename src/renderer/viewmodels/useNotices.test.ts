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

  it('keeps a failed launch\u2019s fallback alongside the message', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showLaunchFailure('could not spawn code', {
        label: 'Copy URI',
        value: 'vscode-remote://x',
      });
    });
    expect(result.current.notice?.tone).toBe('error');
    expect(result.current.fallback).toEqual({ label: 'Copy URI', value: 'vscode-remote://x' });
  });

  /**
   * The label travels with the value because two different things land here —
   * an editor URI and a `docker exec` line — and the button names whichever it
   * is holding.
   */
  it('carries the label the button should show', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showLaunchFailure('no terminal', {
        label: 'Copy command',
        value: "'docker' 'exec' '-it'",
      });
    });
    expect(result.current.fallback?.label).toBe('Copy command');
  });

  /** `withBusy` shows the message itself; setting both would render it twice. */
  it('can remember a fallback without touching the notice', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.rememberFallback({ label: 'Copy URI', value: 'vscode-remote://y' });
    });
    expect(result.current.fallback?.value).toBe('vscode-remote://y');
    expect(result.current.notice).toBeUndefined();
  });

  it('dismisses the message and the fallback together', () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showLaunchFailure('nope', { label: 'Copy URI', value: 'vscode-remote://x' });
    });
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.notice).toBeUndefined();
    expect(result.current.fallback).toBeUndefined();
  });

  it('confirms a copied fallback and clears it', async () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showLaunchFailure('nope', { label: 'Copy URI', value: 'vscode-remote://x' });
    });

    await act(async () => {
      result.current.copyFallback();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.notice?.message).toContain('Copied');
    });
    expect(result.current.fallback).toBeUndefined();
  });

  /**
   * A refused clipboard write must say so. Dropping it silently would leave the
   * user believing they had the value.
   */
  it('says so when the clipboard refuses', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.showLaunchFailure('nope', { label: 'Copy URI', value: 'vscode-remote://x' });
    });

    await act(async () => {
      result.current.copyFallback();
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
