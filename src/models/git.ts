/**
 * Which branch a dev container's workspace is on.
 *
 * The answer comes from the HOST filesystem, not from inside the container:
 * a dev container's workspace is a bind mount of `devcontainer.local_folder`,
 * so the checkout the container sees IS the checkout on disk beside it. Reading
 * `.git/HEAD` there costs two small file reads and needs no Docker call at all
 * — and it answers for a STOPPED container, which is precisely when "wait,
 * which branch was that one on?" gets asked.
 *
 * ## Why not ask the container
 *
 * `docker exec git rev-parse --abbrev-ref HEAD` would run a program inside a
 * container the app did not build, on a container whose process namespace is
 * attacker-influenced by anyone who can create containers on the daemon, and
 * would answer only while it is running — and only if git is installed in the
 * image. Same trade as `top` versus `exec` in claude.ts, one step further: here
 * there is nothing to call at all.
 *
 * Everything in this file is pure. The file reads live in
 * `src/main/git/status.ts`, which does no parsing of its own.
 */

import type { HostPlatform } from './advice.js';
import type { MaybeHostPath } from './paths.js';
import { formatHostPath } from './paths.js';

/**
 * What the workspace folder's HEAD says.
 *
 * `none` and `unknown` are kept apart for the reason `ClaudeStatus` keeps
 * `none` apart from `unknown`: one is an answer ("that folder is not a git
 * checkout"), the other is the absence of one ("we could not look"). Folding
 * them would make a folder on an unreachable filesystem indistinguishable from
 * a plain directory, and the reason string is the only thing that could ever
 * explain a missing branch to the user.
 */
export type GitStatus =
  | { readonly kind: 'branch'; readonly branch: string }
  /** HEAD points straight at a commit — a checked-out tag, a bisect, a rebase. */
  | { readonly kind: 'detached'; readonly commit: string }
  /** The folder exists and is not inside a git work tree. */
  | { readonly kind: 'none' }
  /** We could not read it, or could not reach it. Never rendered as a branch. */
  | { readonly kind: 'unknown'; readonly reason: string };

/** `ref: refs/heads/<name>` — the symbolic form, which is the common case. */
const HEAD_REF_PREFIX = 'ref: ';
const BRANCH_PREFIX = 'refs/heads/';

/** A commit id: git writes them lower-case, but a hand-written HEAD may not. */
const OBJECT_ID = /^[0-9a-f]{7,64}$/i;

/**
 * Read a `.git/HEAD`.
 *
 * The whole file is one line, and the two shapes it can take are the two arms
 * this returns. A ref outside `refs/heads/` (git allows HEAD to name any ref)
 * is reported by its last segment rather than refused: it is still the honest
 * name of what is checked out.
 */
export function parseGitHead(contents: string): GitStatus {
  const line = contents.trim();
  if (line === '') return { kind: 'unknown', reason: 'The repository’s HEAD file is empty.' };

  if (line.startsWith(HEAD_REF_PREFIX)) {
    const ref = line.slice(HEAD_REF_PREFIX.length).trim();
    if (ref === '') {
      return { kind: 'unknown', reason: 'The repository’s HEAD names no ref.' };
    }
    // A branch that has never been committed to has a HEAD pointing at a ref
    // with no object behind it. That is still the branch the user is on, and
    // saying so beats saying nothing on a freshly initialised repo.
    const branch = ref.startsWith(BRANCH_PREFIX)
      ? ref.slice(BRANCH_PREFIX.length)
      : lastSegment(ref);
    return branch === ''
      ? { kind: 'unknown', reason: 'The repository’s HEAD names no ref.' }
      : { kind: 'branch', branch };
  }

  if (OBJECT_ID.test(line)) return { kind: 'detached', commit: line.toLowerCase() };

  return { kind: 'unknown', reason: 'The repository’s HEAD is in an unfamiliar shape.' };
}

function lastSegment(ref: string): string {
  const cut = ref.lastIndexOf('/');
  return cut === -1 ? ref : ref.slice(cut + 1);
}

/**
 * Read a `.git` FILE — the indirection git writes for a worktree or a submodule.
 *
 * Worth handling rather than treating as "not a repo": one worktree per agent
 * is a common way to run several Claude Code sessions over one repository, and
 * those are exactly the containers whose branch a user cannot keep in their
 * head. The pointer may be relative, so the caller resolves it against the
 * folder the file was read from.
 */
export function parseGitDirPointer(contents: string): string | undefined {
  const line = contents.trim();
  const prefix = 'gitdir:';
  if (!line.startsWith(prefix)) return undefined;
  const target = line.slice(prefix.length).trim();
  return target === '' ? undefined : target;
}

/** Seven characters, which is what git itself abbreviates to by default. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * The path to look in for a container's checkout, or undefined when there is
 * nowhere on THIS machine to look.
 *
 * Note what this is not: the string handed to an editor. That one is built from
 * the raw label byte for byte (see src/main/editor/uri.ts) because the Dev
 * Containers extension round-trips it. Nothing is launched from the value
 * returned here — it is opened read-only — so normalising a WSL path into the
 * `\\wsl.localhost\…` form Windows can actually open is safe here and would be
 * a bug there. Same distinction as `comparableFolder` versus `authorityFor`.
 *
 * A path whose flavour does not match the host is `undefined` rather than a
 * guess: a Windows label on a Linux host means the container list came from a
 * daemon that is not this machine's, and reading `C:\Users\…` off a Linux root
 * would at best find nothing and at worst find something unrelated.
 */
export function readableHostFolder(
  folder: MaybeHostPath,
  platform: HostPlatform,
): string | undefined {
  switch (folder.kind) {
    case 'unresolved':
      return undefined;
    case 'posix':
      return platform === 'linux' || platform === 'darwin' ? folder.path : undefined;
    case 'windows':
      return platform === 'win32' ? folder.path : undefined;
    case 'wsl':
      // Only Windows can open a UNC path into a distro; from anywhere else this
      // describes a filesystem on another machine entirely.
      return platform === 'win32' ? formatHostPath(folder) : undefined;
  }
}
