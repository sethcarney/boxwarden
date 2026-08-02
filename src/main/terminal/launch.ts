import { spawn } from 'node:child_process';
import type { TerminalLaunch } from './command.js';

/**
 * Open a terminal window.
 *
 * The same two rules as `editor/launch.ts`, for a sharper reason:
 *
 *   - `spawn` with an argv ARRAY and never `shell: true`. What is being
 *     launched here is, by design, a command line containing user-authored
 *     shell code — the container's startup command. That code is meant to run
 *     inside the container, and `shell: true` would run a copy of it on the
 *     host first. Through argv it is inert data the whole way down.
 *
 *   - `detached` plus `unref`, so quitting boxwarden does not close the
 *     developer's shell out from under them.
 *
 * `detached` has a second effect on Windows that is relied on here: a console
 * child of a GUI process gets its OWN console window rather than none at all,
 * which is what makes the conhost fallback show up on screen.
 */
export function launchTerminal(launch: TerminalLaunch): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });

    // 'error' fires for ENOENT/EACCES — the emulator vanished between
    // resolution and launch, or is not actually executable.
    child.once('error', reject);

    // 'spawn' means the process was created. Waiting for exit would hang the
    // IPC call for as long as the user keeps the terminal open.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
