import { execFile } from 'node:child_process';
import type { BranchListing } from '../../models/index.js';
import {
  BRANCH_REF_FORMAT,
  canSwitchTo,
  parseBranchRefs,
  parseWorkingTree,
} from '../../models/index.js';
import type { ActionResult } from '../../shared/ipc.js';

/**
 * The impure half of switching a branch: run `git`, hand the bytes to the pure
 * parsers in src/models/git.ts, and spawn nothing else.
 *
 * ## Why this file uses git at all, when status.ts does not
 *
 * Reading a branch is two file reads and needs no git installed
 * (`src/main/git/status.ts`). Changing one rewrites the index and the working
 * tree, and the only correct implementation of that is git's own — so this half
 * shells out, and everything that follows is about doing so safely.
 *
 * ## The three rules
 *
 * 1. **`execFile`, never a shell.** Same rule as `editor/launch.ts` and
 *    `terminal/launch.ts`: an argv array, no `shell: true`, no string
 *    concatenation. A branch name can contain almost anything a filename can.
 *
 * 2. **Only names git itself printed are ever passed back to git.** The
 *    renderer names a container id; the main process resolves the folder, asks
 *    git for the branches under `refs/heads`, and `canSwitchTo` refuses
 *    anything that is not in that answer. So `git checkout` can never receive
 *    an option, a path, or a ref from another namespace — not because the
 *    string was escaped, but because it was never a free string.
 *
 * 3. **The tree is re-read immediately before the checkout.** The menu's copy
 *    of "clean" is however many seconds old the menu is, and a person can save
 *    a file in that time. The check that decides is this one.
 *
 * ## `-C`, not `cwd`
 *
 * Pointing git at the folder with `-C` rather than spawning it there keeps two
 * failures apart: a missing FOLDER is git's own exit 128 with a message, while
 * a missing GIT is a spawn `ENOENT`. With `cwd` both arrive as ENOENT and the
 * user gets told to install git they already have.
 */

/**
 * How long a read may take.
 *
 * These are local and index-only, but the folder can be a network share or a
 * UNC into a WSL distro — the same reason `status.ts` bounds its reads.
 */
const READ_TIMEOUT_MS = 10_000;

/**
 * How long a checkout may take.
 *
 * Deliberately generous, and deliberately not absent. A checkout is local, but
 * an LFS smudge filter turns it into a download, and a repository with a large
 * worktree on a slow disk is not misbehaving at thirty seconds. What this
 * guards is a git that will never finish — a credential helper waiting on a
 * dialog nobody can see. `GIT_TERMINAL_PROMPT=0` below is what makes that rare;
 * this is what makes it survivable.
 */
const CHECKOUT_TIMEOUT_MS = 120_000;

/**
 * A repository with tens of thousands of branches is unusual and not wrong, and
 * the default 1MB would truncate its listing MID-LINE — which parses as a real
 * branch under a mangled name. Big enough that the failure below is the one
 * that happens instead.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface GitRun {
  readonly ok: boolean;
  readonly stdout: string;
  /** Already trimmed and collapsed to something showable in a notice bar. */
  readonly message: string;
}

/**
 * Run one git command against a folder. Never rejects — every failure is data,
 * for the same reason the IPC verbs return `{ ok: false, message }`.
 */
function run(args: readonly string[], folder: string, timeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // `--no-optional-locks` keeps a read from taking the index lock, which
      // matters here more than most places: the editor attached to this very
      // container is running git against the same checkout on its own schedule.
      ['--no-optional-locks', '-C', folder, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          // No credential dialogs and no terminal prompts. There is no terminal
          // to answer them on, so a git that asks is a git that hangs until the
          // timeout above.
          GIT_TERMINAL_PROMPT: '0',
          // Keep git's own messages parseable and in one language.
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, message: '' });
          return;
        }

        const code = 'code' in error ? error.code : undefined;
        if (code === 'ENOENT') {
          resolve({
            ok: false,
            stdout: '',
            message:
              'git was not found on this machine, so branches cannot be listed or switched. Reading the current branch does not need it, which is why the chip still works.',
          });
          return;
        }

        // git says why far better than an exit code does — "not a git
        // repository", "pathspec did not match", "your local changes would be
        // overwritten" are all things a user can act on.
        const said = stderr.trim() === '' ? error.message.trim() : stderr.trim();
        resolve({ ok: false, stdout: '', message: said });
      },
    );
  });
}

/**
 * The local branches of the repository containing `folder`, and whether its
 * working tree is clean.
 *
 * Never rejects; an unreadable repository is an `unavailable` arm carrying
 * git's own words. Both commands run together because they are independent and
 * this is on the user's click, not a poll.
 *
 * Note this walks up UNBOUNDED where `readGitStatus` stops at four levels: git
 * discovers the repository from the folder upward with no limit of its own.
 * They can therefore disagree on a workspace nested more than four deep inside
 * a checkout — the chip would say nothing while this lists branches. The menu
 * naming its current branch is what keeps that legible rather than confusing.
 */
export async function readBranches(folder: string): Promise<BranchListing> {
  const [refs, status] = await Promise.all([
    run(['for-each-ref', `--format=${BRANCH_REF_FORMAT}`, 'refs/heads'], folder, READ_TIMEOUT_MS),
    run(['status', '--porcelain', '--untracked-files=no'], folder, READ_TIMEOUT_MS),
  ]);

  if (!refs.ok) return { kind: 'unavailable', reason: refs.message };
  if (!status.ok) return { kind: 'unavailable', reason: status.message };

  return {
    kind: 'ready',
    branches: parseBranchRefs(refs.stdout),
    tree: parseWorkingTree(status.stdout),
  };
}

/**
 * Check `branch` out in `folder`, or say why not.
 *
 * The refusal path is the point of the function, so it comes first and it is
 * authoritative: the listing is re-read HERE, and `canSwitchTo` is applied to
 * that fresh copy. A renderer that offers a branch it should not, or a user who
 * saved a file while the menu was open, both land on the same answer as if the
 * button had been disabled — because the button being disabled was never the
 * check.
 *
 * No `--force`, no `--merge`, and no stash. Every one of those either discards
 * work or leaves some behind for the user to remember; refusing costs them one
 * command in a terminal they already have open.
 */
export async function switchBranch(folder: string, branch: string): Promise<ActionResult> {
  const allowed = canSwitchTo(branch, await readBranches(folder));
  if (allowed !== true) return { ok: false, message: allowed };

  // `branch` reached here only by being present in the listing above, i.e. it
  // is a string git printed under refs/heads. That is what makes a bare
  // `checkout <branch>` safe — see rule 2 at the top of this file.
  const result = await run(['checkout', branch], folder, CHECKOUT_TIMEOUT_MS);

  // Success is the exit code, never the output: `git checkout` writes
  // "Switched to branch 'x'" to STDERR, so a stderr-is-failure test would
  // report every successful switch as a failure.
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}
