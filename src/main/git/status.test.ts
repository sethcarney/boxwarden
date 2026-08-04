import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGitStatus } from './status.js';

/**
 * Filesystem tests, on the same grounds as `projects/scan.test.ts`: the rule is
 * "no Docker daemon and no display", not "no filesystem", and finding a `.git`
 * is exactly the kind of code whose bugs — a worktree pointer, a walk that
 * stops one level short, a folder that is not a repository at all — only show
 * up against a real directory tree.
 *
 * The trees are hand-built rather than produced by running `git init`: the
 * point is to pin the shapes git writes, and shelling out to git would make the
 * suite depend on git being installed and on which version.
 */

let root: string;

async function repo(path: string, head: string): Promise<string> {
  const folder = join(root, path);
  await mkdir(join(folder, '.git'), { recursive: true });
  await writeFile(join(folder, '.git', 'HEAD'), head, 'utf8');
  return folder;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'boxwarden-git-'));

  await repo('code/webapp', 'ref: refs/heads/main\n');
  await repo('code/api', 'ref: refs/heads/feature/rate-limiting\n');
  await repo('code/pinned', '4f2c1ab9d3e5f70123456789abcdef0123456789\n');

  // A workspace one level inside the repository — a monorepo package with its
  // own dev container config.
  await mkdir(join(root, 'code/webapp/packages/ui'), { recursive: true });

  // Not a repository at all.
  await mkdir(join(root, 'code/notes'), { recursive: true });

  // A worktree: `.git` is a FILE pointing at the real directory, which lives
  // under the main checkout's .git/worktrees.
  const worktreeGitDir = join(root, 'code/webapp/.git/worktrees/agent');
  await mkdir(worktreeGitDir, { recursive: true });
  await writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/agent/task-1\n', 'utf8');
  await mkdir(join(root, 'trees/agent'), { recursive: true });
  await writeFile(join(root, 'trees/agent/.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');

  // The same, with the relative pointer git writes when the worktree is beside
  // the checkout.
  await mkdir(join(root, 'code/webapp/.git/worktrees/relative'), { recursive: true });
  await writeFile(
    join(root, 'code/webapp/.git/worktrees/relative/HEAD'),
    'ref: refs/heads/agent/task-2\n',
    'utf8',
  );
  await mkdir(join(root, 'code/relative-tree'), { recursive: true });
  await writeFile(
    join(root, 'code/relative-tree/.git'),
    'gitdir: ../webapp/.git/worktrees/relative\n',
    'utf8',
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readGitStatus', () => {
  it('reads the branch of a checkout', async () => {
    await expect(readGitStatus(join(root, 'code/webapp'))).resolves.toEqual({
      kind: 'branch',
      branch: 'main',
    });
    await expect(readGitStatus(join(root, 'code/api'))).resolves.toEqual({
      kind: 'branch',
      branch: 'feature/rate-limiting',
    });
  });

  it('reads a detached HEAD', async () => {
    await expect(readGitStatus(join(root, 'code/pinned'))).resolves.toEqual({
      kind: 'detached',
      commit: '4f2c1ab9d3e5f70123456789abcdef0123456789',
    });
  });

  /**
   * `devcontainer.local_folder` is usually the repository root, but a monorepo
   * can open a package directory as the workspace instead.
   */
  it('walks up to the repository a workspace sits inside', async () => {
    await expect(readGitStatus(join(root, 'code/webapp/packages/ui'))).resolves.toEqual({
      kind: 'branch',
      branch: 'main',
    });
  });

  /** One worktree per agent is a common way to run several sessions over one repo. */
  it('follows a worktree pointer', async () => {
    await expect(readGitStatus(join(root, 'trees/agent'))).resolves.toEqual({
      kind: 'branch',
      branch: 'agent/task-1',
    });
  });

  it('resolves a relative worktree pointer against the folder holding it', async () => {
    await expect(readGitStatus(join(root, 'code/relative-tree'))).resolves.toEqual({
      kind: 'branch',
      branch: 'agent/task-2',
    });
  });

  /**
   * `none`, not `unknown`: the folder was read and is not a checkout. The two
   * arms are kept apart so a folder on an unreachable filesystem is never
   * reported as a plain directory.
   */
  it('answers none for a folder that is not in a work tree', async () => {
    await expect(readGitStatus(join(root, 'code/notes'))).resolves.toEqual({ kind: 'none' });
  });

  it('answers none rather than throwing for a folder that does not exist', async () => {
    await expect(readGitStatus(join(root, 'code/gone'))).resolves.toEqual({ kind: 'none' });
  });

  it('reports a .git it cannot make sense of instead of claiming a branch', async () => {
    const folder = await repo('code/corrupt', 'this is not a HEAD\n');
    await expect(readGitStatus(folder)).resolves.toMatchObject({ kind: 'unknown' });
  });
});
