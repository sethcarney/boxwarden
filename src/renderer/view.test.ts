import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, parseView, resolveTheme } from './view.js';

describe('parseView', () => {
  it('reads a stored choice back', () => {
    expect(parseView({ layout: 'rows', theme: 'light' })).toEqual({
      layout: 'rows',
      theme: 'light',
    });
  });

  it.each([[undefined], [null], ['rows'], [42], [[]]])(
    'falls back to the default for %p',
    (raw) => {
      expect(parseView(raw)).toEqual(DEFAULT_VIEW);
    },
  );

  /**
   * The one that matters. A layout renamed in a later version, or a
   * hand-edited value, must not cost the user their theme as well — losing
   * every setting because one string went stale reads as the app forgetting
   * everything.
   */
  it('keeps the fields that are still valid when one is not', () => {
    expect(parseView({ layout: 'masonry', theme: 'light' })).toEqual({
      layout: DEFAULT_VIEW.layout,
      theme: 'light',
    });
    expect(parseView({ layout: 'rows', theme: 'solarized' })).toEqual({
      layout: 'rows',
      theme: DEFAULT_VIEW.theme,
    });
  });

  it('ignores extra keys rather than carrying them through', () => {
    expect(parseView({ layout: 'list', theme: 'dark', density: 'huge' })).toEqual({
      layout: 'list',
      theme: 'dark',
    });
  });
});

describe('resolveTheme', () => {
  it('follows the OS only when asked to', () => {
    expect(resolveTheme('auto', true)).toBe('light');
    expect(resolveTheme('auto', false)).toBe('dark');
  });

  it('holds an explicit choice against the OS preference', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });
});
