import type { DevContainer, ContainerId, DockerEnvironment, EditorId } from '../domain/index.js';

/**
 * The main <-> renderer contract.
 *
 * Domain types cross the boundary unchanged. Electron's IPC uses the
 * structured clone algorithm, which preserves `Date` — so `startedAt` arrives
 * in the renderer as a real Date, not a string, and the branded string types
 * (`ContainerId`, `ContainerPath`) survive as their underlying strings. That
 * is why there is no parallel set of "wire" types here: a second copy of
 * `DevContainer` that had to be kept in sync with the first would be a
 * standing invitation for the two to drift.
 *
 * The one thing that does NOT survive is a class instance or a function, so
 * everything below is plain data.
 */

/**
 * One complete look at the world: what Docker looked like, and what was found
 * there. Both halves travel together deliberately — a container list with no
 * environment attached cannot distinguish "Docker is up and you have no dev
 * containers" from "we never reached Docker", and those need very different
 * screens. The renderer narrows on `environment.api.ok` to tell them apart.
 */
export interface DiscoverySnapshot {
  readonly scannedAt: Date;
  readonly environment: DockerEnvironment;
  /** Always empty when `environment.api.ok` is false. */
  readonly containers: readonly DevContainer[];
}

/**
 * Lifecycle actions report failure as data rather than throwing across IPC.
 * An exception thrown in a main-process handler reaches the renderer as an
 * opaque "Error invoking remote method" string with the real message buried,
 * which is precisely the information the UI needs to show.
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type OpenInEditorFailure =
  /** The container exposed no workspace path, so there is nothing to open. */
  | 'no-workspace-folder'
  /** devcontainer.local_folder could not be parsed into a host path. */
  | 'unresolved-host-path'
  /** No binary found for the requested editor. */
  | 'editor-not-found'
  /** The binary was found but the spawn failed. */
  | 'launch-failed';

export type OpenInEditorResult =
  | { readonly ok: true; readonly editorId: EditorId; readonly uri: string }
  | {
      readonly ok: false;
      readonly code: OpenInEditorFailure;
      readonly message: string;
      /** Present when the URI was built but launching it failed — useful for "copy URI" fallback. */
      readonly uri?: string;
    };

/** An editor offered in the UI, with whether it was actually found on this machine. */
export interface EditorOption {
  readonly id: EditorId;
  readonly displayName: string;
  readonly available: boolean;
}

export const IPC = {
  discover: 'boxwarden:discover',
  start: 'boxwarden:start',
  stop: 'boxwarden:stop',
  listEditors: 'boxwarden:list-editors',
  openInEditor: 'boxwarden:open-in-editor',
} as const;

/**
 * The surface exposed on `window.boxwarden`. Declared here rather than in the
 * preload so the renderer can import the type without importing preload code,
 * which would drag Electron into the browser bundle.
 */
export interface BoxwardenApi {
  discover(): Promise<DiscoverySnapshot>;
  start(id: ContainerId): Promise<ActionResult>;
  stop(id: ContainerId): Promise<ActionResult>;
  listEditors(): Promise<readonly EditorOption[]>;
  openInEditor(id: ContainerId, editorId: EditorId): Promise<OpenInEditorResult>;
}
