import { describe, expect, it } from 'vitest';
import { parseGitDirPointer, parseGitHead, readableHostFolder, shortCommit } from './git.js';

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
