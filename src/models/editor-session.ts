import { hasNoProcessTable, readCommandLines } from './claude.js';

/**
 * Whether an editor is attached to a container.
 *
 * ## What this is for
 *
 * Stopping a container with a VS Code window attached to it does not close the
 * window. It strands it: the remote server dies underneath, and the window sits
 * there offering to reload something that is no longer running. The user's next
 * move is to work out which window belonged to which container and close it by
 * hand, which is a puzzle they did not have before they clicked Stop.
 *
 * boxwarden cannot close that window — see the note at the bottom — so it does
 * the next thing, which is the same thing it does for a Claude Code session:
 * say so on the Stop button, and let the click be an informed one.
 *
 * ## What is actually detected
 *
 * The editor's SERVER, running inside the container. VS Code, Cursor and
 * Windsurf all install one under `~/.<flavour>-server/bin/<commit>/` and run it
 * with node; every extension host and pty host beneath it carries the same path.
 * Read out of the process table this app already fetches for `parseClaudeProcesses`
 * — one `top` per live container, not two.
 *
 * **The signal is "a server is running", which is a superset of "a window is
 * open".** VS Code leaves its server up for a few minutes after the last window
 * disconnects, so a warning can outlive the window that earned it by a little.
 * That is the right way round: warning about a window that has just closed
 * costs a moment's thought, and failing to warn about one that is open costs
 * the work in it. The wording says "attached", not "open", for that reason.
 *
 * ## Why not just close the window
 *
 * There is no supported way. The `code` CLI can open windows and install
 * extensions; it cannot enumerate or close them, and VS Code exposes no local
 * endpoint for it. What is left is finding the host process and killing it,
 * which would take unsaved editor buffers with it — a data-loss risk this app
 * has no business taking on a button labelled Stop.
 */

/** Which editor left its server behind. `unknown` is a server we did not recognise. */
export type EditorFlavour = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf' | 'unknown';

export type EditorAttachment =
  /** Container is not running; there is no process table to read. */
  | { readonly kind: 'not-applicable' }
  /** Asked, and nothing is attached — the state that makes Stop safe. */
  | { readonly kind: 'none' }
  | { readonly kind: 'attached'; readonly editors: readonly EditorFlavour[] }
  /** The table could not be read. Kept apart from `none` for the reason `ClaudeStatus` does. */
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Server directories, by flavour.
 *
 * Matched as a PATH SEGMENT (`/.vscode-server/`), never as a bare word. The
 * lesson is the one `looksLikeClaudeCode` learned: a container with a
 * `/workspaces/vscode-extensions` checkout runs plenty of commands containing
 * the string "vscode", and a warning that fires on those is a warning nobody
 * believes by the second week.
 *
 * Insiders is listed before stable because `.vscode-server-insiders` contains
 * `.vscode-server` as a prefix, and the first match wins.
 */
const SERVER_DIRECTORIES: readonly (readonly [EditorFlavour, string])[] = [
  ['vscode-insiders', '/.vscode-server-insiders/'],
  ['vscode', '/.vscode-server/'],
  ['cursor', '/.cursor-server/'],
  ['windsurf', '/.windsurf-server/'],
];

/** Every flavour whose server appears in a command line. */
function flavourOf(command: string): EditorFlavour | undefined {
  for (const [flavour, directory] of SERVER_DIRECTORIES) {
    if (command.includes(directory)) return flavour;
  }
  return undefined;
}

/**
 * Turn a `top` response into an attachment.
 *
 * `unknown` rather than a throw for every shape we cannot read, and never a
 * confident `none`: this decorates a destructive button, and "we could not
 * tell" must not be delivered as "nothing is attached".
 */
export function parseAttachedEditors(titles: unknown, processes: unknown): EditorAttachment {
  const table = readCommandLines(titles, processes);
  if (!table.ok) return { kind: 'unknown', reason: table.reason };

  // A Set because one attached window is many processes — the server, the
  // extension host, a pty host per terminal — all carrying the same path. The
  // question is which editors are attached, not how many processes they run.
  const flavours = new Set<EditorFlavour>();
  for (const command of table.commands) {
    const flavour = flavourOf(command);
    if (flavour !== undefined) flavours.add(flavour);
  }

  return flavours.size === 0 ? { kind: 'none' } : { kind: 'attached', editors: [...flavours] };
}

/**
 * Classify a failed `top`, the counterpart to `classifyTopFailure`.
 *
 * A stopped container has no process table, which is the ordinary case rather
 * than a failure — mapping it to `unknown` would put "could not tell" on every
 * stopped card in the list.
 */
export function classifyEditorTopFailure(message: string): EditorAttachment {
  return hasNoProcessTable(message)
    ? { kind: 'not-applicable' }
    : { kind: 'unknown', reason: message };
}

/** How each flavour is spelled to a human. */
const DISPLAY_NAMES: Readonly<Record<EditorFlavour, string>> = {
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  unknown: 'An editor',
};

export function editorDisplayName(flavour: EditorFlavour): string {
  return DISPLAY_NAMES[flavour];
}

/** Whether anything is attached across a group — what "Stop all" has to weigh. */
export function attachedEditorsIn(
  attachments: readonly (EditorAttachment | undefined)[],
): readonly EditorFlavour[] {
  const flavours = new Set<EditorFlavour>();
  for (const attachment of attachments) {
    if (attachment?.kind !== 'attached') continue;
    for (const flavour of attachment.editors) flavours.add(flavour);
  }
  return [...flavours];
}
