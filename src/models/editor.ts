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
   * How this editor spells the `dev-container` authority's SPEC — the part
   * after the `+`.
   *
   * This is the fork divergence `remoteScheme` and `folderUriFlag` were added
   * as insurance against, and it turned out to be neither of them:
   *
   *   - `local-folder` — VS Code. The hex of the `devcontainer.local_folder`
   *     label, byte for byte. See `authorityFor`.
   *   - `config-json` — Cursor. The hex of a JSON blob naming the workspace and
   *     its devcontainer.json (`{settingType,workspacePath,devcontainerPath}`),
   *     per Cursor's own "Opening Remote Containers via the CLI" docs.
   *
   * The two are not interchangeable and the failure is silent: Cursor given VS
   * Code's spelling cannot resolve the authority and falls back to opening its
   * default window, which looks exactly like the editor ignoring the flag.
   */
  readonly devContainerSpec: 'local-folder' | 'config-json';
}

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
