// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDisclosure } from './useDisclosure.js';

const ITEMS = ['a', 'b', 'c', 'd', 'e'] as const;

describe('useDisclosure', () => {
  it('starts collapsed', () => {
    const { result } = renderHook(() => useDisclosure());
    expect(result.current.expanded).toBe(false);
  });

  it('honours an initially-expanded start', () => {
    const { result } = renderHook(() => useDisclosure(true));
    expect(result.current.expanded).toBe(true);
  });

  /**
   * The slice and the hidden count have to agree. Computing them separately in
   * a View is how a "Show 2 more" button ends up revealing nothing, so the
   * pairing is asserted rather than the two numbers independently.
   */
  it('truncates to the limit and counts exactly what it withheld', () => {
    const { result } = renderHook(() => useDisclosure());
    const { visible, hidden } = result.current.reveal(ITEMS, 3);
    expect(visible).toEqual(['a', 'b', 'c']);
    expect(hidden).toBe(2);
    expect(visible.length + hidden).toBe(ITEMS.length);
  });

  it('hides nothing once expanded', () => {
    const { result } = renderHook(() => useDisclosure());
    act(() => {
      result.current.expand();
    });
    const { visible, hidden } = result.current.reveal(ITEMS, 3);
    expect(visible).toEqual([...ITEMS]);
    expect(hidden).toBe(0);
  });

  /**
   * A list shorter than the limit must report nothing hidden — a negative
   * count would render as "Show -1 more".
   */
  it('reports no remainder for a list shorter than the limit', () => {
    const { result } = renderHook(() => useDisclosure());
    const { visible, hidden } = result.current.reveal(['a'], 3);
    expect(visible).toEqual(['a']);
    expect(hidden).toBe(0);
  });

  it('collapses and toggles back', () => {
    const { result } = renderHook(() => useDisclosure());
    act(() => {
      result.current.expand();
    });
    act(() => {
      result.current.collapse();
    });
    expect(result.current.expanded).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(true);
  });

  /**
   * The callbacks are handed to a View as `onClick` props. A fresh identity on
   * every render defeats memoisation there and, in the poll-driven parts of
   * this app, re-runs effects that depend on them.
   */
  it('keeps expand and collapse stable across renders', () => {
    const { result, rerender } = renderHook(() => useDisclosure());
    const first = { expand: result.current.expand, collapse: result.current.collapse };
    rerender();
    expect(result.current.expand).toBe(first.expand);
    expect(result.current.collapse).toBe(first.collapse);
  });
});
