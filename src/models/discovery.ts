/**
 * How to find a binary on this machine.
 *
 * Shared by editors and terminal emulators, because the question is the same
 * one both times: "the user has some program installed, where is it?" The
 * answer differs per program and per OS, and the only thing that generalises
 * is the ORDER in which you try — hence a list of strategies rather than a
 * single lookup, with the first hit winning.
 *
 * Keeping this as data means adding Windsurf, or kitty, is an entry in a table
 * rather than a new branch in the resolver.
 */
export type BinaryDiscovery =
  | { readonly kind: 'explicit-path'; readonly binaryPath: string }
  | { readonly kind: 'path-lookup'; readonly command: string }
  | {
      readonly kind: 'macos-bundle';
      readonly bundleId: string;
      readonly cliRelativePath: string;
    }
  | { readonly kind: 'well-known-dir'; readonly paths: readonly string[] };

/** The result of walking a `BinaryDiscovery` list, with the winning strategy kept for diagnostics. */
export type ResolvedBinary =
  | { readonly ok: true; readonly binaryPath: string; readonly via: BinaryDiscovery['kind'] }
  | { readonly ok: false; readonly code: 'not-found' | 'not-executable' };
