import type { EditorOption } from '../../shared/ipc.js';
import { discoveryStrategyLabel } from '../format.js';

/**
 * Which editor binary boxwarden found, and how.
 *
 * The counterpart to `<EndpointAttempts>` on the setup page, sharing its markup
 * and its stylesheet because it answers the same shape of question about a
 * different resource — and it exists for the same reason that one does: an app
 * that only says "found" or "not found" can be confidently wrong in a way
 * nobody can investigate.
 *
 * The report that prompted it: "Open in Cursor" launched something, and what
 * appeared was an empty window with no folder in it. From inside the app there
 * was no way to learn the one fact that separates the two explanations — WHICH
 * of two very different programs had been resolved. An editor ships a CLI
 * (`bin/cursor`, `cursor.cmd`) beside a GUI executable (`Cursor.exe`,
 * `Cursor.app`), and they do not handle `--folder-uri` identically; on Windows
 * the resolver deliberately skips the `.cmd` shim because Node cannot spawn one
 * without a shell, so the GUI binary is what it lands on. A path here settles
 * in one glance what a bug report otherwise takes three messages to establish.
 *
 * Shown whether or not anything is wrong, exactly like the endpoint list.
 */
export function EditorInventory({ editors }: { readonly editors: readonly EditorOption[] }) {
  if (editors.length === 0) return null;

  return (
    <ul className="attempts">
      {editors.map((editor) => (
        <li key={editor.id}>
          {/* The path is the answer, so it takes the `<code>` slot the endpoint
              list gives the socket — same column, same selectable treatment. */}
          <code>{editor.binaryPath ?? editor.displayName}</code>
          <span className="origin">
            {editor.binaryPath === undefined
              ? 'not on PATH, and not in any of the usual install locations'
              : `${editor.displayName}${editor.via === undefined ? '' : ` — ${discoveryStrategyLabel(editor.via)}`}`}
          </span>
          <span className={editor.available ? 'ok' : 'fail'}>
            {editor.available ? 'found' : 'not found'}
          </span>
        </li>
      ))}
    </ul>
  );
}
