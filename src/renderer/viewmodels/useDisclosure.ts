import { useCallback, useState } from 'react';

export interface DisclosureViewModel {
  readonly expanded: boolean;
  readonly expand: () => void;
  readonly collapse: () => void;
  readonly toggle: () => void;
  /**
   * The first `limit` of `items`, or all of them once expanded, plus how many
   * are still hidden. Folded in here rather than left to the View because the
   * slice and the "Show n more" count have to agree — computing them in two
   * places is how a button offers to reveal items that are already on screen.
   */
  readonly reveal: <T>(
    items: readonly T[],
    limit: number,
  ) => { readonly visible: readonly T[]; readonly hidden: number };
}

/**
 * A collapsed/expanded toggle over a truncated list.
 *
 * Small enough to look like it belongs inline in the component, which is
 * exactly why it is here: `useState` in a View is the crack that the first
 * genuinely stateful decision widens. Keeping it in this layer also means the
 * slice-and-count pairing above is unit-testable without mounting anything.
 */
/**
 * Read a remembered open/closed state, falling back to the default.
 *
 * Same shape and the same failure posture as `loadView`: a disabled or full
 * store is not worth interrupting anyone over, so it degrades to the default
 * for this run rather than throwing during a render.
 */
function loadExpanded(key: string | undefined, fallback: boolean): boolean {
  if (key === undefined) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function saveExpanded(key: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(key, String(expanded));
  } catch {
    // See `saveView` — the choice still applies for this run.
  }
}

export function useDisclosure(
  initiallyExpanded = false,
  /**
   * Remember the state under this key, in localStorage.
   *
   * Optional because the two things this hook does are different in kind. A
   * truncated LIST re-collapses on every render of a fresh scan and should:
   * "show 12 more" is about one listing. A PANEL the user folded away is a
   * standing preference, and re-opening it on every launch is how a collapse
   * button stops being used. localStorage and not `preferences.json`, for the
   * reason the layout is there too — the main process makes no decision from it.
   */
  storageKey?: string,
): DisclosureViewModel {
  // A lazy initialiser, so a panel the user collapsed is not painted open for
  // one frame and then folded — the same reason `loadView` is one.
  const [expanded, setExpanded] = useState(() => loadExpanded(storageKey, initiallyExpanded));

  const remember = useCallback(
    (next: boolean) => {
      if (storageKey !== undefined) saveExpanded(storageKey, next);
      return next;
    },
    [storageKey],
  );

  const expand = useCallback(() => {
    setExpanded(remember(true));
  }, [remember]);

  const collapse = useCallback(() => {
    setExpanded(remember(false));
  }, [remember]);

  const toggle = useCallback(() => {
    setExpanded((value) => remember(!value));
  }, [remember]);

  const reveal = useCallback(
    <T>(items: readonly T[], limit: number) => {
      const visible = expanded ? items : items.slice(0, limit);
      return { visible, hidden: items.length - visible.length };
    },
    [expanded],
  );

  return { expanded, expand, collapse, toggle, reveal };
}
