// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeApi } from './test-api.js';
import { useEditors } from './useEditors.js';

describe('useEditors', () => {
  /**
   * On a machine with only Cursor, defaulting to VS Code means every card opens
   * with its primary action disabled.
   */
  it('defaults to the first editor actually installed', async () => {
    const api = fakeApi({
      editors: [
        { id: 'vscode', displayName: 'VS Code', available: false },
        { id: 'cursor', displayName: 'Cursor', available: true },
      ],
    });
    const { result } = renderHook(() => useEditors(api));

    await waitFor(() => {
      expect(result.current.editorId).toBe('cursor');
    });
    expect(result.current.editorName).toBe('Cursor');
    expect(result.current.editorAvailable).toBe(true);
  });

  it('leaves the default in place when nothing is installed', async () => {
    const api = fakeApi({
      editors: [{ id: 'vscode', displayName: 'VS Code', available: false }],
    });
    const { result } = renderHook(() => useEditors(api));

    await waitFor(() => {
      expect(result.current.editors).toHaveLength(1);
    });
    expect(result.current.editorId).toBe('vscode');
    expect(result.current.editorAvailable).toBe(false);
  });

  it('falls back to VS Code as a name before the list arrives', () => {
    const { result } = renderHook(() => useEditors(undefined));
    expect(result.current.editorName).toBe('VS Code');
    expect(result.current.editorAvailable).toBe(false);
  });

  it('follows an explicit choice', async () => {
    const api = fakeApi({
      editors: [
        { id: 'vscode', displayName: 'VS Code', available: true },
        { id: 'windsurf', displayName: 'Windsurf', available: true },
      ],
    });
    const { result } = renderHook(() => useEditors(api));
    await waitFor(() => {
      expect(result.current.editors).toHaveLength(2);
    });

    act(() => {
      result.current.chooseEditor('windsurf');
    });
    expect(result.current.editorName).toBe('Windsurf');
  });
});
