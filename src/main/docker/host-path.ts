import type { MaybeHostPath } from '../../domain/index.js';

/**
 * Parse the `devcontainer.local_folder` label into a typed host path.
 *
 * IMPORTANT — what this is and is not for.
 *
 * The result is used for DISPLAY (project name, full path column) and for
 * deciding how confident the UI should look. It is deliberately NOT the input
 * to the editor URI: that has to be the raw label, byte for byte. See
 * src/main/editor/uri.ts for why.
 *
 * So this function is free to normalise separators and be opinionated, and a
 * parse failure is never fatal — it degrades to `unresolved`, which still
 * carries the raw string and a human-readable reason. A container that shows
 * up as a greyed row explaining itself is diagnosable; one silently missing
 * from the list is not.
 */
export function parseLocalFolder(raw: string): MaybeHostPath {
  const value = raw.trim();

  if (value === '') {
    return { kind: 'unresolved', raw, reason: 'The devcontainer.local_folder label was empty.' };
  }

  // \\wsl.localhost\<distro>\home\me\proj  (and the older \\wsl$\ form).
  // Checked before the generic UNC branch, which would otherwise swallow it.
  // The distro group is `*` rather than `+` on purpose. With `+`, a malformed
  // "\\wsl.localhost\" fails this pattern entirely and falls through to the
  // generic UNC branch below, which reports it as an ordinary Windows path —
  // and the empty-distro guard underneath becomes unreachable. Matching it
  // here lets that guard do its job.
  const wsl = /^\\\\wsl(?:\.localhost|\$)\\([^\\]*)\\?(.*)$/i.exec(value);
  if (wsl) {
    const distro = wsl[1] ?? '';
    const rest = (wsl[2] ?? '').replace(/\\/g, '/');
    if (distro === '') {
      return {
        kind: 'unresolved',
        raw,
        reason: 'A WSL path with no distribution name — cannot tell which distro it lives in.',
      };
    }
    return { kind: 'wsl', distro, path: `/${rest}` };
  }

  // \\server\share\path — a real Windows path, just not a local one.
  if (value.startsWith('\\\\')) {
    return { kind: 'windows', path: value.replace(/\//g, '\\') };
  }

  // c:\Users\me\proj or C:/Users/me/proj
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return { kind: 'windows', path: value.replace(/\//g, '\\') };
  }

  // A bare drive letter with no separator ("c:") is a relative path on that
  // drive, not a folder we can act on.
  if (/^[a-zA-Z]:$/.test(value)) {
    return {
      kind: 'unresolved',
      raw,
      reason: 'A bare drive letter with no path.',
    };
  }

  if (value.startsWith('/')) {
    // Note what is NOT decided here: whether this is a native Linux/macOS path
    // or a path inside a WSL distro seen from a VS Code instance running in
    // WSL. The label looks identical in both cases, and nothing else in the
    // container inspect output disambiguates it. Resolving that needs a WSL
    // probe on the host (see docs/roadmap.md, "WSL host paths").
    return { kind: 'posix', path: value };
  }

  return {
    kind: 'unresolved',
    raw,
    reason: 'Not an absolute path in any format boxwarden recognises.',
  };
}

/**
 * Recover the WSL distribution name from a container's bind-mount sources.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `parseLocalFolder` cannot tell a native Linux path from a path inside a WSL
 * distro seen from a VS Code instance running in WSL. Both arrive as
 * `/home/me/proj`, and the label alone carries nothing to separate them.
 *
 * The mounts do. When Docker Desktop's WSL2 backend bind-mounts a folder that
 * lives inside a distro, it rewrites the source through a staging path that
 * names the distro:
 *
 *   /run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/<hash>
 *   /mnt/wsl/docker-desktop-bind-mounts/Ubuntu-22.04/<hash>
 *
 * A native Linux daemon never produces that shape, and neither does a
 * bind-mounted Windows drive (which comes through as
 * `/run/desktop/mnt/host/c/...`). So a match is strong evidence, and no match
 * means "leave it alone" rather than "it is native".
 *
 * BLAST RADIUS IF THIS IS WRONG
 *
 * Display only. An incorrect upgrade changes `formatHostPath` from
 * `/home/me/proj` to `\\wsl.localhost\Ubuntu\home\me\proj` — wrong, visible,
 * and annoying. It cannot break opening the container, because the editor URI
 * is built from the raw label and never from this. That asymmetry is what
 * makes a heuristic acceptable here at all.
 *
 * This is strategy 1 of the three in docs/roadmap.md; `wsl -l -q` matching and
 * prompt-and-cache are still to come, for the cases this misses.
 */
const WSL_BIND_MOUNT = /(?:^|\/)docker-desktop-bind-mounts\/([^/]+)\//;

export function wslDistroFromMountSources(sources: readonly string[]): string | undefined {
  for (const source of sources) {
    const match = WSL_BIND_MOUNT.exec(source);
    const distro = match?.[1];
    if (distro !== undefined && distro !== '') return distro;
  }
  return undefined;
}

/**
 * Upgrade a bare POSIX path to a WSL path when the mounts prove it is one.
 *
 * Only `posix` is eligible. A `windows` path is already unambiguous, a `wsl`
 * path is already resolved, and an `unresolved` one should stay unresolved —
 * attaching a distro to a string we could not parse would be inventing a
 * location rather than discovering it.
 */
export function withWslDistro(path: MaybeHostPath, distro: string | undefined): MaybeHostPath {
  if (distro === undefined || path.kind !== 'posix') return path;
  return { kind: 'wsl', distro, path: path.path };
}
