import { useCallback, useState } from 'react';
import type { Advice } from '../../models/index.js';

/**
 * The setup advice, rendered.
 *
 * Every word of the text comes from src/domain/advice.ts — this component
 * decides layout and nothing else. That split is deliberate: the wording is the
 * feature here (it is what a user with a broken setup actually reads), and
 * keeping it in a pure module means it is unit-tested rather than proofread.
 *
 * The commands are shown, not run. boxwarden will not `wsl --install` on
 * someone's behalf: those commands reboot machines, install system components
 * and use sudo, and an app that does that from a button press is an app nobody
 * should trust with a Docker socket. Copy-and-paste keeps the user in charge
 * and, just as usefully, keeps them able to read what they are about to run.
 */

const SEVERITY_LABEL = {
  error: 'Blocking',
  warning: 'Warning',
  info: 'Note',
} as const;

export function Advisories({ advice }: { readonly advice: readonly Advice[] }) {
  if (advice.length === 0) return null;

  return (
    <section className="advisories" aria-label="Setup advice">
      {advice.map((entry) => (
        <AdviceCard key={entry.id} advice={entry} />
      ))}
    </section>
  );
}

function AdviceCard({ advice }: { readonly advice: Advice }) {
  return (
    <article className={`advice advice-${advice.severity}`}>
      <header className="advice-head">
        <span className="advice-badge">{SEVERITY_LABEL[advice.severity]}</span>
        <h2>{advice.title}</h2>
      </header>

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
    </article>
  );
}

/** One command, with the copy button that is the whole point of showing it. */
function CommandRow({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        // Reverts on its own. A button stuck reading "Copied" is ambiguous the
        // second time the user needs it.
        setTimeout(() => setCopied(false), 1_500);
      },
      () => setCopied(false),
    );
  }, [command]);

  return (
    <li>
      <code>{command}</code>
      <button type="button" className="link" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </li>
  );
}
