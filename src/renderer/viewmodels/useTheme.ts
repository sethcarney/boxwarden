import { useCallback, useLayoutEffect, useState } from 'react';
import type { ViewPreferences } from '../view.js';
import { loadView, resolveTheme, saveView } from '../view.js';

export interface ThemeViewModel {
  readonly view: ViewPreferences;
  readonly changeView: (next: ViewPreferences) => void;
}

/**
 * Layout and theme, persisted in localStorage and applied to <html>.
 *
 * `loadView` runs as the lazy initialiser — during the first render, not in an
 * effect — so the window paints in the chosen layout instead of showing the
 * default for a frame and then reflowing.
 *
 * `auto` is resolved here rather than with a `prefers-color-scheme` block in
 * the stylesheet, so the light palette is written once and the root attribute
 * always names a concrete theme. The media listener matters on a desktop app:
 * the window outlives the OS switching to its evening theme.
 */
export function useTheme(): ThemeViewModel {
  const [view, setView] = useState<ViewPreferences>(loadView);

  const [prefersLight, setPrefersLight] = useState(
    () => window.matchMedia('(prefers-color-scheme: light)').matches,
  );

  useLayoutEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onPreferenceChange = (event: MediaQueryListEvent) => {
      setPrefersLight(event.matches);
    };
    query.addEventListener('change', onPreferenceChange);
    return () => {
      query.removeEventListener('change', onPreferenceChange);
    };
  }, []);

  // Layout, not passive: `useEffect` would run after the first paint, so a
  // light-theme user would see one frame of the dark palette on every launch.
  useLayoutEffect(() => {
    // On <html>, not on the app element: the page background and the native
    // scrollbars (`color-scheme`) are inherited from the root.
    document.documentElement.setAttribute('data-theme', resolveTheme(view.theme, prefersLight));
  }, [view.theme, prefersLight]);

  const changeView = useCallback((next: ViewPreferences) => {
    setView(next);
    saveView(next);
  }, []);

  return { view, changeView };
}
