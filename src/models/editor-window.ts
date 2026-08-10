import type { DevContainer } from './devcontainer.js';
import type { EditorFlavour } from './editor-session.js';
import { projectName } from './paths.js';

/**
 * Finding the editor window a container has, so Stop can close it first.
 *
 * ## Why this exists, and why it is shaped like this
 *
 * Stopping a container with a VS Code window attached strands the window: the
 * remote server dies underneath it and the window sits there offering to
 * reload something that no longer exists. `editor-session.ts` used to say that
 * the only answer was to warn about it, because **there is no supported way to
 * close a VS Code window from outside it** — and that half is still true. The
 * remote CLI's IPC server handles exactly four commands (`open`,
 * `openExternal`, `status`, `extensionManagement`); the host `code` CLI is the
 * same set; `workbench.action.closeWindow` exists only inside a window.
 *
 * What is left is the one thing every desktop does expose: asking the WINDOW
 * MANAGER to close a top-level window, which is the same event the title bar's
 * X sends. VS Code then runs its own shutdown — hot exit, the dirty-buffer
 * prompt, workspace state — so this is not a kill and it does not take unsaved
 * work with it. That is the whole reason it is `WM_CLOSE` and never a signal.
 *
 * ## The safety rule
 *
 * Closing the WRONG window is the only failure here that costs the user
 * anything, so every rule below is written to fail towards **closing nothing**.
 * A window is only ever a candidate when all three of these hold:
 *
 *   1. it belongs to a process that is one of the editors we know, and — when
 *      the container told us which editor is attached — to THAT editor;
 *   2. its title carries the remote marker `[Dev Container`, which VS Code and
 *      its forks append to `rootName` for a dev container and for nothing else;
 *   3. the workspace name immediately before that marker is this container's
 *      own folder, matched on a word boundary rather than as a substring.
 *
 * And when both the container's declared name and the window's are known, they
 * must agree — a check that costs nothing and rules out two checkouts of one
 * repository sitting in differently-named parents.
 *
 * Everything here is a pure function over strings the platform handed us. The
 * enumerating and the closing live in `src/main/window/`.
 */

/**
 * One top-level window, as this machine's window manager describes it.
 *
 * `handle` is whatever the platform wants back when asked to close it — an
 * HWND on Windows, a wmctrl id on X11, the title itself on macOS. It is opaque
 * here on purpose: this module reads titles and never interprets a handle,
 * which is what lets one matcher serve three very different backends.
 */
export interface DesktopWindow {
  readonly handle: string;
  /** The owning process's name, without any `.exe`. */
  readonly process: string;
  readonly title: string;
}

/**
 * Process names per editor, lowercased.
 *
 * A list per flavour rather than one name because the three platforms disagree
 * about what a process is called: macOS reports the bundle's process name,
 * Windows the image name without its extension, Linux `/proc/<pid>/comm`
 * (which is also truncated at 15 characters, though nothing here is that long).
 *
 * Matched by EQUALITY, not by prefix — which is what makes `code` safe to list
 * beside `code - insiders`. It is the same lesson `SERVER_DIRECTORIES` learned
 * about prefixes, solved by not having the problem instead of by ordering.
 */
const PROCESS_NAMES: Readonly<Record<Exclude<EditorFlavour, 'unknown'>, readonly string[]>> = {
  vscode: ['code', 'visual studio code'],
  'vscode-insiders': ['code - insiders', 'code-insiders', 'visual studio code - insiders'],
  cursor: ['cursor'],
  windsurf: ['windsurf'],
};

/**
 * Every process name above, flattened.
 *
 * Exported because the macOS enumerator has to narrow BEFORE it reads, not
 * after: System Events walks the accessibility tree one window at a time, and
 * asking it for every window of every running application takes long enough to
 * be felt on the Stop button. Windows and X11 enumerate the whole desktop in
 * one call and filter in Node, where `windowFlavour` is the only reader.
 */
export const EDITOR_PROCESS_NAMES: readonly string[] = [
  ...new Set(Object.values(PROCESS_NAMES).flat()),
];

/** Which editor owns a window, or undefined when it is not one of ours. */
export function windowFlavour(processName: string): EditorFlavour | undefined {
  const name = processName
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === '') return undefined;
  for (const [flavour, names] of Object.entries(PROCESS_NAMES)) {
    if (names.includes(name)) return flavour as EditorFlavour;
  }
  return undefined;
}

/**
 * The marker VS Code puts in a window title for a dev container.
 *
 * `rootName` becomes `<workspace> [Dev Container: <name>]` for a remote folder,
 * and the bracketed half is the remote indicator's own wording. Matching the
 * opening `[Dev Container` rather than the whole thing keeps this working for a
 * container whose name has a `]` in it, and for the older spelling that omitted
 * the name entirely.
 */
const REMOTE_MARKER = '[Dev Container';

/** What a dev container window's title says about which container it is. */
export interface DevContainerTitle {
  /** Everything before the remote marker — the last part of which is the workspace name. */
  readonly beforeMarker: string;
  /** The container's declared name, from `[Dev Container: <name>]`, when it carries one. */
  readonly label?: string;
}

/**
 * Split a window title at the dev container marker, or answer undefined.
 *
 * Undefined is the answer for every ordinary window — a local folder, a
 * Settings tab, another application entirely — and it is the first and
 * cheapest of the three gates. Nothing without this marker is ever a candidate.
 */
export function parseDevContainerTitle(title: string): DevContainerTitle | undefined {
  const index = title.indexOf(REMOTE_MARKER);
  if (index === -1) return undefined;

  const beforeMarker = title.slice(0, index).trimEnd();
  const rest = title.slice(index + REMOTE_MARKER.length);
  const closing = rest.indexOf(']');
  // `: ` and not `:` — the space is part of the indicator's wording, and
  // keeping it out of the name is what lets the name be compared verbatim.
  const label = rest.startsWith(': ') && closing > 1 ? rest.slice(2, closing).trim() : undefined;

  return { beforeMarker, ...(label === undefined || label === '' ? {} : { label }) };
}

/**
 * Whether the workspace name sitting just before the marker is `name`.
 *
 * A suffix test on a WORD BOUNDARY rather than an equality test or a
 * `includes`, and both halves of that are deliberate:
 *
 *   - Not equality, because the title usually carries the active editor's file
 *     name first (`ContainerCard.tsx - boxwarden`), joined by a separator the
 *     user can redefine through `window.title`. A suffix test does not have to
 *     know what the separator is, and survives a folder name containing one.
 *   - Not `includes`, because that would let a container called `warden` match
 *     the window of one called `boxwarden`, which is the exact class of mistake
 *     that ends with somebody's editor closing under them.
 *
 * The boundary is WHITESPACE, not merely "not a letter", and that distinction
 * is the whole safety margin. A folder called `not-boxwarden` ends with
 * `boxwarden` behind a hyphen, and a hyphen is not a letter — so the looser
 * test matches a completely unrelated container's window. What actually sits
 * between the file name and the workspace name in a VS Code title is a
 * separator with spaces around it (` - ` by default, and `window.titleSeparator`
 * for anyone who has changed it), so whitespace is both the tighter rule and
 * the accurate one. A separator with no spaces in it makes this answer false,
 * nothing is closed, and Stop degrades to what it did before this feature —
 * which is the direction every rule in this file is written to fail in.
 *
 * Case-insensitive: two of the three platforms have case-insensitive
 * filesystems, so a folder whose name differs only in case is not a distinction
 * worth defending against a user's own window.
 */
export function namesWorkspace(beforeMarker: string, name: string): boolean {
  if (name === '') return false;
  const haystack = beforeMarker.toLowerCase();
  const needle = name.toLowerCase();
  if (!haystack.endsWith(needle)) return false;

  const boundary = haystack.at(-needle.length - 1);
  // Undefined means the title was exactly the workspace name, which is what a
  // window with no editor open looks like.
  return boundary === undefined || /\s/.test(boundary);
}

/**
 * The container's own name, out of the `devcontainer.metadata` label.
 *
 * LAST fragment wins, the same rule and for the same reason as
 * `resolveRemoteUser`: the label is ordered image → features → devcontainer.json
 * and the spec lets later entries override earlier ones, so the developer's own
 * config has to beat anything a feature declared.
 *
 * Every failure answers undefined rather than throwing. The shape of this label
 * is not stable across CLI versions, and a name is a *strengthening* signal
 * here — not having one costs a little precision, and mis-parsing one into a
 * throw would cost the whole feature.
 */
export function declaredContainerName(metadataRaw: string | undefined): string | undefined {
  if (metadataRaw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataRaw);
  } catch {
    return undefined;
  }

  const fragments = Array.isArray(parsed) ? parsed : [parsed];
  let name: string | undefined;
  for (const fragment of fragments) {
    if (typeof fragment !== 'object' || fragment === null) continue;
    const value = (fragment as { name?: unknown }).name;
    if (typeof value === 'string' && value.trim() !== '') name = value.trim();
  }
  return name;
}

/** Everything the matcher needs to recognise one container's windows. */
export interface EditorWindowCriteria {
  /**
   * Every spelling of the workspace's own name that could appear in a title.
   *
   * Two sources, because the two path spaces disagree often enough to matter: a
   * repository cloned as `boxwarden` and mounted at `/workspaces/boxwarden`
   * gives one name, and a `workspaceFolder` set explicitly in devcontainer.json
   * gives another. VS Code titles the window after the folder it OPENED, which
   * is the container-side one — the host-side name is the fallback for a
   * container that never declared one.
   */
  readonly names: readonly string[];
  /** The container's declared name, when the metadata label carries one. */
  readonly label?: string;
  /**
   * Which editors are attached, from the container's own process table.
   *
   * EMPTY means "we could not tell" — an `unknown` attachment — and is treated
   * as "any editor we recognise" rather than as "none". That is the same call
   * `ClaudeStatus` makes about its own `unknown`, one layer along: uncertainty
   * must not silently become a narrower answer than the truth.
   */
  readonly editors: readonly EditorFlavour[];
}

/** Basename of a container-side (always POSIX) path. */
function containerFolderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function editorWindowCriteria(
  container: DevContainer,
  editors: readonly EditorFlavour[],
): EditorWindowCriteria {
  const names = new Set<string>();

  if (container.workspaceFolder !== undefined) {
    const name = containerFolderName(container.workspaceFolder);
    if (name !== '') names.add(name);
  }
  const hostName = projectName(container.localFolder);
  if (hostName !== '') names.add(hostName);

  const label = declaredContainerName(container.labels.metadataRaw);

  return {
    names: [...names],
    ...(label === undefined ? {} : { label }),
    editors: editors.filter((flavour) => flavour !== 'unknown'),
  };
}

/**
 * The windows that belong to this container, out of everything on the desktop.
 *
 * Returns an array because one container legitimately has several windows —
 * "New window" on a card is a button — and closing one of them while leaving
 * the rest to be stranded would be the original bug with extra steps.
 */
export function matchEditorWindows(
  windows: readonly DesktopWindow[],
  criteria: EditorWindowCriteria,
): readonly DesktopWindow[] {
  if (criteria.names.length === 0) return [];

  return windows.filter((window) => {
    const flavour = windowFlavour(window.process);
    if (flavour === undefined) return false;
    // Narrowed to the attached editor when the container told us which one it
    // is, so a Cursor window on a same-named folder is not collateral for a
    // VS Code container. An empty list is the `unknown` arm and matches any.
    if (criteria.editors.length > 0 && !criteria.editors.includes(flavour)) return false;

    const title = parseDevContainerTitle(window.title);
    if (title === undefined) return false;
    if (!criteria.names.some((name) => namesWorkspace(title.beforeMarker, name))) return false;

    // Both known and disagreeing is the one case this rules out: two checkouts
    // of one repository in differently-named parents share a declared name but
    // not a folder name, and two unrelated containers can share a folder name
    // but not a declared one. Either being unknown is not evidence of anything.
    return criteria.label === undefined || title.label === undefined
      ? true
      : criteria.label.toLowerCase() === title.label.toLowerCase();
  });
}

/**
 * Read the `handle<TAB>process<TAB>title` table the Windows and macOS helpers
 * print.
 *
 * Tab-separated and line-based rather than JSON, because two of the three
 * producers are shell dialects whose JSON support is a liability: PowerShell's
 * `ConvertTo-Json` emits a bare object rather than an array for a single row,
 * and AppleScript has no JSON at all. A window title cannot contain a newline
 * and has no business containing a tab, so the format costs nothing and the
 * parser is six lines.
 *
 * The title keeps every remaining tab by joining the rest of the line back
 * together — losing the tail of a title would be a silent narrowing of what the
 * matcher gets to see.
 */
export function parseWindowTable(text: string): readonly DesktopWindow[] {
  const windows: DesktopWindow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [handle, process, ...rest] = line.split('\t');
    if (handle === undefined || process === undefined || rest.length === 0) continue;
    const title = rest.join('\t').trim();
    if (handle.trim() === '' || title === '') continue;
    windows.push({ handle: handle.trim(), process: process.trim(), title });
  }
  return windows;
}

/**
 * One line of `wmctrl -l -p`: `<id> <desktop> <pid> <host> <title>`.
 *
 * Split on runs of whitespace for the first four fields and take the rest
 * verbatim, because only the title can contain a space. The pid comes back
 * alongside because X11 names the owning process nowhere in this output — the
 * caller reads `/proc/<pid>/comm` for that, which is the one thing wmctrl
 * cannot tell it.
 */
export function parseWmctrlLine(
  line: string,
): { handle: string; pid: number; title: string } | undefined {
  const match = /^(\S+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
  if (match === null) return undefined;
  const [, handle, , rawPid, , title] = match;
  if (handle === undefined || rawPid === undefined || title === undefined) return undefined;
  const trimmed = title.trim();
  if (trimmed === '') return undefined;
  return { handle, pid: Number(rawPid), title: trimmed };
}

/** Which editors the matched windows belong to — what the notice names. */
export function flavoursOf(windows: readonly DesktopWindow[]): readonly EditorFlavour[] {
  const flavours = new Set<EditorFlavour>();
  for (const window of windows) {
    const flavour = windowFlavour(window.process);
    if (flavour !== undefined) flavours.add(flavour);
  }
  return [...flavours];
}

/**
 * What happened when Stop tried to close the container's editor window.
 *
 * Six arms rather than a boolean, because they call for five different
 * sentences and one silence. The distinction this type exists to keep is the
 * one between **`none`** — nothing was attached, so there was nothing to do —
 * and **`not-found`** — something IS attached and we could not find its window,
 * which is the case where the user is about to be surprised and has to be told.
 * Collapsing those is how a Stop that stranded a window looks identical to one
 * that had nothing to strand.
 */
export type EditorWindowClosure =
  /** No editor attached. The ordinary case, and the one that renders nothing. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'closed';
      readonly windows: number;
      readonly editors: readonly EditorFlavour[];
    }
  /**
   * An editor is attached, the desktop answered, and no window matched.
   *
   * This arm carries EVIDENCE, and that is not decoration. Every other failure
   * here names its own fix — install wmctrl, tick the Accessibility box, this
   * is Wayland — but "no window matched" is a disagreement between three
   * strings the user cannot see: the process name, the window title, and the
   * folder name this app derived from a container label. Without them the
   * message is a dead end, so `saw` is the same answer `DockerEnvironment.attempts`
   * gives for a socket that did not connect: here is what was tried.
   */
  | {
      readonly kind: 'not-found';
      readonly editors: readonly EditorFlavour[];
      /** Every window owned by an editor process, `process\ttitle`. */
      readonly saw: readonly string[];
      /** How many windows were enumerated in total — zero is its own diagnosis. */
      readonly enumerated: number;
      /** The names this container was matched under, so a mismatch is visible. */
      readonly names: readonly string[];
    }
  /** This desktop offers no way to close another application's window. */
  | { readonly kind: 'unsupported'; readonly reason: string }
  /** There is a way and it failed. */
  | { readonly kind: 'failed'; readonly reason: string }
  /**
   * We asked, and the window is still there.
   *
   * Almost always VS Code holding up its own close over an unsaved buffer, and
   * the one arm that STOPS the stop: a window kept open by a "save this?"
   * prompt is a window whose container must not go out from under it.
   */
  | { readonly kind: 'still-open'; readonly windows: number };
