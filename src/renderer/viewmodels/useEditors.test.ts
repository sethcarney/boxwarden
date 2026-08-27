// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeApi } from './test-api.js';
import { useEditors } from './useEditors.js';

describe('useEditors', () => {
  /**
   * `EditorId` is an open union, so the hook stays generic over whatever list
   * the main process offers — today that is VS Code alone, but a machine where
   * only some other entry is installed must not default to a disabled one.
   */
  it('defaults to the first editor actually installed', async () => {
    const api = fakeApi({
      editors: [
        { id: 'vscode', displayName: 'VS Code', available: false },
        { id: 'my-fork', displayName: 'My Fork', available: true },
      ],
    });
    const { result } = renderHook(() => useEditors(api));

    await waitFor(() => {
      expect(result.current.editorId).toBe('my-fork');
    });
    expect(result.current.editorName).toBe('My Fork');
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
        { id: 'my-fork', displayName: 'My Fork', available: true },
      ],
    });
    const { result } = renderHook(() => useEditors(api));
    await waitFor(() => {
      expect(result.current.editors).toHaveLength(2);
    });

    act(() => {
      result.current.chooseEditor('my-fork');
    });
    expect(result.current.editorName).toBe('My Fork');
  });
});
