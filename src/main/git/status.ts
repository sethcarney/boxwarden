import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { GitStatus } from '../../models/index.js';
import { parseGitDirPointer, parseGitHead } from '../../models/index.js';

/**
 * The impure half of "which branch is this container on": find the `.git` for a
 * host folder and read its HEAD. Every decision about what the bytes MEAN lives
 * in src/models/git.ts; this file only locates files and hands over their
 * contents, in the same shape as `inspect` -> `mapContainer`.
 */

/**
 * How far up to look for a `.git`.
 *
 * `devcontainer.local_folder` is usually the repository root, but not always —
 * a monorepo can put the dev container config in a package directory and open
 * that as the workspace. Walking up finds the checkout those belong to; a bound
 * keeps a folder outside any repository from walking to `/` on every poll, and
 * stops a container whose workspace is a deep subdirectory from claiming a
 * branch from some distant ancestor repository the user never had in mind.
 */
const MAX_PARENTS = 4;

/**
 * Cap on how long one folder may take.
 *
 * A host path can be a network share, a spun-down external disk, or a
 * `\\wsl.localhost\…` UNC into a distro that has stopped answering — all of
 * which make `stat` block rather than fail. This is a decoration on a card,
 * read on a background poll, so an unresponsive filesystem has to degrade to
 * "could not tell" quickly instead of holding the batch open.
 */
const READ_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Reading the folder timed out after ${String(ms)}ms.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Where a folder's git metadata lives, following the worktree indirection. */
async function findGitDir(folder: string): Promise<string | undefined> {
  let current = folder;

  for (let level = 0; level <= MAX_PARENTS; level += 1) {
    const candidate = join(current, '.git');

    try {
      const entry = await stat(candidate);
      if (entry.isDirectory()) return candidate;

      if (entry.isFile()) {
        // A worktree or submodule: the file names the real directory, possibly
        // relative to the folder holding it.
        const pointer = parseGitDirPointer(await readFile(candidate, 'utf8'));
        if (pointer !== undefined) {
          return isAbsolute(pointer) ? pointer : resolve(current, pointer);
        }
      }
    } catch {
      // No `.git` here (or it cannot be read) — that is the ordinary case for
      // every level but the last, so keep walking rather than reporting it.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Read one folder's checkout.
 *
 * Never rejects. Every failure is a `GitStatus` arm, because the caller is
 * filling in a batch for a list of cards and one unreadable folder must not
 * blank the rest — and because "we could not look" is a thing the UI has to be
 * able to say, distinctly from "that folder is not a repository".
 */
export async function readGitStatus(folder: string): Promise<GitStatus> {
  try {
    return await withTimeout(readCheckout(folder), READ_TIMEOUT_MS);
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function readCheckout(folder: string): Promise<GitStatus> {
  const gitDir = await findGitDir(folder);
  if (gitDir === undefined) return { kind: 'none' };

  try {
    return parseGitHead(await readFile(join(gitDir, 'HEAD'), 'utf8'));
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `Could not read HEAD in ${gitDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
