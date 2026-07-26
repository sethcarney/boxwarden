/**
 * Two path spaces, two types.
 *
 * The editor URI consumes one of each:
 *
 *   vscode-remote://dev-container+<hex of HostPath>/<ContainerPath>
 *
 * Those are different filesystems. As two bare `string`s, transposing them
 * compiles cleanly and only misfires on someone else's OS. Keeping them
 * distinct makes that a type error instead.
 */

/**
 * A path as the HOST OS understands it. Never a path inside a container.
 *
 * The `wsl` arm requires `distro` because `\\wsl.localhost\<distro>\...`
 * cannot be constructed without it — the type refuses to hold a half-built
 * WSL path. Resolution order for `distro` is decided in Phase 3b:
 * container bind-mount source -> `wsl -l -q` match -> prompt once and cache.
 * When every strategy fails the path is `UnresolvedPath`, not a guess.
 */
export type HostPath =
  | { readonly kind: 'posix'; readonly path: string }
  | { readonly kind: 'windows'; readonly path: string }
  | { readonly kind: 'wsl'; readonly distro: string; readonly path: string };

/**
 * A host path we could not confidently parse. Discovery keeps these rather
 * than dropping the container: a greyed-out row showing the raw label
 * explains itself, a missing row is a bug report nobody can diagnose.
 */
export interface UnresolvedPath {
  readonly kind: 'unresolved';
  /** Exactly what the Docker label contained. */
  readonly raw: string;
  /** Why parsing gave up — shown in the UI, so write it for a human. */
  readonly reason: string;
}

export type MaybeHostPath = HostPath | UnresolvedPath;

/** A path inside the container's filesystem. */
export type ContainerPath = string & { readonly __brand: 'ContainerPath' };

export function asContainerPath(path: string): ContainerPath {
  return path as ContainerPath;
}

/** Path separator for each host flavour. WSL paths are Linux paths. */
function separatorFor(host: HostPath): '/' | '\\' {
  return host.kind === 'windows' ? '\\' : '/';
}

/**
 * Basename of a host path — the project name shown in the list.
 *
 * Derived rather than stored: it is a pure function of `localFolder`, and a
 * stored copy can only drift. Separator handling differs per flavour, so it
 * has to dispatch on `kind` regardless.
 */
export function projectName(host: MaybeHostPath): string {
  if (host.kind === 'unresolved') return host.raw;

  const sep = separatorFor(host);
  const trimmed = host.path.replace(/[/\\]+$/, '');
  const idx = trimmed.lastIndexOf(sep);
  const base = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return base === '' ? trimmed : base;
}

/** Human-readable form of a host path, for the "full host path" column. */
export function formatHostPath(host: MaybeHostPath): string {
  switch (host.kind) {
    case 'posix':
    case 'windows':
      return host.path;
    case 'wsl':
      return `\\\\wsl.localhost\\${host.distro}${host.path.replace(/\//g, '\\')}`;
    case 'unresolved':
      return host.raw;
  }
}
