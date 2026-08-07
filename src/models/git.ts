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

/*
 * ---- Switching branches ----
 *
 * Reading a branch is two file reads and needs no git at all (above). CHANGING
 * one is the opposite: it rewrites the index and the working tree, and the only
 * correct implementation of that is git's own. So this half is a parser for
 * what `git` says plus the decision about when not to call it — the spawn lives
 * in src/main/git/branches.ts, and everything here stays pure.
 *
 * The rule the whole feature is shaped around: **boxwarden never discards the
 * user's work.** A checkout that would have to carry, stash or clobber
 * uncommitted changes is refused with a reason, not attempted with a flag. That
 * is the same call as showing `devcontainer up` instead of running it, and it
 * is why there is no `--force` anywhere below.
 */

/** One local branch, as `git for-each-ref` reported it. */
export interface GitBranch {
  readonly name: string;
  /** HEAD is on it, in the worktree that was asked. */
  readonly current: boolean;
  /**
   * Another worktree of the same repository has it checked out.
   *
   * Worth a field of its own rather than letting the checkout fail: git refuses
   * this outright, and one worktree per agent is the pattern that made the
   * branch chip worth building — so on the machines this feature is FOR, it is
   * a common state rather than an exotic one.
   */
  readonly checkedOutAt?: string;
}

/**
 * Whether the working tree has changes a checkout would have to deal with.
 *
 * `changed` is a count and not a list: what the user needs from the menu is
 * whether switching is available and roughly how much is in the way, and a file
 * list is something their editor is already showing them better than a tooltip
 * can.
 */
export type WorkingTree =
  { readonly kind: 'clean' } | { readonly kind: 'dirty'; readonly changed: number };

/**
 * What the branch menu renders.
 *
 * `unavailable` carries the reason for the same reason `GitStatus.unknown`
 * does: "there is no git on this machine" and "that folder is not a
 * repository" and "git exited 128" are three different things to tell someone,
 * and a menu that was simply empty would say none of them.
 */
export type BranchListing =
  | {
      readonly kind: 'ready';
      readonly branches: readonly GitBranch[];
      readonly tree: WorkingTree;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * The separator in the `for-each-ref` format below. A TAB, because it is the
 * one character a branch name cannot contain — git's own `check-ref-format`
 * rejects control characters — and a worktree PATH can contain spaces.
 */
const FIELD = '\t';

/**
 * The format string, kept here beside its parser so the two cannot drift.
 *
 * `%(worktreepath)` needs git 2.23 (2019). Older git fails the whole command
 * with "unknown field name", which surfaces as `unavailable` carrying that
 * text — a legible failure, and a better trade than dropping the field and
 * offering a click that git will reject.
 */
export const BRANCH_REF_FORMAT = `%(refname:short)${FIELD}%(HEAD)${FIELD}%(worktreepath)`;

/**
 * Parse `git for-each-ref --format=<BRANCH_REF_FORMAT> refs/heads`.
 *
 * The one subtlety is `%(worktreepath)`, which is set for the CURRENT branch
 * too — it names the worktree being asked. Reporting that as "checked out
 * elsewhere" would disable the branch the user is already on with a sentence
 * pointing at their own folder, so `current` wins and clears it.
 */
export function parseBranchRefs(stdout: string): readonly GitBranch[] {
  const branches: GitBranch[] = [];

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [name = '', head = '', worktree = ''] = line.split(FIELD);
    if (name === '') continue;

    // git writes '*' for the checked-out branch and a space for the rest.
    const current = head.trim() === '*';
    const checkedOutAt = worktree.trim();

    branches.push({
      name,
      current,
      ...(current || checkedOutAt === '' ? {} : { checkedOutAt }),
    });
  }

  return branches;
}

/**
 * Parse `git status --porcelain --untracked-files=no`.
 *
 * Untracked files are excluded deliberately, and it is the difference between a
 * useful predicate and an annoying one: git carries untracked files across a
 * checkout without complaint, so counting them would block switching on a repo
 * whose only "change" is a `node_modules` its `.gitignore` missed. What is
 * counted is what git will actually refuse over.
 */
export function parseWorkingTree(stdout: string): WorkingTree {
  const changed = stdout.split('\n').filter((line) => line.trim() !== '').length;
  return changed === 0 ? { kind: 'clean' } : { kind: 'dirty', changed };
}

/**
 * Why this branch cannot be switched to, or undefined.
 *
 * Ordered most-specific first, because the string ends up in one item's tooltip:
 * a dirty tree blocks EVERY item and is said once above the list
 * (`treeBlockedReason`), whereas "you are on it" and "another worktree has it"
 * are facts about this row and would be lost if the shared reason won.
 */
export function branchSwitchBlockedReason(
  branch: GitBranch,
  tree: WorkingTree,
): string | undefined {
  if (branch.current) return 'This is the branch the workspace is already on.';
  if (branch.checkedOutAt !== undefined) {
    return `git will not check one branch out in two worktrees at once — ${branch.name} is already checked out in ${branch.checkedOutAt}.`;
  }
  return treeBlockedReason(tree);
}

/**
 * Why NOTHING can be switched to, or undefined. Said once, above the list.
 *
 * The wording names the two ways out and neither of them is boxwarden: a stash
 * this app created is one the user has to remember to pop, and a discarded
 * change is one nobody can get back. Refusing and saying why is the whole
 * feature — see the note at the top of this section.
 */
export function treeBlockedReason(tree: WorkingTree): string | undefined {
  if (tree.kind === 'clean') return undefined;
  const files =
    tree.changed === 1 ? '1 uncommitted change' : `${String(tree.changed)} uncommitted changes`;
  return `The workspace has ${files}. Commit or stash them first — boxwarden will not discard or stash your work for you.`;
}

/**
 * Whether a switch to `name` may be attempted at all, decided from a listing.
 *
 * The main process runs this a SECOND time, against a listing it re-read, just
 * before spawning the checkout. The menu's copy decides what is disabled; this
 * copy is the one that decides what happens, because between opening a menu and
 * clicking in it a person can save a file — and a dirty-tree check the renderer
 * performed thirty seconds ago is not a check.
 */
export function canSwitchTo(name: string, listing: BranchListing): true | string {
  if (listing.kind === 'unavailable') return listing.reason;

  const branch = listing.branches.find((candidate) => candidate.name === name);
  // Not a refusal about the tree: it means the name is not one git listed. The
  // main process treats that as the security answer as well as the UI one —
  // nothing is ever passed to `git checkout` that git did not itself name.
  if (branch === undefined) {
    return `${name} is not a local branch of this repository.`;
  }

  return branchSwitchBlockedReason(branch, listing.tree) ?? true;
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
