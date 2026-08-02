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

export interface NoticesViewModel {
  readonly notice: Notice | undefined;
  /**
   * The URI of the last failed open, offered as a copyable fallback.
   *
   * `OpenInEditorResult` carries `uri` on its failure arm for exactly this: if
   * a valid URI was built but the editor could not be launched, the user can
   * still paste it into a browser or a shell and get where they were going.
   * Showing only "could not find VS Code" would be withholding the one thing
   * that still works.
   */
  readonly lastFailedUri: string | undefined;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
  /** Report a caught rejection. */
  readonly showThrown: (error: unknown) => void;
  /** Report a failed open, keeping its URI for the copy button. */
  readonly showOpenFailure: (message: string, uri: string | undefined) => void;
  /**
   * Keep a failed open's URI without touching the notice.
   *
   * For the case where the caller is inside `withBusy`, which reports the
   * message itself — setting both here would show the notice twice.
   */
  readonly rememberFailedUri: (uri: string | undefined) => void;
  readonly copyFailedUri: () => void;
  readonly dismiss: () => void;
}

export function useNotices(): NoticesViewModel {
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [lastFailedUri, setLastFailedUri] = useState<string | undefined>(undefined);

  const showInfo = useCallback((message: string) => {
    setNotice({ tone: 'info', message });
  }, []);

  const showError = useCallback((message: string) => {
    setNotice({ tone: 'error', message });
  }, []);

  const showThrown = useCallback((error: unknown) => {
    setNotice({ tone: 'error', message: errorMessage(error) });
  }, []);

  const showOpenFailure = useCallback((message: string, uri: string | undefined) => {
    setLastFailedUri(uri);
    setNotice({ tone: 'error', message });
  }, []);

  const rememberFailedUri = useCallback((uri: string | undefined) => {
    setLastFailedUri(uri);
  }, []);

  /**
   * Clipboard writes can be refused, and silently dropping that would leave the
   * user believing they had the URI. The failure replaces the notice with one
   * that says so.
   */
  const copyFailedUri = useCallback(() => {
    if (lastFailedUri === undefined) return;
    void navigator.clipboard.writeText(lastFailedUri).then(
      () => {
        setNotice({ tone: 'info', message: 'Copied the editor URI to the clipboard.' });
        setLastFailedUri(undefined);
      },
      () => {
        setNotice({ tone: 'error', message: 'Could not write to the clipboard.' });
      },
    );
  }, [lastFailedUri]);

  const dismiss = useCallback(() => {
    setNotice(undefined);
    setLastFailedUri(undefined);
  }, []);

  return {
    notice,
    lastFailedUri,
    showInfo,
    showError,
    showThrown,
    showOpenFailure,
    rememberFailedUri,
    copyFailedUri,
    dismiss,
  };
}
