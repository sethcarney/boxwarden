import type { UpdatePanel } from '../presenters.js';
import { useCopyToClipboard } from '../viewmodels/useCopyToClipboard.js';

/**
 * "A newer boxwarden exists, and here is how to install it."
 *
 * Deliberately the same shape as an advisory, because it is the same kind of
 * thing: a fact the app noticed, what to do about it, and the exact command to
 * type. Every word comes from the ViewModel — `updatePanel` in presenters.ts
 * over `updateInstructions` in the Model — so this file decides layout and
 * nothing else.
 *
 * There is no Install button, and the steps are not folded away behind a
 * disclosure. They were both, once: boxwarden used to fetch the artefact and
 * verify it, and these steps were the fallback for when it refused. It no
 * longer does either — see the note at the top of src/models/update.ts — so
 * this IS the path, and a path hidden under "Install it yourself instead" is a
 * path the user has to go looking for.
 */
export function UpdateBanner({
  panel,
  busy,
  onDismiss,
  onDisable,
}: {
  readonly panel: UpdatePanel;
  /** A click is in flight. Both buttons write to preferences.json. */
  readonly busy: boolean;
  readonly onDismiss: () => void;
  readonly onDisable: () => void;
}) {
  return (
    <section className="update" aria-label="Update available">
      <header className="update-head">
        <span className="update-badge">Update</span>
        <h2>{panel.headline}</h2>
      </header>

      <p className="update-body">{panel.detail}</p>

      {/*
       * target="_blank" is not a style choice: it is what routes the link
       * through the main process's setWindowOpenHandler, which opens it in the
       * system browser. A same-window navigation is blocked outright. See
       * Advisories.tsx, which carries the same note.
       */}
      {panel.link !== undefined && (
        <p className="update-fetch">
          <a className="update-download" href={panel.link.url} target="_blank" rel="noreferrer">
            Download {panel.link.label}
          </a>
        </p>
      )}

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

      <p className="update-links">
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
