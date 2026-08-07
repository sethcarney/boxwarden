import type { BinaryDiscovery } from './discovery.js';

export type KnownEditorId = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf';

/** Open-ended: a user-configured fork should not require a code change. */
export type EditorId = KnownEditorId | (string & {});

/**
 * Ordered discovery strategies, first hit wins.
 *
 * A list rather than a single strategy because "`code` is often not on PATH
 * on macOS, fall back to probing the app bundle" is really "try these in
 * order", and each editor wants a different order.
 *
 * An alias rather than its own union: terminal emulators are found exactly the
 * same way, so the shape lives in `discovery.ts` and this name survives as the
 * spelling the editor code reads best with.
 */
export type EditorDiscovery = BinaryDiscovery;

export interface EditorTarget {
  readonly id: EditorId;
  readonly displayName: string;
  /** A user override belongs at the front of this list. */
  readonly discovery: readonly EditorDiscovery[];
  /**
   * Almost certainly 'vscode-remote' for every VS Code fork. Configurable as
   * cheap insurance until Phase 4 can verify Cursor and Windsurf empirically —
   * if neither diverges, this field and `folderUriFlag` should be deleted.
   */
  readonly remoteScheme: string;
  /** Almost certainly '--folder-uri'. Same caveat as `remoteScheme`. */
  readonly folderUriFlag: string;
  /**
   * The flag that forces a SECOND window on a folder that already has one.
   *
   * Without it, `code --folder-uri X` finds the window already showing X and
   * focuses that, which is the behaviour boxwarden wants by default: a card
   * saying an editor is attached should offer to bring that window forward, not
   * to open a duplicate of it. `--new-window` is how the user asks for the
   * other thing — a second window on the same container, which is an ordinary
   * way to work (one window per branch, one per agent).
   *
   * Configurable per target for the same reason as the two fields above, and
   * with the same caveat: nobody has confirmed it against a Cursor or Windsurf
   * install.
   */
  readonly newWindowFlag: string;
}

/**
 * Which of the two things "open" means for a container an editor is already
 * attached to.
 *
 * `reuse` is not "reuse whatever window is in front" — that is VS Code's `-r`,
 * and it would hijack an unrelated window. It is the CLI's DEFAULT behaviour,
 * which resolves the folder URI against the open windows and focuses the one
 * that matches. The distinction matters because the wrong one of those two
 * would replace the contents of the window a developer was looking at.
 */
export type OpenInEditorMode = 'reuse' | 'new-window';

/** Total, so a value arriving over IPC can only ever be one of the two arms. */
export function parseOpenInEditorMode(value: unknown): OpenInEditorMode {
  return value === 'new-window' ? 'new-window' : 'reuse';
}

export type ResolvedEditor =
  | {
      readonly ok: true;
      readonly target: EditorTarget;
      readonly binaryPath: string;
      readonly via: EditorDiscovery['kind'];
    }
  | {
      readonly ok: false;
      readonly target: EditorTarget;
      readonly code: 'not-found' | 'not-executable';
    };

/**
 * The `dev-container+<hex>` authority component of the remote URI. Branded so
 * a raw hex string cannot be passed where a built authority is expected.
 */
export type DevContainerAuthority = string & { readonly __brand: 'DevContainerAuthority' };

/**
 * The environment variable that overrides where one editor lives.
 *
 * `BOXWARDEN_EDITOR_CURSOR`, `BOXWARDEN_EDITOR_VSCODE_INSIDERS`, and so on —
 * the id upper-cased with dashes turned into underscores.
 */
export function editorOverrideVariable(id: EditorId): string {
  return `BOXWARDEN_EDITOR_${id.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * A user's explicit path for an editor, as a discovery strategy to put at the
 * FRONT of the target's list.
 *
 * The escape hatch the `explicit-path` arm was always shaped for, and the
 * reason to add it now is concrete: an editor can move its own entry point —
 * Cursor's executable stopped being the IDE — and when that happens the table
 * in this repo is wrong on somebody's machine until a release fixes it. A
 * variable means they are not waiting for one.
 *
 * It is a PATH and not a command line: no arguments, no shell, nothing this
 * app then has to parse. What it can do is name a different binary, which is
 * exactly the decision the table is otherwise making for them.
 */
export function editorOverride(
  id: EditorId,
  env: Readonly<Record<string, string | undefined>>,
): EditorDiscovery | undefined {
  const binaryPath = env[editorOverrideVariable(id)]?.trim();
  return binaryPath === undefined || binaryPath === ''
    ? undefined
    : { kind: 'explicit-path', binaryPath };
}
