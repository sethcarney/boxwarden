import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Advice } from '../../models/index.js';
import type { AdviceId, SetupBadge } from '../advisories.js';
import {
  loadHiddenAdvice,
  partitionAdvice,
  saveHiddenAdvice,
  setupBadge,
  setupSummary,
  withHidden,
  withoutHidden,
} from '../advisories.js';

/**
 * The two screens this app has. `containers` is everything boxwarden was built
 * to do; `setup` is where the advice and the diagnostics live, in full,
 * including the ones the user has hidden.
 */
export type AppPage = 'containers' | 'setup';

export interface AdvisoriesViewModel {
  readonly page: AppPage;
  readonly navigate: (page: AppPage) => void;
  /** Every advisory this scan produced, hidden or not. The setup page needs both. */
  readonly all: readonly Advice[];
  /** What the main screen shows. */
  readonly active: readonly Advice[];
  /** Put away by the user, kept in full on the setup page. */
  readonly hidden: readonly Advice[];
  readonly badge: SetupBadge;
  /** The setup page's opening sentence — which reads differently when nothing is wrong. */
  readonly summary: string;
  readonly hide: (id: AdviceId) => void;
  readonly restore: (id: AdviceId) => void;
  readonly restoreAll: () => void;
}

/**
 * Hiding an advisory, and the page that stops hiding from meaning losing.
 *
 * WHY ONE HOOK OWNS BOTH
 *
 * The page and the hidden set are one state machine, for the same reason the
 * busy set and the lifecycle verbs are one in `useDiscovery`: hiding is only a
 * defensible thing to offer BECAUSE there is a second place the advisory
 * survives in, and the two would drift if separate hooks decided them. A future
 * third page would be the point to pull navigation out — one page is not a
 * router.
 *
 * The hidden set is persisted in `localStorage` and read synchronously at first
 * render, so an advisory the user put away yesterday does not flash back onto
 * the screen for a frame on every launch.
 */
export function useAdvisories(advice: readonly Advice[]): AdvisoriesViewModel {
  const [page, setPage] = useState<AppPage>('containers');
  const [hiddenIds, setHiddenIds] = useState<readonly AdviceId[]>(loadHiddenAdvice);

  const partition = useMemo(() => partitionAdvice(advice, hiddenIds), [advice, hiddenIds]);

  /*
   * Written from an effect rather than from inside the updaters below. React
   * may call an updater more than once for the same click (StrictMode does it
   * deliberately), and an updater that writes to storage is not the pure
   * function that contract asks for. The cost is one redundant write on mount,
   * of exactly the value that was just read.
   */
  useEffect(() => {
    saveHiddenAdvice(hiddenIds);
  }, [hiddenIds]);

  // The functional form rather than reading `hiddenIds` from the closure: two
  // advisories hidden in the same tick would otherwise both compute from the
  // pre-click list, and the second would undo the first.
  const hide = useCallback((id: AdviceId) => {
    setHiddenIds((current) => withHidden(current, id));
  }, []);

  const restore = useCallback((id: AdviceId) => {
    setHiddenIds((current) => withoutHidden(current, id));
  }, []);

  const restoreAll = useCallback(() => {
    // Clears the whole store, not just the ids in this scan. The list holds
    // advisories whose conditions are not true right now, and "show everything
    // again" that left those hidden would be a puzzle the next time one fired.
    setHiddenIds([]);
  }, []);

  const navigate = useCallback((next: AppPage) => {
    setPage(next);
  }, []);

  return {
    page,
    navigate,
    all: advice,
    active: partition.active,
    hidden: partition.hidden,
    badge: setupBadge(partition),
    summary: setupSummary(partition),
    hide,
    restore,
    restoreAll,
  };
}
