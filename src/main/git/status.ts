import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { GitStatus } from '../../models/index.js';
import { parseGitDirPointer, parseGitHead } from '../../models/index.js';

/**
 * The impure half of "which branch is this container on": find the `.git` for a
 * host folder and read its HEAD. Every decision about what the bytes MEAN lives
 * in src/models/git.ts; this file only locates files and hands over their
 * contents, in the same shape as `inspect` -> `mapContainer`.
 *
 * It never asks a question about a path before opening it — no `stat` followed
 * by a read. Attempting the read is the check, and the error code is the
 * answer, so there is no window between the two in which the filesystem can
 * change underneath.
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

/**
 * One read, and its failure as data.
 *
 * The whole lookup is written in terms of this rather than `stat`-then-read,
 * and deliberately so: asking whether a path is a directory and then opening it
 * are two decisions about a filesystem that can change between them, which is
 * the classic check-then-use race — and on a path the user's other tools are
 * actively writing to (git switches branches by rewriting HEAD) the window is
 * not theoretical. Attempting the read IS the check.
 *
 * The `code` is kept because one of them carries information the contents
 * cannot: `EISDIR` on `.git` means it is a directory, which is how a broken
 * checkout is told apart from a folder that simply has no repository.
 */
type ReadResult =
  | { readonly ok: true; readonly contents: string }
  | { readonly ok: false; readonly code: string | undefined };

async function read(path: string): Promise<ReadResult> {
  try {
    return { ok: true, contents: await readFile(path, 'utf8') };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    return { ok: false, code };
  }
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

/**
 * Walk up looking for a checkout, and read its HEAD.
 *
 * Each level is at most two reads and no `stat`: `.git/HEAD` answers the
 * ordinary case, and `.git` itself answers the worktree case. A level where
 * both are absent is the ordinary state of every level but the last, so it
 * walks on rather than reporting anything.
 */
async function readCheckout(folder: string): Promise<GitStatus> {
  let current = folder;

  for (let level = 0; level <= MAX_PARENTS; level += 1) {
    const gitDir = join(current, '.git');

    // `.git` as a DIRECTORY, which is every checkout that is not a worktree.
    const head = await read(join(gitDir, 'HEAD'));
    if (head.ok) return parseGitHead(head.contents);

    // `.git` as a FILE: the pointer git writes for a worktree or a submodule,
    // possibly relative to the folder holding it.
    const pointerFile = await read(gitDir);
    if (pointerFile.ok) {
      const pointer = parseGitDirPointer(pointerFile.contents);
      if (pointer === undefined) {
        return { kind: 'unknown', reason: `The .git file in ${current} is not a gitdir pointer.` };
      }
      const linked = isAbsolute(pointer) ? pointer : resolve(current, pointer);
      const linkedHead = await read(join(linked, 'HEAD'));
      return linkedHead.ok
        ? parseGitHead(linkedHead.contents)
        : { kind: 'unknown', reason: `Could not read HEAD in ${linked}.` };
    }

    // `.git` is there and is a directory, but its HEAD was not readable — a
    // broken checkout, not "no repository here". Walking on from this would
    // report the PARENT repository's branch for a folder that has its own,
    // which is the one wrong answer available here.
    if (pointerFile.code === 'EISDIR') {
      return { kind: 'unknown', reason: `Could not read HEAD in ${gitDir}.` };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { kind: 'none' };
}
