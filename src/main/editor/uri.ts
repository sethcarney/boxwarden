import type { ContainerPath, DevContainerAuthority } from '../../domain/index.js';

/**
 * Build the `vscode-remote://` URI that reattaches an editor to a running dev
 * container.
 *
 *   vscode-remote://dev-container+<hex>/<container path>
 *
 * <hex> is the hex-encoded UTF-8 of the HOST folder path. Not a hash — a
 * reversible encoding, which is why the same folder always produces the same
 * authority and why VS Code can reuse an existing window for it.
 */

/**
 * The authority is built from the RAW label, never from a parsed or normalised
 * path. This is the single most important detail in this file.
 *
 * The Dev Containers extension wrote `devcontainer.local_folder` by hex-encoding
 * a specific string, and it will only match that container again if it decodes
 * to the identical string. Normalising `C:/x` to `C:\x`, trimming a trailing
 * slash, or lowercasing a drive letter all produce a *valid-looking* URI that
 * points at a container which does not exist — so VS Code helpfully offers to
 * build a new one. Round-tripping the label untouched is what makes reattach
 * work.
 *
 * The corollary: `parseLocalFolder` may be as opinionated as it likes, because
 * nothing here depends on it.
 */
export function authorityFor(localFolderRaw: string): DevContainerAuthority {
  const hex = Array.from(new TextEncoder().encode(localFolderRaw))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `dev-container+${hex}` as DevContainerAuthority;
}

/** Inverse of the hex step, for tests and for explaining a URI in diagnostics. */
export function decodeAuthority(authority: DevContainerAuthority): string | undefined {
  const hex = authority.startsWith('dev-container+')
    ? authority.slice('dev-container+'.length)
    : undefined;
  if (hex === undefined || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Percent-encode a container path for use as the URI's path component.
 *
 * Per-segment rather than whole-string, so the separators survive.
 * `encodeURIComponent` is the right tool per segment: it escapes the
 * characters that would otherwise terminate the path (`?`, `#`) or be read as
 * structure, and leaves ordinary path characters alone.
 */
function encodeContainerPath(path: ContainerPath): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * `localFolderRaw` is the label verbatim; `workspaceFolder` is the path inside
 * the container. Returns undefined when the label is empty, since there is no
 * authority to build and a URI without one would silently open the wrong thing.
 */
export function devContainerUri(
  localFolderRaw: string,
  workspaceFolder: ContainerPath,
): string | undefined {
  if (localFolderRaw.trim() === '') return undefined;

  const authority = authorityFor(localFolderRaw);
  const path = encodeContainerPath(workspaceFolder);
  const absolute = path.startsWith('/') ? path : `/${path}`;
  return `vscode-remote://${authority}${absolute}`;
}
