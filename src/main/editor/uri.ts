import type { ContainerPath, DevContainerAuthority, HostPath } from '../../models/index.js';

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

/**
 * Percent-encode a host path's segments, leaving a Windows drive letter alone.
 *
 * `encodeURIComponent` would turn `c:` into `c%3A`, which VS Code does decode
 * correctly — but a URI a user may end up reading in an error message or
 * pasting into a shell should look like a path, and there is no ambiguity to
 * resolve: a colon in the first segment of a `file:` path is a drive letter.
 */
function encodeHostSegments(path: string): string {
  return path
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join('/');
}

/**
 * The URI that opens a folder on this machine — the "not built yet" case.
 *
 * This is NOT `devContainerUri`, and the difference is the whole point. There
 * is no container to reattach to yet, so there is no `devcontainer.local_folder`
 * label and no hex authority to build from one. What we can do is open the
 * folder locally, at which point the Dev Containers extension notices the
 * `.devcontainer/` and offers "Reopen in Container" — which is the step that
 * creates the container and the label, after which the folder appears in the
 * ordinary list and every other verb in this app works on it.
 *
 * So the flavours diverge:
 *
 *   - `posix`   → `file:///home/me/proj`
 *   - `windows` → `file:///c:/Users/me/proj`, or `file://server/share/proj`
 *                 for a UNC path, where the host really is the authority.
 *   - `wsl`     → `vscode-remote://wsl+Ubuntu/home/me/proj`. A `file:` URI is
 *                 wrong here: `\\wsl.localhost\Ubuntu\...` opens the folder
 *                 over 9P as a Windows share, and a repo opened that way is
 *                 slow, has the wrong file modes, and cannot see the Linux
 *                 toolchain the dev container expects.
 *
 * Unlike the reattach URI this one is built from a PARSED path, and safely so:
 * nothing is being matched against a string another program wrote. It only has
 * to name a folder that exists.
 */
export function folderUri(folder: HostPath): string {
  switch (folder.kind) {
    case 'posix': {
      const path = folder.path.startsWith('/') ? folder.path : `/${folder.path}`;
      return `file://${encodeHostSegments(path)}`;
    }

    case 'wsl': {
      const path = folder.path.startsWith('/') ? folder.path : `/${folder.path}`;
      return `vscode-remote://wsl+${encodeURIComponent(folder.distro)}${encodeHostSegments(path)}`;
    }

    case 'windows': {
      const slashed = folder.path.replace(/\\/g, '/');
      if (slashed.startsWith('//')) {
        // //server/share/dir — the server is the URI's authority, not part of
        // its path, which is the one case where `file:` uses a real host.
        const rest = slashed.slice(2);
        const cut = rest.indexOf('/');
        const host = cut === -1 ? rest : rest.slice(0, cut);
        const path = cut === -1 ? '' : rest.slice(cut);
        return `file://${encodeURIComponent(host)}${encodeHostSegments(path)}`;
      }
      const absolute = slashed.startsWith('/') ? slashed : `/${slashed}`;
      return `file://${encodeHostSegments(absolute)}`;
    }
  }
}
