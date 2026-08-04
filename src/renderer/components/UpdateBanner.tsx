import type { DownloadPresentation, UpdatePanel } from '../presenters.js';
import { useCopyToClipboard } from '../viewmodels/useCopyToClipboard.js';

/**
 * "A newer boxwarden exists, and here is how to install it."
 *
 * Deliberately the same shape as an advisory, because it is the same kind of
 * thing: a fact the app noticed, what to do about it, and the exact command to
 * type. Every word comes from the ViewModel — `updatePanel` in presenters.ts
 * over `updateInstructions` in the Model — so this file decides layout and
 * nothing else. Which arm of the download is showing is decided by
 * `downloadPresentation`; the switch below maps arms to markup and reads no
 * state of its own.
 *
 * There IS an install button now, and there is exactly one thing it can do:
 * ask the main process to open a file that has already passed both a checksum
 * and a Sigstore signature naming this repository's release workflow. It
 * cannot name the file. What it still does not do is swap the running
 * application — that needs a CODE signature, which this project does not yet
 * have (see docs/releasing.md), and the AppImage's in-place replacement is the
 * one exception because an AppImage is a single file the user owns.
 *
 * The manual link stays on screen throughout. Every refusal in `planDownload`
 * ends there, and so does anybody who would simply rather use a browser.
 */
export function UpdateBanner({
  panel,
  busy,
  onDismiss,
  onDisable,
  onDownload,
  onCancelDownload,
  onInstall,
}: {
  readonly panel: UpdatePanel;
  /** A click is in flight. Both buttons write to preferences.json. */
  readonly busy: boolean;
  readonly onDismiss: () => void;
  readonly onDisable: () => void;
  readonly onDownload: () => void;
  readonly onCancelDownload: () => void;
  readonly onInstall: () => void;
}) {
  return (
    <section className="update" aria-label="Update available">
      <header className="update-head">
        <span className="update-badge">Update</span>
        <h2>{panel.headline}</h2>
      </header>

      <p className="update-body">{panel.detail}</p>

      <UpdateFetch
        fetch={panel.fetch}
        busy={busy}
        onDownload={onDownload}
        onCancel={onCancelDownload}
        onInstall={onInstall}
      />

      <details className="update-manual">
        <summary>Install it yourself instead</summary>

        <p className="update-lead">{panel.instructions.headline}</p>

        <ol className="update-steps">
          {panel.instructions.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        {panel.instructions.commands.length > 0 && (
          <ul className="advice-commands">
            {panel.instructions.commands.map((command) => (
              <CommandRow key={command} command={command} />
            ))}
          </ul>
        )}
      </details>

      {/*
       * target="_blank" is not a style choice: it is what routes the link
       * through the main process's setWindowOpenHandler, which opens it in the
       * system browser. A same-window navigation is blocked outright. See
       * Advisories.tsx, which carries the same note.
       */}
      <p className="update-links">
        {panel.link !== undefined && (
          <a href={panel.link.url} target="_blank" rel="noreferrer">
            Download {panel.link.label} in a browser
          </a>
        )}
        <a href={panel.releaseUrl} target="_blank" rel="noreferrer">
          {panel.link === undefined ? 'All downloads and release notes' : 'Release notes'}
        </a>
      </p>

      <p className="update-actions">
        <button type="button" className="link" onClick={onDismiss} disabled={busy}>
          Not now
        </button>
        <button type="button" className="link" onClick={onDisable} disabled={busy}>
          Stop checking for updates
        </button>
      </p>
    </section>
  );
}

/**
 * The in-app download, in whichever state it is in.
 *
 * `verifying` renders a message and NO button on purpose. It is the window in
 * which the whole file exists on disk and has not yet been vouched for, and
 * the one thing this component must never do is offer to open it.
 */
function UpdateFetch({
  fetch,
  busy,
  onDownload,
  onCancel,
  onInstall,
}: {
  readonly fetch: DownloadPresentation;
  readonly busy: boolean;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
  readonly onInstall: () => void;
}) {
  switch (fetch.kind) {
    case 'unavailable':
      return null;

    case 'offer':
      return (
        <p className="update-fetch">
          <button type="button" className="primary" onClick={onDownload} disabled={busy}>
            {fetch.label}
          </button>
        </p>
      );

    case 'progress':
      return (
        <div className="update-fetch">
          <progress
            className="update-progress"
            {...(fetch.percent === undefined ? {} : { value: fetch.percent, max: 100 })}
          />
          <span className="update-fetch-label">{fetch.label}</span>
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        </div>
      );

    case 'verifying':
      return (
        <div className="update-fetch">
          <progress className="update-progress" />
          <span className="update-fetch-label">{fetch.label}</span>
        </div>
      );

    case 'ready':
      return (
        <div className="update-fetch">
          <button type="button" className="primary" onClick={onInstall} disabled={busy}>
            {fetch.label}
          </button>
          <span className="update-verified">{fetch.detail}</span>
        </div>
      );

    case 'installing':
      return (
        <p className="update-fetch">
          <span className="update-fetch-label">{fetch.label}</span>
        </p>
      );

    case 'failed':
      return (
        <div className="update-fetch update-fetch-failed">
          <p role="alert">{fetch.message}</p>
          <button type="button" className="link" onClick={onDownload} disabled={busy}>
            Try again
          </button>
        </div>
      );
  }
}

/** One command with its copy button — the same row the advisories use. */
function CommandRow({ command }: { readonly command: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <li>
      <code>{command}</code>
      <button
        type="button"
        className="link"
        onClick={() => {
          copy(command);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </li>
  );
}
