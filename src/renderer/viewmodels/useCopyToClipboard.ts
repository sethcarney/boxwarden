import { useCallback, useEffect, useRef, useState } from 'react';

export interface CopyViewModel {
  /** True for a moment after a successful write, for the "Copied" label. */
  readonly copied: boolean;
  readonly copy: (text: string) => void;
}

/**
 * Copy-to-clipboard with a self-clearing confirmation.
 *
 * A ViewModel and not an inline handler because writing to the clipboard is
 * I/O that can be refused, and because the timer has to be cancelled on
 * unmount — a `setTimeout` left running past teardown sets state on a gone
 * component, which is exactly the class of bug this layer exists to keep out
 * of the Views.
 */
export function useCopyToClipboard(resetAfterMs = 1_500): CopyViewModel {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          if (timer.current !== undefined) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setCopied(false);
          }, resetAfterMs);
        },
        () => {
          setCopied(false);
        },
      );
    },
    [resetAfterMs],
  );

  return { copied, copy };
}
