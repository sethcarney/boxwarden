import { platform } from 'node:os';
import type {
  DesktopWindow,
  DevContainer,
  EditorAttachment,
  EditorWindowClosure,
} from '../../models/index.js';
import {
  editorWindowCriteria,
  flavoursOf,
  matchEditorWindows,
  windowFlavour,
} from '../../models/index.js';
import { resolveBinary } from '../discovery/resolve.js';
import type { DesktopBackendResult, DesktopWindowBackend } from './backend.js';
import { isWaylandSession, linuxBackend } from './linux.js';
import { isAccessibilityRefusal, macosBackend } from './macos.js';
import { windowsBackend } from './windows.js';

/**
 * Close the editor windows attached to a container, so Stop does not strand
 * them.
 *
 * The whole sequence, and every step of it can decline:
 *
 *   1. Nothing attached → do nothing, and spawn nothing. This is the ordinary
 *      case and it must stay free, because "Stop all" on a compose project runs
 *      it once per service and only one of them ever has a window.
 *   2. Pick a backend for this desktop, or answer `unsupported` with the reason.
 *   3. Enumerate every window, and match this container's in a pure function.
 *   4. Ask the matches to close.
 *   5. Re-enumerate until they are gone, or until `SETTLE_TIMEOUT_MS`.
 *
 * Step 5 is the one that earns the feature its name. Asking a window to close
 * is a request, and VS Code refuses it when a buffer is unsaved — so a window
 * that is still there after the timeout is almost always one sitting behind a
 * "do you want to save?" dialog. The caller turns that into a REFUSED stop
 * rather than a completed one, because a container pulled out from under an
 * unanswered save prompt is the original bug wearing a hat.
 */

/** How long a window gets to go away after being asked. */
const SETTLE_TIMEOUT_MS = 6_000;
const SETTLE_INTERVAL_MS = 250;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which backend, if any, this desktop offers.
 *
 * The Linux arm is the only one that has to look for anything: `powershell.exe`
 * and `osascript` ship with their operating systems, and `wmctrl` is a package
 * a great many machines do not have. It is resolved through the same
 * `resolveBinary` the editors and terminal emulators use, so a machine that has
 * it somewhere unusual is not told it is missing.
 */
export async function desktopBackend(
  os: NodeJS.Platform = platform(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DesktopBackendResult> {
  switch (os) {
    case 'win32':
      return { ok: true, backend: windowsBackend };

    case 'darwin':
      return { ok: true, backend: macosBackend };

    case 'linux': {
      const wmctrl = await resolveBinary([{ kind: 'path-lookup', command: 'wmctrl' }], os, env);
      if (!wmctrl.ok) {
        return {
          ok: false,
          unsupported: {
            reason: isWaylandSession(env)
              ? 'This is a Wayland session, which does not let one application close another’s window. Close the editor window yourself before stopping.'
              : 'boxwarden needs wmctrl to close an editor window on Linux. Install it (apt install wmctrl) and try again.',
          },
        };
      }
      if (isWaylandSession(env)) {
        return {
          ok: false,
          unsupported: {
            reason:
              'This is a Wayland session, which does not let one application close another’s window — wmctrl only sees XWayland windows. Close the editor window yourself before stopping.',
          },
        };
      }
      return { ok: true, backend: linuxBackend };
    }

    default:
      return {
        ok: false,
        unsupported: { reason: `boxwarden cannot close windows on ${os}.` },
      };
  }
}

/** Turn a helper's failure into the arm that describes it best. */
function classifyFailure(error: unknown, os: NodeJS.Platform): EditorWindowClosure {
  const message = messageOf(error);

  if (os === 'darwin' && isAccessibilityRefusal(message)) {
    return {
      kind: 'unsupported',
      reason:
        'macOS has not given boxwarden permission to control other apps, so it could not close the editor window. Grant it under System Settings › Privacy & Security › Accessibility.',
    };
  }

  return { kind: 'failed', reason: message };
}

/** Which of these windows are still on the desktop. */
async function stillOpen(
  backend: DesktopWindowBackend,
  closed: readonly DesktopWindow[],
): Promise<readonly DesktopWindow[]> {
  const handles = new Set(closed.map((window) => window.handle));
  const windows = await backend.list();
  return windows.filter((window) => handles.has(window.handle));
}

export async function closeAttachedEditorWindows(
  container: DevContainer,
  attachment: EditorAttachment,
  os: NodeJS.Platform = platform(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EditorWindowClosure> {
  // `none` and `not-applicable` are answers; `unknown` is the absence of one,
  // and gets the same treatment as `attached` with no flavours named. Costing a
  // window enumeration on a container we could not read is the right way round
  // — the alternative is stranding a window because one `top` failed.
  if (attachment.kind === 'none' || attachment.kind === 'not-applicable') {
    return { kind: 'none' };
  }
  const editors = attachment.kind === 'attached' ? attachment.editors : [];

  // The fixtures are the one input here that is FABRICATED, and this is the one
  // action in the app that reaches outside it. `FakeDockerBackend` serves
  // containers on folders like `/Users/dev/projects/web-app` with editors
  // reported as attached — and a developer running `bun run dev:fake` may well
  // have a REAL dev container open on a folder whose basename matches one of
  // them, at which point stopping a fixture closes a window with their work in
  // it. Every other fake in this app is inert because nothing acts on it; this
  // one would not be, so it is refused rather than made careful.
  if (env['BOXWARDEN_FAKE_DOCKER'] === '1') {
    return {
      kind: 'unsupported',
      reason:
        'BOXWARDEN_FAKE_DOCKER=1 — the container list is fixtures, so no editor window was closed.',
    };
  }

  const resolved = await desktopBackend(os, env);
  if (!resolved.ok) return { kind: 'unsupported', reason: resolved.unsupported.reason };
  const { backend } = resolved;

  const criteria = editorWindowCriteria(container, editors);

  let matches: readonly DesktopWindow[];
  let seen: readonly DesktopWindow[];
  try {
    seen = await backend.list();
    matches = matchEditorWindows(seen, criteria);
  } catch (error) {
    return classifyFailure(error, os);
  }

  if (matches.length === 0) {
    // The evidence, gathered here rather than left behind, because this is the
    // only place that still has it. Narrowed to windows belonging to an editor:
    // a developer's whole desktop is both too long for a copy button and none
    // of this app's business, and the rows that matter are the ones that got
    // past the first gate and failed a later one.
    return {
      kind: 'not-found',
      editors,
      saw: seen
        .filter((window) => windowFlavour(window.process) !== undefined)
        .map((window) => `${window.process}\t${window.title}`),
      enumerated: seen.length,
      names: criteria.names,
    };
  }

  try {
    await backend.close(matches);
  } catch (error) {
    return classifyFailure(error, os);
  }

  // Poll rather than sleep once: a window that closes in 200ms should not cost
  // the Stop button six seconds, and one that is going to argue about an
  // unsaved buffer will still be there at the end of them.
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let remaining = matches;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
    try {
      remaining = await stillOpen(backend, matches);
    } catch (error) {
      // The close was already issued, so a failure to CONFIRM it is not a
      // failure to do it. Reported as such rather than as a still-open window,
      // which would refuse a stop over a lost enumeration.
      return classifyFailure(error, os);
    }
  }

  return remaining.length > 0
    ? { kind: 'still-open', windows: remaining.length }
    : { kind: 'closed', windows: matches.length, editors: flavoursOf(matches) };
}
