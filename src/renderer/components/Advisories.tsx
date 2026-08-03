import type { Advice } from '../../models/index.js';
import { startsExpanded } from '../advisories.js';
import { useCopyToClipboard } from '../viewmodels/useCopyToClipboard.js';
import { useDisclosure } from '../viewmodels/useDisclosure.js';

/**
 * The setup advice, rendered.
 *
 * Every word of the text comes from src/models/advice.ts — this component
 * decides layout and nothing else. That split is deliberate: the wording is the
 * feature here (it is what a user with a broken setup actually reads), and
 * keeping it in a pure module means it is unit-tested rather than proofread.
 *
 * The commands are shown, not run. boxwarden will not `wsl --install` on
 * someone's behalf: those commands reboot machines, install system components
 * and use sudo, and an app that does that from a button press is an app nobody
 * should trust with a Docker socket. Copy-and-paste keeps the user in charge
 * and, just as usefully, keeps them able to read what they are about to run.
 *
 * TWO WAYS TO GET AN ADVISORY OUT OF THE WAY, AND THEY ARE NOT THE SAME
 *
 *   - Collapsing folds the body away and leaves the title. It is per-card,
 *     per-run, and the default follows severity (see `startsExpanded`).
 *   - Hiding takes the card off this screen entirely, and persists. It is only
 *     offered where there is somewhere else to read it — `onHide` is passed on
 *     the main screen and NOT on the setup page, which is that somewhere else.
 *
 * Nothing here can delete an advisory. The setup page lists every one this
 * scan produced, hidden or not.
 */

const SEVERITY_LABEL = {
  error: 'Blocking',
  warning: 'Warning',
  info: 'Note',
} as const;

interface Props {
  readonly advice: readonly Advice[];
  /** Names the region for screen readers; a page showing two lists needs two names. */
  readonly label?: string | undefined;
  /** Omitted where hiding would be the last copy of the advisory — see above. */
  readonly onHide?: ((id: string) => void) | undefined;
  /** Offered on the setup page's hidden list, to put a card back on the main screen. */
  readonly onRestore?: ((id: string) => void) | undefined;
}

export function Advisories({ advice, label = 'Setup advice', onHide, onRestore }: Props) {
  if (advice.length === 0) return null;

  return (
    <section className="advisories" aria-label={label}>
      {advice.map((entry) => (
        <AdviceCard key={entry.id} advice={entry} onHide={onHide} onRestore={onRestore} />
      ))}
    </section>
  );
}

function AdviceCard({
  advice,
  onHide,
  onRestore,
}: {
  readonly advice: Advice;
  readonly onHide?: ((id: string) => void) | undefined;
  readonly onRestore?: ((id: string) => void) | undefined;
}) {
  const disclosure = useDisclosure(startsExpanded(advice.severity));
  const bodyId = `advice-${advice.id}`;

  return (
    <article className={`advice advice-${advice.severity}`}>
      <header className="advice-head">
        <span className="advice-badge">{SEVERITY_LABEL[advice.severity]}</span>

        {/*
         * The heading itself is the control. A separate chevron button would
         * put the smallest hit target on the card next to the largest piece of
         * dead text, and `aria-expanded` on the heading's button is what tells
         * a screen reader that the prose below is the thing being toggled.
         */}
        <h2>
          <button
            type="button"
            className="advice-toggle"
            aria-expanded={disclosure.expanded}
            aria-controls={bodyId}
            onClick={disclosure.toggle}
          >
            {advice.title}
          </button>
        </h2>

        <div className="advice-actions">
          {onHide !== undefined && (
            <button
              type="button"
              className="link"
              title="Takes this off the main screen. It stays on the Setup page."
              onClick={() => {
                onHide(advice.id);
              }}
            >
              Hide
            </button>
          )}
          {onRestore !== undefined && (
            <button
              type="button"
              className="link"
              title="Puts this back on the main screen."
              onClick={() => {
                onRestore(advice.id);
              }}
            >
              Show again
            </button>
          )}
        </div>
      </header>

      {/*
       * Unmounted rather than hidden with CSS: a collapsed advisory carrying
       * three copy buttons would otherwise leave them in the tab order, so
       * tabbing through a folded panel would land on controls nobody can see.
       */}
      {disclosure.expanded && (
        <div id={bodyId}>
          <p className="advice-body">{advice.body}</p>

          {advice.commands.length > 0 && (
            <ul className="advice-commands">
              {advice.commands.map((command) => (
                <CommandRow key={command} command={command} />
              ))}
            </ul>
          )}

          {advice.links.length > 0 && (
            <p className="advice-links">
              {advice.links.map((link) => (
                /*
                 * target="_blank" is what routes this through the main process's
                 * setWindowOpenHandler, which opens it in the system browser and
                 * denies the Electron window. A same-window navigation would be
                 * blocked outright by the will-navigate handler, so this is not a
                 * style choice — it is the only spelling that works.
                 *
                 * rel="noreferrer" costs nothing here (the handler never opens a
                 * window, so there is no opener to leak) and is right if that ever
                 * changes.
                 */
                <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              ))}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * One command, with the copy button that is the whole point of showing it.
 *
 * The clipboard write and its self-clearing "Copied" flash come from
 * `useCopyToClipboard`, the same ViewModel the unbuilt-project list uses. This
 * row grew its own copy of that state first, and it had the exact bug the hook
 * exists to prevent: its `setTimeout` was never cancelled, so unmounting the
 * advisory within the flash — which happens the moment the user fixes their
 * setup and discovery succeeds, or collapses the card — set state on a gone
 * component.
 */
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
