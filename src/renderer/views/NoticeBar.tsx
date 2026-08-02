import type { CopyableFallback, Notice } from '../viewmodels/index.js';

interface Props {
  readonly notice: Notice | undefined;
  /** What the last failed launch produced, if there is anything to offer. */
  readonly fallback: CopyableFallback | undefined;
  readonly onCopy: () => void;
  readonly onDismiss: () => void;
}

export function NoticeBar({ notice, fallback, onCopy, onDismiss }: Props) {
  if (notice === undefined) return null;

  return (
    <div className={`notice notice-${notice.tone}`} role="status">
      <span>{notice.message}</span>
      <span className="notice-actions">
        {/* The label travels with the value: an editor URI and a docker exec
            line are both offered here, and "Copy URI" beside a shell command
            would be a small lie in the one part of the UI whose job is to be
            accurate when something has gone wrong. */}
        {fallback !== undefined && notice.tone === 'error' && (
          <button type="button" className="link" title={fallback.value} onClick={onCopy}>
            {fallback.label}
          </button>
        )}
        <button type="button" className="link" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
