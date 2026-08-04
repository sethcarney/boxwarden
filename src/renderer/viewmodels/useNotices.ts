import { useCallback, useState } from 'react';
import { errorMessage } from '../presenters.js';

/**
 * The one-line message bar, and the copyable URI that sometimes goes with it.
 *
 * Its own ViewModel because every other one reports through it: discovery,
 * projects and the editor list all turn a rejected promise or an `ok: false`
 * into the same bar. Sharing one owner is what keeps a later failure from
 * being hidden behind an earlier one that nobody dismissed.
 */

export interface Notice {
  readonly tone: 'error' | 'info';
  readonly message: string;
}

/**
 * Something a failed launch produced that the user can still use by hand.
 *
 * A labelled pair rather than a bare string because there are now two kinds:
 * an editor URI and a `docker exec` command line. They are offered in the same
 * place and copied the same way, but a button reading "Copy URI" beside a
 * shell command would be a small lie in the one part of the UI whose whole job
 * is to be accurate when something has gone wrong.
 */
export interface CopyableFallback {
  /** The button's label — "Copy URI", "Copy command". */
  readonly label: string;
  readonly value: string;
}

export interface NoticesViewModel {
  readonly notice: Notice | undefined;
  /**
   * What the last failed launch produced, offered as a copyable fallback.
   *
   * Both failure arms carry one — `OpenInEditorResult.uri` and
   * `OpenTerminalResult.command` — for exactly this: if a valid URI or a valid
   * exec line was built but the thing that consumes it could not be launched,
   * the user can still paste it somewhere and get where they were going.
   * Showing only "could not find VS Code" would be withholding the one part
   * that still works.
   */
  readonly fallback: CopyableFallback | undefined;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
  /** Report a caught rejection. */
  readonly showThrown: (error: unknown) => void;
  /** Report a failed launch, keeping its fallback for the copy button. */
  readonly showLaunchFailure: (message: string, fallback: CopyableFallback | undefined) => void;
  /**
   * Keep a failed launch's fallback without touching the notice.
   *
   * For the case where the caller is inside `withBusy`, which reports the
   * message itself — setting both here would show the notice twice.
   */
  readonly rememberFallback: (fallback: CopyableFallback | undefined) => void;
  readonly copyFallback: () => void;
  readonly dismiss: () => void;
}

export function useNotices(): NoticesViewModel {
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [fallback, setFallback] = useState<CopyableFallback | undefined>(undefined);

  const showInfo = useCallback((message: string) => {
    setNotice({ tone: 'info', message });
  }, []);

  const showError = useCallback((message: string) => {
    setNotice({ tone: 'error', message });
  }, []);

  const showThrown = useCallback((error: unknown) => {
    setNotice({ tone: 'error', message: errorMessage(error) });
  }, []);

  const showLaunchFailure = useCallback((message: string, next: CopyableFallback | undefined) => {
    setFallback(next);
    setNotice({ tone: 'error', message });
  }, []);

  const rememberFallback = useCallback((next: CopyableFallback | undefined) => {
    setFallback(next);
  }, []);

  /**
   * Clipboard writes can be refused, and silently dropping that would leave the
   * user believing they had the value. The failure replaces the notice with one
   * that says so.
   */
  const copyFallback = useCallback(() => {
    if (fallback === undefined) return;
    void navigator.clipboard.writeText(fallback.value).then(
      () => {
        setNotice({ tone: 'info', message: 'Copied to the clipboard.' });
        setFallback(undefined);
      },
      () => {
        setNotice({ tone: 'error', message: 'Could not write to the clipboard.' });
      },
    );
  }, [fallback]);

  const dismiss = useCallback(() => {
    setNotice(undefined);
    setFallback(undefined);
  }, []);

  return {
    notice,
    fallback,
    showInfo,
    showError,
    showThrown,
    showLaunchFailure,
    rememberFallback,
    copyFallback,
    dismiss,
  };
}
