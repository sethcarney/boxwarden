import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { DesktopWindow } from '../../models/index.js';
import { parseWmctrlLine } from '../../models/index.js';
import { HELPER_TIMEOUT_MS, type DesktopWindowBackend } from './backend.js';

const execFileAsync = promisify(execFile);

/**
 * Linux/X11: `wmctrl`, plus `/proc` for the one thing wmctrl cannot say.
 *
 * `wmctrl -l -p` lists every managed window with its owning pid, and
 * `wmctrl -i -c <id>` sends `_NET_CLOSE_WINDOW` — the EWMH request a panel's
 * "Close" menu item sends, and the same one the window's own X button raises.
 * The application handles it, so VS Code's shutdown runs and an unsaved buffer
 * still stops it. `xkill` and a signal are the alternatives and both are kills.
 *
 * The process NAME is missing from that output entirely — X11 has no idea what
 * program owns a window beyond `WM_CLASS`, which for Electron is set per-app
 * and unreliable across the forks. `/proc/<pid>/comm` is the answer, is on
 * every Linux, and needs no permission to read for a process the user owns.
 *
 * ## Wayland
 *
 * There is no equivalent, and that is by design rather than by omission: the
 * Wayland protocol deliberately gives a client no way to enumerate or act on
 * another client's surfaces, which is the security property X11 lacks. wmctrl
 * under XWayland sees XWayland clients only, so a natively-Wayland VS Code is
 * invisible to it — and answering "no window found" there would be a true
 * statement that reads as a bug. `waylandReason` is why the caller can say the
 * real thing instead.
 */

/** Whether this session is Wayland, from the two variables that say so. */
export function isWaylandSession(env: Readonly<Record<string, string | undefined>>): boolean {
  if ((env['XDG_SESSION_TYPE'] ?? '').toLowerCase() === 'wayland') return true;
  // A Wayland display with no X display at all is conclusive; both set means
  // XWayland is up, and wmctrl is then worth trying.
  return (env['WAYLAND_DISPLAY'] ?? '') !== '' && (env['DISPLAY'] ?? '') === '';
}

/**
 * The process name behind a window's pid.
 *
 * `comm` and not `cmdline`: it is one short line, it is what `ps` prints under
 * COMM, and it is already the truncated-to-15-characters form the matcher's
 * table was written against. An unreadable one answers empty rather than
 * throwing — a window whose owner exited between the listing and this read is
 * an ordinary race, not a failure of the enumeration.
 */
async function processName(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${String(pid)}/comm`, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function wmctrlList(): Promise<string> {
  const { stdout } = await execFileAsync('wmctrl', ['-l', '-p'], {
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export const linuxBackend: DesktopWindowBackend = {
  raw: wmctrlList,

  async list(): Promise<readonly DesktopWindow[]> {
    const stdout = await wmctrlList();

    const parsed = stdout
      .split(/\r?\n/)
      .map((line) => parseWmctrlLine(line))
      .filter((entry) => entry !== undefined);

    return Promise.all(
      parsed.map(async (entry) => ({
        handle: entry.handle,
        process: await processName(entry.pid),
        title: entry.title,
      })),
    );
  },

  async close(windows: readonly DesktopWindow[]): Promise<void> {
    for (const window of windows) {
      await execFileAsync('wmctrl', ['-i', '-c', window.handle], { timeout: HELPER_TIMEOUT_MS });
    }
  },
};
