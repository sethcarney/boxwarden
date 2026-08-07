import { describe, expect, it } from 'vitest';
import type { BranchListing, GitBranch } from './git.js';
import {
  branchSwitchBlockedReason,
  canSwitchTo,
  gitInvocation,
  parseBranchRefs,
  parseDubiousOwnership,
  parseGitDirPointer,
  parseGitHead,
  parseWorkingTree,
  readableHostFolder,
  shortCommit,
  treeBlockedReason,
} from './git.js';

describe('parseGitHead', () => {
  it('reads the branch out of a symbolic HEAD', () => {
    expect(parseGitHead('ref: refs/heads/main\n')).toEqual({ kind: 'branch', branch: 'main' });
  });

  /** Branch names contain slashes far more often than not on a work machine. */
  it('keeps every segment of a namespaced branch name', () => {
    expect(parseGitHead('ref: refs/heads/feature/rate-limiting\n')).toEqual({
      kind: 'branch',
      branch: 'feature/rate-limiting',
    });
  });

  it('reads a detached HEAD as a commit', () => {
    const sha = '4f2c1ab9d3e5f70123456789abcdef0123456789';
    expect(parseGitHead(`${sha}\n`)).toEqual({ kind: 'detached', commit: sha });
  });

  it('lower-cases a commit id so two readings of one commit compare equal', () => {
    expect(parseGitHead('4F2C1AB9D3E5F70123456789ABCDEF0123456789')).toEqual({
      kind: 'detached',
      commit: '4f2c1ab9d3e5f70123456789abcdef0123456789',
    });
  });

  /**
   * A branch with no commits behind it still names what the user is on. A repo
   * that has just been `git init`ed is the common case, and saying nothing
   * there would look like a failure rather than an empty repository.
   */
  it('reports an unborn branch by name', () => {
    expect(parseGitHead('ref: refs/heads/trunk')).toEqual({ kind: 'branch', branch: 'trunk' });
  });

  /** git allows HEAD to name a ref outside refs/heads; the last segment is still the honest name. */
  it('falls back to the last segment for a ref outside refs/heads', () => {
    expect(parseGitHead('ref: refs/remotes/origin/main')).toEqual({
      kind: 'branch',
      branch: 'main',
    });
  });

  it('does not claim a branch it could not read', () => {
    expect(parseGitHead('')).toMatchObject({ kind: 'unknown' });
    expect(parseGitHead('ref:   ')).toMatchObject({ kind: 'unknown' });
    expect(parseGitHead('not a head at all')).toMatchObject({ kind: 'unknown' });
    // Too short to be an object id, so it is not silently reported as one.
    expect(parseGitHead('4f2c1')).toMatchObject({ kind: 'unknown' });
  });
});

describe('parseGitDirPointer', () => {
  /**
   * The worktree case, which is the one that matters: one worktree per agent is
   * a common way to run several sessions over a single repository, and those
   * are exactly the containers whose branch nobody can keep in their head.
   */
  it('follows an absolute gitdir pointer', () => {
    expect(parseGitDirPointer('gitdir: /home/dev/code/app/.git/worktrees/feature\n')).toBe(
      '/home/dev/code/app/.git/worktrees/feature',
    );
  });

  it('keeps a relative pointer relative, for the caller to resolve', () => {
    expect(parseGitDirPointer('gitdir: ../.git/worktrees/feature')).toBe(
      '../.git/worktrees/feature',
    );
  });

  it('answers nothing for a file that is not a pointer', () => {
    expect(parseGitDirPointer('')).toBeUndefined();
    expect(parseGitDirPointer('ref: refs/heads/main')).toBeUndefined();
    expect(parseGitDirPointer('gitdir:')).toBeUndefined();
  });
});

describe('shortCommit', () => {
  it('abbreviates to the seven characters git itself uses', () => {
    expect(shortCommit('4f2c1ab9d3e5f70123456789abcdef0123456789')).toBe('4f2c1ab');
  });
});

describe('readableHostFolder', () => {
  it('reads a posix folder on a posix host', () => {
    expect(readableHostFolder({ kind: 'posix', path: '/home/dev/app' }, 'linux')).toBe(
      '/home/dev/app',
    );
    expect(readableHostFolder({ kind: 'posix', path: '/Users/dev/app' }, 'darwin')).toBe(
      '/Users/dev/app',
    );
  });

  it('reads a windows folder on Windows', () => {
    expect(readableHostFolder({ kind: 'windows', path: 'C:\\Users\\dev\\app' }, 'win32')).toBe(
      'C:\\Users\\dev\\app',
    );
  });

  /**
   * The one place a host path IS normalised. Safe only because nothing is
   * launched from the result — see the note in git.ts, and `authorityFor`,
   * which must never do this.
   */
  it('turns a WSL folder into the UNC path Windows can open', () => {
    expect(
      readableHostFolder({ kind: 'wsl', distro: 'Ubuntu', path: '/home/dev/app' }, 'win32'),
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app');
  });

  /**
   * A folder whose flavour does not match the host is on another machine —
   * reading `C:\Users\…` against a Linux root would find nothing at best and
   * something unrelated at worst.
   */
  it('refuses a folder that belongs to a different operating system', () => {
    expect(
      readableHostFolder({ kind: 'windows', path: 'C:\\Users\\dev\\app' }, 'linux'),
    ).toBeUndefined();
    expect(readableHostFolder({ kind: 'posix', path: '/home/dev/app' }, 'win32')).toBeUndefined();
    expect(
      readableHostFolder({ kind: 'wsl', distro: 'Ubuntu', path: '/home/dev/app' }, 'darwin'),
    ).toBeUndefined();
  });

  it('refuses a label that could not be parsed at all', () => {
    expect(
      readableHostFolder(
        { kind: 'unresolved', raw: 'relative/not/absolute', reason: 'x' },
        'linux',
      ),
    ).toBeUndefined();
  });
});

describe('parseBranchRefs', () => {
  it('reads name, current marker and worktree out of the three columns', () => {
    expect(
      parseBranchRefs(['main\t*\t/home/dev/app', 'feature/rate-limiting\t \t'].join('\n')),
    ).toEqual([
      { name: 'main', current: true },
      { name: 'feature/rate-limiting', current: false },
    ]);
  });

  /**
   * The subtlety the format has: `%(worktreepath)` is set for the current
   * branch too, naming the worktree that was asked. Carrying it would disable
   * the branch the user is on with a sentence pointing at their own folder.
   */
  it('does not report the current branch as checked out elsewhere', () => {
    const [branch] = parseBranchRefs('main\t*\t/home/dev/app\n');
    expect(branch).toEqual({ name: 'main', current: true });
    expect(branch).not.toHaveProperty('checkedOutAt');
  });

  /**
   * The case the field exists for: one worktree per agent, which is the setup
   * that made the branch chip worth building in the first place.
   */
  it('reports a branch another worktree holds', () => {
    expect(parseBranchRefs('agent-3\t \t/home/dev/app-worktrees/agent-3\n')).toEqual([
      { name: 'agent-3', current: false, checkedOutAt: '/home/dev/app-worktrees/agent-3' },
    ]);
  });

  /** A worktree path can contain spaces; a branch name cannot contain a tab. */
  it('keeps a worktree path with spaces in it whole', () => {
    expect(parseBranchRefs('wip\t \t/Users/dev/My Projects/app\n')[0]?.checkedOutAt).toBe(
      '/Users/dev/My Projects/app',
    );
  });

  it('ignores blank lines and an empty listing', () => {
    expect(parseBranchRefs('')).toEqual([]);
    expect(parseBranchRefs('\n\n')).toEqual([]);
  });
});

describe('parseWorkingTree', () => {
  it('reads an empty porcelain status as clean', () => {
    expect(parseWorkingTree('')).toEqual({ kind: 'clean' });
    expect(parseWorkingTree('\n')).toEqual({ kind: 'clean' });
  });

  it('counts the changed files', () => {
    expect(parseWorkingTree(' M src/a.ts\nM  src/b.ts\nD  src/c.ts\n')).toEqual({
      kind: 'dirty',
      changed: 3,
    });
  });
});

describe('branchSwitchBlockedReason', () => {
  const clean = { kind: 'clean' } as const;
  const dirty = { kind: 'dirty', changed: 2 } as const;
  const other: GitBranch = { name: 'other', current: false };

  it('allows an ordinary branch on a clean tree', () => {
    expect(branchSwitchBlockedReason(other, clean)).toBeUndefined();
  });

  it('blocks the branch already checked out here', () => {
    expect(branchSwitchBlockedReason({ name: 'main', current: true }, clean)).toContain('already');
  });

  it('blocks a branch another worktree holds, and names that worktree', () => {
    const reason = branchSwitchBlockedReason(
      { name: 'agent-3', current: false, checkedOutAt: '/home/dev/wt/agent-3' },
      clean,
    );
    expect(reason).toContain('/home/dev/wt/agent-3');
  });

  /**
   * The ordering that matters: a dirty tree blocks every row and is said once
   * above the list, so a row with a reason of its own must keep it rather than
   * repeating the shared one.
   */
  it('prefers the row-specific reason over the dirty tree', () => {
    expect(
      branchSwitchBlockedReason(
        { name: 'agent-3', current: false, checkedOutAt: '/home/dev/wt/agent-3' },
        dirty,
      ),
    ).toContain('worktree');
  });

  it('falls back to the dirty tree for a row with nothing else wrong', () => {
    expect(branchSwitchBlockedReason(other, dirty)).toContain('uncommitted');
  });
});

describe('treeBlockedReason', () => {
  it('says nothing about a clean tree', () => {
    expect(treeBlockedReason({ kind: 'clean' })).toBeUndefined();
  });

  it('agrees in number with one change', () => {
    expect(treeBlockedReason({ kind: 'dirty', changed: 1 })).toContain('1 uncommitted change.');
  });

  it('agrees in number with several', () => {
    expect(treeBlockedReason({ kind: 'dirty', changed: 4 })).toContain('4 uncommitted changes');
  });

  /**
   * The posture, pinned: neither offer is made, because a stash boxwarden
   * created is one the user has to remember to pop and a discarded change is
   * one nobody can get back.
   */
  it('offers neither to stash nor to discard', () => {
    const reason = treeBlockedReason({ kind: 'dirty', changed: 2 }) ?? '';
    expect(reason).toContain('will not discard or stash');
  });
});

describe('canSwitchTo', () => {
  const listing: BranchListing = {
    kind: 'ready',
    tree: { kind: 'clean' },
    branches: [
      { name: 'main', current: true },
      { name: 'feature/x', current: false },
      { name: 'agent-3', current: false, checkedOutAt: '/home/dev/wt/agent-3' },
    ],
  };

  it('allows a branch git itself listed', () => {
    expect(canSwitchTo('feature/x', listing)).toBe(true);
  });

  /**
   * The security answer as well as the UI one. `switchBranch` runs this against
   * a listing the MAIN process read, so the only strings that ever reach
   * `git checkout` are ones git itself printed under refs/heads — a renderer
   * cannot name an option, a path, or a branch of some other repository.
   */
  it('refuses a name that is not in the listing', () => {
    expect(canSwitchTo('--force', listing)).toContain('not a local branch');
    expect(canSwitchTo('../../etc/passwd', listing)).toContain('not a local branch');
  });

  it('refuses everything when the listing could not be read', () => {
    expect(canSwitchTo('main', { kind: 'unavailable', reason: 'git was not found.' })).toBe(
      'git was not found.',
    );
  });

  it('refuses a branch held by another worktree', () => {
    expect(canSwitchTo('agent-3', listing)).toContain('worktree');
  });

  it('refuses every branch on a dirty tree', () => {
    expect(canSwitchTo('feature/x', { ...listing, tree: { kind: 'dirty', changed: 1 } })).toContain(
      'uncommitted',
    );
  });
});

describe('gitInvocation', () => {
  it('runs the host git against a posix path', () => {
    expect(gitInvocation({ kind: 'posix', path: '/home/dev/app' })).toEqual({
      file: 'git',
      leading: ['--no-optional-locks', '-C', '/home/dev/app'],
    });
  });

  it('runs the host git against a windows path', () => {
    expect(gitInvocation({ kind: 'windows', path: 'C:\\Users\\dev\\app' })).toEqual({
      file: 'git',
      leading: ['--no-optional-locks', '-C', 'C:\\Users\\dev\\app'],
    });
  });

  /**
   * The bug this function exists for. Windows git against
   * `\\wsl.localhost\<distro>\…` sees files owned by the Linux user and refuses
   * on `safe.directory`, so the distro's own git runs instead — same files,
   * matching owner, and no 9P round trip per ref.
   */
  it('reaches into the distro for a WSL workspace, over the LINUX path', () => {
    expect(gitInvocation({ kind: 'wsl', distro: 'dev', path: '/home/seth/project' })).toEqual({
      file: 'wsl.exe',
      leading: ['-d', 'dev', '--exec', 'git', '--no-optional-locks', '-C', '/home/seth/project'],
    });
  });

  /** `--exec` and not `--`: without it wsl.exe hands the line to a shell first. */
  it('always passes --exec, and never the UNC spelling', () => {
    const { leading } = gitInvocation({ kind: 'wsl', distro: 'dev', path: '/home/seth/p' });
    expect(leading).toContain('--exec');
    expect(leading).not.toContain('--');
    expect(leading.some((arg) => arg.includes('wsl.localhost'))).toBe(false);
  });
});

describe('parseDubiousOwnership', () => {
  /** Exactly what git prints, down to the leading tab on the command line. */
  const REFUSAL = [
    "fatal: detected dubious ownership in repository at '//wsl.localhost/dev/home/seth/app'",
    'To add an exception for this directory, call:',
    '',
    "\tgit config --global --add safe.directory '%(prefix)///wsl.localhost/dev/home/seth/app'",
    '',
  ].join('\n');

  /**
   * Taken from git's output rather than built from the folder. git's spelling
   * of a UNC path in this config is `%(prefix)///…`, which exists because `//`
   * is meaningful to the config parser — reconstructing it means reimplementing
   * that rule, copying it means reimplementing none of it.
   */
  it('lifts git’s own suggested command out, %(prefix) and all', () => {
    expect(parseDubiousOwnership(REFUSAL)).toBe(
      "git config --global --add safe.directory '%(prefix)///wsl.localhost/dev/home/seth/app'",
    );
  });

  it('says nothing about an unrelated failure', () => {
    expect(parseDubiousOwnership('fatal: not a git repository')).toBeUndefined();
    expect(parseDubiousOwnership('')).toBeUndefined();
  });

  /**
   * A refusal whose suggestion git did not print — an older version, or a
   * locale that reworded it. The caller then falls back to showing git's raw
   * words, which is worse than a copy button and better than a blank box.
   */
  it('says nothing when the refusal carries no command to copy', () => {
    expect(
      parseDubiousOwnership("fatal: detected dubious ownership in repository at '/x'"),
    ).toBeUndefined();
  });
});
