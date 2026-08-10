import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopWindow } from '../../models/index.js';
import { EDITOR_PROCESS_NAMES, parseWindowTable } from '../../models/index.js';
import { appleScriptString } from '../terminal/command.js';
import { HELPER_TIMEOUT_MS, type DesktopWindowBackend } from './backend.js';

const execFileAsync = promisify(execFile);

/**
 * macOS: System Events, through `osascript`.
 *
 * The only route on this platform. AppleScript is how one application asks
 * another about its windows, and VS Code ships no scripting dictionary of its
 * own — so the conversation goes through System Events' accessibility tree
 * instead, which is a view of the same UI a person clicks.
 *
 * ## The Accessibility grant
 *
 * Reading that tree requires the user to have ticked boxwarden under System
 * Settings → Privacy & Security → Accessibility. Until they have, EVERY call
 * here fails with error -1719 or -25211, and it fails on the enumerate as well
 * as on the close — which is the good arrangement, because it means the whole
 * feature reports "not permitted" in one place instead of appearing to work and
 * then quietly doing nothing.
 *
 * That grant is not requested, prompted for, or worked around. It is the
 * operating system asking whether this app may drive other applications, which
 * is exactly what this feature does, and a user who declines has said something
 * meaningful. `describeOsascriptFailure` turns the refusal into the sentence
 * that tells them where the checkbox is.
 *
 * ## The close is a click
 *
 * `click (first button of w whose subrole is "AXCloseButton")` — the red dot,
 * addressed by ROLE and not by position. `button 1` would be the same button on
 * every Mac today and the wrong one the first time a title bar is rearranged.
 * Clicking it posts the same close the keyboard's ⌘W does, so VS Code's own
 * shutdown runs and an unsaved buffer still gets its dialog.
 */

/**
 * Windows are identified by their TITLE here, not by a handle.
 *
 * macOS exposes no stable per-window identifier through AppleScript — `window
 * 3` is a position in a Z-order that changes when the user clicks something —
 * so the title is what the close has to address, and it is passed back through
 * `appleScriptString` rather than rebuilt. Two windows sharing a title are
 * closed together, which is correct: they can only be two windows on the same
 * container.
 */
function processFilter(): string {
  return EDITOR_PROCESS_NAMES.map(appleScriptString).join(', ');
}

const LIST_SCRIPT = `
set out to ""
tell application "System Events"
  repeat with proc in (every application process whose name is in {${processFilter()}})
    set procName to name of proc
    repeat with win in (every window of proc)
      set out to out & procName & tab & procName & tab & (name of win) & linefeed
    end repeat
  end repeat
end tell
return out
`;

function closeScript(processName: string, title: string): string {
  return `
tell application "System Events"
  repeat with proc in (every application process whose name is ${appleScriptString(processName)})
    repeat with win in (every window of proc whose name is ${appleScriptString(title)})
      try
        click (first button of win whose subrole is "AXCloseButton")
      end try
    end repeat
  end repeat
end tell
`;
}

/** `osascript -` reads the script from stdin, which keeps it off the command line. */
async function runOsascript(script: string): Promise<string> {
  const child = execFileAsync('osascript', ['-'], {
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  child.child.stdin?.end(script);
  const { stdout } = await child;
  return stdout;
}

/**
 * Whether a failure is the Accessibility grant rather than a broken script.
 *
 * Matched on the error NUMBERS as well as the wording, because the wording is
 * localised — a user running macOS in French gets the same -1719 and a sentence
 * this file cannot match on.
 */
export function isAccessibilityRefusal(message: string): boolean {
  return (
    message.includes('-1719') ||
    message.includes('-25211') ||
    message.includes('not allowed assistive access') ||
    message.includes('not allowed to send keystrokes')
  );
}

export const macosBackend: DesktopWindowBackend = {
  async list(): Promise<readonly DesktopWindow[]> {
    // The handle column repeats the process name: on this platform the pair
    // that addresses a window is (process, title), and `DesktopWindow` already
    // carries the title. Repeating the process rather than inventing a
    // composite keeps the handle meaningful to the one backend that reads it.
    return parseWindowTable(await runOsascript(LIST_SCRIPT));
  },

  async close(windows: readonly DesktopWindow[]): Promise<void> {
    // Sequentially, not in parallel: each of these drives the same System
    // Events process, and three osascript invocations racing for it is how a
    // click lands on a window that has moved.
    for (const window of windows) {
      await runOsascript(closeScript(window.process, window.title));
    }
  },
};
