import { execFile } from 'node:child_process';
import type { ActionResult } from '../../shared/ipc.js';
import type { QuitStep } from './quit-command.js';
import {
  FORCE_WAIT_MS,
  GRACEFUL_WAIT_MS,
  PROBE_INTERVAL_MS,
  editorQuitPlan,
  probeSaysRunning,
} from './quit-command.js';

/**
 * The impure shell around `quit-command.ts`: spawn the steps, wait between
 * them, fold the outcome into an `ActionResult`. All the decisions — which
 * commands, which patterns, what an exit code means — are in the pure module,
 * which is the one with tests.
 */

interface StepResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Run one step. Never rejects on a non-zero exit — for `pgrep` and `pkill`
 * that is an answer, not a failure — and never goes through a shell: every
 * argument is a fixed string from the plan.
 */
function run(step: QuitStep): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    execFile(step.command, step.args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error !== null && typeof error.code !== 'number') {
        // ENOENT and friends — the tool itself is missing or unrunnable,
        // which is a real failure rather than a "nothing matched" exit.
        reject(new Error(error.message));
        return;
      }
      resolve({ exitCode: error === null ? 0 : (error.code as number), stdout });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRunning(platform: string, probe: QuitStep): Promise<boolean> {
  const result = await run(probe);
  return probeSaysRunning(platform, result.exitCode, result.stdout);
}

/**
 * Quit VS Code on this machine — every window. Graceful first (the same quit
 * the user's own ⌘Q / Alt-F4 delivers, so hot exit keeps unsaved work), then
 * SIGKILL for whatever ignored it. See `quit-command.ts` for why this is the
 * only per-editor lifecycle operation that reliably exists.
 */
export async function quitVsCode(platform: string = process.platform): Promise<ActionResult> {
  const plan = editorQuitPlan(platform);
  if (plan === undefined) {
    return { ok: false, message: `Quitting VS Code is not supported on ${platform}.` };
  }

  try {
    if (!(await isRunning(platform, plan.probe))) {
      // Honest rather than a silent success: the attached-editor badge reads
      // the SERVER inside the container, and when boxwarden itself runs
      // somewhere that cannot see the host's processes (its own dev
      // container, a remote daemon) the window is real and out of reach.
      return {
        ok: false,
        message:
          'No VS Code processes were found on this machine. If the window is on another machine — or boxwarden is running inside a container — it cannot be quit from here.',
      };
    }

    await run(plan.graceful);
    const deadline = Date.now() + GRACEFUL_WAIT_MS;
    while (Date.now() < deadline) {
      await wait(PROBE_INTERVAL_MS);
      if (!(await isRunning(platform, plan.probe))) return { ok: true };
    }

    await run(plan.force);
    await wait(FORCE_WAIT_MS);
    if (!(await isRunning(platform, plan.probe))) return { ok: true };

    return {
      ok: false,
      message:
        'VS Code was asked to quit and then force-killed, and something is still running. Check the process list directly.',
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
