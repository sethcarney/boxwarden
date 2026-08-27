import type { BinaryDiscovery } from './discovery.js';

/**
 * VS Code only. Insiders, Cursor and Windsurf were supported and were removed
 * deliberately: the app's editor-lifecycle features (and everything to come —
 * quitting the editor from a card) are only ever exercised against VS Code,
 * and shipping launch paths nobody tests is how the Cursor `config-json`
 * divergence got to production silently. Their ATTACHMENT detection stays —
 * see `editor-session.ts` — because warning before a Stop strands a window is
 * true whoever's window it is.
 */
export type KnownEditorId = 'vscode';

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
}

/**
 * Three fields used to sit on `EditorTarget` and were deleted with the forks:
 *
 *   - `remoteScheme` and `folderUriFlag` were insurance against a fork
 *     changing the URI scheme or the flag. None ever did — the real
 *     divergence was elsewhere, see below — so with one editor left they were
 *     two levels of indirection carrying one constant each. The constants now
 *     live where they are used: `vscode-remote://` in `uri.ts`, `--folder-uri`
 *     in `launch.ts`.
 *
 *   - `devContainerSpec` recorded the divergence that DID happen: Cursor
 *     spells the `dev-container` authority as the hex of a JSON blob
 *     (`{settingType,workspacePath,devcontainerPath}`), not the hex of the
 *     `devcontainer.local_folder` label. If fork support ever returns, that is
 *     the field to bring back first — the failure mode is silent, because an
 *     authority the editor cannot resolve just opens a default window.
 */

/**
 * There is deliberately NO `newWindowFlag` here, and no mode alongside the id
 * on `openInEditor`. Both existed, and both were removed once the thing they
 * described turned out not to be a thing the CLI can do.
 *
 * `code --new-window --folder-uri X` does not open a second window on X. VS
 * Code resolves the folder against the windows that are already open BEFORE it
 * decides where to put it, so a folder that is open anywhere focuses that
 * window whatever the flag says — the same refusal the GUI's "Open Folder"
 * makes, and a deliberate one (microsoft/vscode#35207). The forks inherit it.
 *
 * That mattered here because the button offering it only ever appeared when an
 * editor was ATTACHED — i.e. exactly and only in the case the CLI refuses. It
 * could not have worked once. A second window on one folder is
 * `workbench.action.duplicateWorkspaceInNewWindow`, a command inside a window
 * with no CLI spelling, so there is nothing for boxwarden to spawn.
 */

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
