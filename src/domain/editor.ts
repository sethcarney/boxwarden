export type KnownEditorId = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf';

/** Open-ended: a user-configured fork should not require a code change. */
export type EditorId = KnownEditorId | (string & {});

/**
 * Ordered discovery strategies, first hit wins.
 *
 * A list rather than a single strategy because "`code` is often not on PATH
 * on macOS, fall back to probing the app bundle" is really "try these in
 * order", and each editor wants a different order. Keeping it as data means
 * adding Windsurf is a config entry, not a new code branch.
 */
export type EditorDiscovery =
  | { readonly kind: 'explicit-path'; readonly binaryPath: string }
  | { readonly kind: 'path-lookup'; readonly command: string }
  | {
      readonly kind: 'macos-bundle';
      readonly bundleId: string;
      readonly cliRelativePath: string;
    }
  | { readonly kind: 'well-known-dir'; readonly paths: readonly string[] };

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
