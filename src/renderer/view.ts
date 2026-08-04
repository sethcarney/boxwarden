/**
 * How the list is drawn — layout and theme.
 *
 * WHY THIS IS NOT IN THE PREFERENCES FILE
 *
 * `engineSelection` earned a place in `src/main/preferences.ts` (and an IPC
 * verb) because the MAIN process has to honour it before the window exists.
 * Nothing outside the renderer has any use for the layout: no main-process
 * decision changes, no Docker call changes. Persisting it here keeps the IPC
 * surface at the verbs it already has, which is the rule this app is trying to
 * hold.
 *
 * localStorage is read synchronously at first render, so the window paints in
 * the chosen layout rather than flashing the default and correcting itself.
 *
 * The parsing is pure and tested; the two functions that touch `window` are the
 * thin shell around it, and both swallow their failures — a browser with
 * storage disabled should render the default layout, not a blank window.
 */

export const LAYOUT_MODES = ['grid', 'list', 'rows'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const THEMES = ['dark', 'light', 'auto'] as const;
export type Theme = (typeof THEMES)[number];

export interface ViewPreferences {
  readonly layout: LayoutMode;
  readonly theme: Theme;
}

/**
 * Grid, not list: a dev container card carries a name, two paths and three
 * buttons, and one per row leaves two thirds of a normal window empty. Theme
 * stays `dark` rather than `auto` so an existing install looks the way it did
 * yesterday — following the OS is opt-in, one control away.
 */
export const DEFAULT_VIEW: ViewPreferences = { layout: 'grid', theme: 'dark' };

const STORAGE_KEY = 'boxwarden.view';

/**
 * Every field falls back independently.
 *
 * A stored layout that no longer exists (renamed in a later version, or a
 * hand-edited value) must not take the theme down with it — losing both
 * settings because one string went stale is the kind of thing users read as
 * "it forgot everything".
 */
export function parseView(raw: unknown): ViewPreferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_VIEW;
  const record = raw as Record<string, unknown>;
  return {
    layout: parseMember(LAYOUT_MODES, record['layout'], DEFAULT_VIEW.layout),
    theme: parseMember(THEMES, record['theme'], DEFAULT_VIEW.theme),
  };
}

function parseMember<T extends string>(allowed: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * Resolves `auto` against the OS setting.
 *
 * Kept separate from `parseView` and given `prefersLight` as an argument rather
 * than reading `matchMedia` itself, for the same reason `relativeTime` takes
 * `now`: a function that reads the environment cannot be asserted against fixed
 * values.
 */
export function resolveTheme(theme: Theme, prefersLight: boolean): 'dark' | 'light' {
  if (theme === 'auto') return prefersLight ? 'light' : 'dark';
  return theme;
}

export function loadView(): ViewPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW;
    return parseView(JSON.parse(raw));
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: ViewPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // A quota or a disabled store is not worth interrupting anyone over; the
    // choice still applies for this run, held in React state.
  }
}
