import type { Notice } from '../viewmodels/index.js';

interface Props {
  readonly notice: Notice | undefined;
  /** The URI of the last failed open, if there is one to offer. */
  readonly failedUri: string | undefined;
  readonly onCopyUri: () => void;
  readonly onDismiss: () => void;
}

export function NoticeBar({ notice, failedUri, onCopyUri, onDismiss }: Props) {
  if (notice === undefined) return null;

  return (
    <div className={`notice notice-${notice.tone}`} role="status">
      <span>{notice.message}</span>
      <span className="notice-actions">
        {failedUri !== undefined && notice.tone === 'error' && (
          <button type="button" className="link" title={failedUri} onClick={onCopyUri}>
            Copy URI
          </button>
        )}
        <button type="button" className="link" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
