import { execFile } from 'node:child_process';
import type { BranchListing, BranchTracking, HostPath, WorkingTree } from '../../models/index.js';
import {
  BRANCH_REF_FORMAT,
  canSwitchTo,
  gitInvocation,
  parseBranchRefs,
  parseDubiousOwnership,
  parseTracking,
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

/**
 * The one status command, shared by the menu and the chip.
 *
 * `--branch` costs nothing and adds the `## main...origin/main [ahead 1]`
 * header, so ONE run answers both "can this branch be switched away from" and
 * "how far has it diverged". Asking twice would double the cost of the poll
 * below, which is the thing that had to be slowed down in the first place.
 *
 * `--untracked-files=no` is the load-bearing flag: git carries untracked files
 * across a checkout without complaint, so counting them would block switching
 * on a repo whose only "change" is a `node_modules` its `.gitignore` missed.
 * What is counted is what git will actually refuse over.
 */
const STATUS_ARGS = ['status', '--porcelain', '--branch', '--untracked-files=no'] as const;

/**
 * How long a working-tree reading stays fresh.
 *
 * The chip's poll runs every thirty seconds and reads two FILES, which is cheap
 * enough to do that often. This spawns git, which is not — so the reading is
 * cached and the poll mostly gets the previous answer. Two minutes is chosen
 * against what the number is for: it decorates a card with a rough sense of
 * "this checkout has work in it", and nobody makes a decision on whether that
 * count is ninety seconds stale.
 */
const WORKING_TREE_TTL_MS = 120_000;

interface WorkingTreeReading {
  readonly tree: WorkingTree;
  readonly tracking?: BranchTracking;
}

/** The last reading per folder, with when it was taken. */
const workingTreeCache = new Map<
  string,
  { readonly at: number; readonly reading: WorkingTreeReading }
>();

/**
 * The dirty count and the divergence for one workspace, cached.
 *
 * `undefined` for every failure, and deliberately silent about which: this
 * decorates a chip whose whole point is to work on a machine with no git, so a
 * missing answer has to look like an ordinary absence rather than a fault. The
 * branch menu is where a git failure gets explained, because that is where the
 * user asked for something git had to do.
 *
 * `now` is a parameter for the reason every clock in this codebase is one.
 */
export async function readWorkingTree(
  folder: HostPath,
  key: string,
  now: number = Date.now(),
): Promise<WorkingTreeReading | undefined> {
  const cached = workingTreeCache.get(key);
  if (cached !== undefined && now - cached.at < WORKING_TREE_TTL_MS) return cached.reading;

  const status = await run([...STATUS_ARGS], folder, READ_TIMEOUT_MS);
  if (!status.ok) {
    // The stale reading is kept rather than cleared: a transient failure should
    // not blank a count that was true a minute ago, and the alternative is a
    // chip that flickers on every hiccup.
    return cached?.reading;
  }

  const tracking = parseTracking(status.stdout);
  const reading: WorkingTreeReading = {
    tree: parseWorkingTree(status.stdout),
    ...(tracking === undefined ? {} : { tracking }),
  };
  workingTreeCache.set(key, { at: now, reading });
  return reading;
}

interface GitRun {
  readonly ok: boolean;
  readonly stdout: string;
  /** Already trimmed and collapsed to something showable in a notice bar. */
  readonly message: string;
  /** A command the user can run to fix this, when git named one. */
  readonly command?: string;
}

/**
 * Run one git command against a workspace. Never rejects — every failure is
 * data, for the same reason the IPC verbs return `{ ok: false, message }`.
 *
 * WHICH git is `gitInvocation`'s decision, not this function's: a workspace
 * inside a WSL distro runs the distro's own, over the distro's own path. See
 * the note there — it is the difference between working and a `safe.directory`
 * refusal on every Windows machine whose code lives in WSL.
 */
function run(args: readonly string[], folder: HostPath, timeoutMs: number): Promise<GitRun> {
  const { file, leading } = gitInvocation(folder);

  return new Promise((resolve) => {
    execFile(
      file,
      [...leading, ...args],
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
          // Keep git's own messages parseable and in one language. Note this
          // does NOT cross into a distro — `wsl.exe` forwards only what WSLENV
          // names — so the WSL arm can still answer in the user's locale. Every
          // message here is passed through to the user rather than matched on,
          // with one exception (`parseDubiousOwnership`), and that one is a
          // failure the WSL arm exists to avoid in the first place.
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
              folder.kind === 'wsl'
                ? `wsl.exe was not found, so the branches in ${folder.distro} cannot be listed or switched. Reading the current branch does not need it, which is why the chip still works.`
                : 'git was not found on this machine, so branches cannot be listed or switched. Reading the current branch does not need it, which is why the chip still works.',
          });
          return;
        }

        // git says why far better than an exit code does — "not a git
        // repository", "pathspec did not match", "your local changes would be
        // overwritten" are all things a user can act on.
        const said = stderr.trim() === '' ? error.message.trim() : stderr.trim();

        // …with one exception, because git's own wording here describes a
        // decision the USER has to make and buries it under three lines of
        // instruction. Said plainly, with git's exact command offered to copy.
        const fix = parseDubiousOwnership(stderr);
        if (fix !== undefined) {
          resolve({
            ok: false,
            stdout: '',
            message:
              'git does not trust this repository: the files belong to a different user account from the one boxwarden is running as, so it refuses to read or change it. That check exists to stop a repository on a shared path from running its own config, so boxwarden will not turn it off for you.',
            command: fix,
          });
          return;
        }

        resolve({ ok: false, stdout: '', message: said });
      },
    );
  });
}

/** One failed run, as the arm the menu renders. Keeps `command` only when there is one. */
function unavailable(run: GitRun): BranchListing {
  return {
    kind: 'unavailable',
    reason: run.message,
    ...(run.command === undefined ? {} : { command: run.command }),
  };
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
export async function readBranches(folder: HostPath): Promise<BranchListing> {
  const [refs, status] = await Promise.all([
    run(['for-each-ref', `--format=${BRANCH_REF_FORMAT}`, 'refs/heads'], folder, READ_TIMEOUT_MS),
    run(STATUS_ARGS, folder, READ_TIMEOUT_MS),
  ]);

  if (!refs.ok) return unavailable(refs);
  if (!status.ok) return unavailable(status);

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
export async function switchBranch(folder: HostPath, branch: string): Promise<ActionResult> {
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
