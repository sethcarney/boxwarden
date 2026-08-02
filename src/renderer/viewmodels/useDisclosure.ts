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
export function useDisclosure(initiallyExpanded = false): DisclosureViewModel {
  const [expanded, setExpanded] = useState(initiallyExpanded);

  const expand = useCallback(() => {
    setExpanded(true);
  }, []);

  const collapse = useCallback(() => {
    setExpanded(false);
  }, []);

  const toggle = useCallback(() => {
    setExpanded((value) => !value);
  }, []);

  const reveal = useCallback(
    <T>(items: readonly T[], limit: number) => {
      const visible = expanded ? items : items.slice(0, limit);
      return { visible, hidden: items.length - visible.length };
    },
    [expanded],
  );

  return { expanded, expand, collapse, toggle, reveal };
}
