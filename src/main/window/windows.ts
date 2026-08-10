import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopWindow } from '../../models/index.js';
import { parseWindowTable } from '../../models/index.js';
import { HELPER_TIMEOUT_MS, type DesktopWindowBackend } from './backend.js';

const execFileAsync = promisify(execFile);

/**
 * Windows: enumerate with `EnumWindows`, close with `WM_CLOSE`.
 *
 * ## Why `EnumWindows` and not `Get-Process`
 *
 * `Get-Process` exposes one `MainWindowHandle` per process, and every VS Code
 * window on this machine belongs to the same process — Electron creates all of
 * its native windows on the browser process. So the tidy PowerShell one-liner
 * finds exactly one of a developer's six windows, and which one is a detail of
 * Z-order. `EnumWindows` is the only API that answers the question actually
 * being asked.
 *
 * ## Why `PostMessage(WM_CLOSE)` and not `CloseMainWindow` or a kill
 *
 * `WM_CLOSE` is precisely what clicking the X posts. The application receives
 * it, runs its own shutdown, and is free to refuse — which is the behaviour
 * this feature needs, because a VS Code window with an unsaved buffer SHOULD
 * refuse. `Stop-Process` would take the whole editor and every other window in
 * it; `CloseMainWindow` is `Get-Process` again and closes the wrong one.
 *
 * `PostMessage` rather than `SendMessage`: posting queues the message and
 * returns, while sending blocks until the target has finished handling it —
 * which, for a window that puts up a modal "save your changes?" dialog, is
 * until the user answers. That would hang the Stop button behind a dialog the
 * user has not noticed yet.
 *
 * ## Two things this file got wrong the first time, and what they cost
 *
 * Both produced the same symptom — **zero windows enumerated, no error** — on a
 * real Windows machine, which is the worst shape a bug can have here: it is
 * indistinguishable from a desktop that genuinely has no editor open, and it
 * reported as "could not find its window".
 *
 *   1. **The script went in on stdin, via `-Command -`.** That is not a way to
 *      run a script, it is a way to type one: PowerShell treats stdin as a
 *      console session, so a multi-line here-string and a `param()` block
 *      inside a script block are at the mercy of line-at-a-time parsing, and
 *      anything that goes wrong is a prompt rather than a failure. It is
 *      `-EncodedCommand` now — base64 of UTF-16LE, the documented way to hand
 *      PowerShell a script with no quoting rules in between. Encoding rather
 *      than escaping, for exactly the reason `encodeShellScript` gives.
 *   2. **stderr was thrown away.** `execFile` only rejects on a non-zero exit,
 *      and PowerShell will happily exit 0 having written a compile error to
 *      stderr and nothing to stdout. `runPowerShell` now treats "no stdout and
 *      some stderr" as the failure it is.
 *
 * The enumeration ALSO moved out of PowerShell and into the C#, which is the
 * third thing that would have made the first bug survivable: converting a
 * PowerShell script block into a `delegate` and having `EnumWindows` call back
 * into it is a documented capability and a lot of moving parts, and the loop
 * costs four lines in the language the callback is declared in.
 */

/**
 * The P/Invoke surface AND the enumeration, compiled once per helper run.
 *
 * A constant, with nothing interpolated into it ever. The handles the close
 * script acts on are checked against `/^\d+$/` in Node first — they are
 * integers this same helper printed on the previous call, so the check is a
 * restatement of what is already true rather than a sanitiser standing between
 * a user and a parser.
 *
 * `List()` answers `<hwnd>\t<pid>\t<title>` and deliberately does NOT resolve
 * the process name: `System.Diagnostics.Process` is in a different assembly on
 * .NET Framework than on .NET, so an `Add-Type` that reaches for it is one that
 * compiles under Windows PowerShell 5.1 and might not under PowerShell 7. The
 * mapping is one `Get-Process` in the shell instead, which is also a single
 * call rather than one per window.
 */
const PREAMBLE = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static class BoxwardenWindows {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  public static string[] List() {
    List<string> rows = new List<string>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      int length = GetWindowTextLengthW(hWnd);
      if (length <= 0) return true;
      StringBuilder text = new StringBuilder(length + 1);
      GetWindowTextW(hWnd, text, text.Capacity);
      uint processId = 0;
      GetWindowThreadProcessId(hWnd, out processId);
      rows.Add(hWnd.ToInt64() + "\\t" + processId + "\\t" + text);
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  public static void Close(long handle) {
    PostMessageW(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
`;

/**
 * `-match` with a regex rather than `String.Split`, and it is not a style
 * choice: the `Split(char, int)` overload was added in .NET Core 2.0 and does
 * not exist on the .NET Framework that Windows PowerShell 5.1 runs on. A
 * single-quoted PowerShell string keeps `\t` as two characters for .NET's regex
 * engine to interpret, so the backtick escaping this file otherwise has to
 * think about never arises.
 *
 * `Get-Process` gets `-ErrorAction SilentlyContinue` because `$ErrorActionPreference`
 * is `Stop`, and a process that exits between the enumeration and the read is an
 * ordinary race rather than a reason to abandon the whole listing.
 */
const LIST_SCRIPT = `${PREAMBLE}
$names = @{}
foreach ($process in (Get-Process -ErrorAction SilentlyContinue)) {
  $names[$process.Id] = $process.ProcessName
}
foreach ($row in [BoxwardenWindows]::List()) {
  if ($row -match '^(\\d+)\\t(\\d+)\\t(.*)$') {
    $name = $names[[int]$matches[2]]
    if ($name) { Write-Output ($matches[1] + [char]9 + $name + [char]9 + $matches[3]) }
  }
}
`;

/**
 * The close script, for handles this helper printed moments ago.
 *
 * Exported so the filter can be tested without a Windows machine, because the
 * filter is the security boundary: it is the only point where a string that
 * came from OUTSIDE this file — via `DesktopWindow.handle`, which the
 * enumeration built from a window on the user's desktop — is placed into a
 * program. `/^\d+$/` is a restatement of what `List()` emits rather than a
 * sanitiser, and anything failing it is dropped instead of escaped.
 */
export function windowsCloseScript(handles: readonly string[]): string | undefined {
  const safe = handles.filter((handle) => /^\d+$/.test(handle));
  if (safe.length === 0) return undefined;
  return `${PREAMBLE}
foreach ($handle in @(${safe.join(',')})) {
  [BoxwardenWindows]::Close([int64]$handle)
}
`;
}

/**
 * Run a script through `powershell.exe`, passed as `-EncodedCommand`.
 *
 * UTF-16LE base64 is what that switch takes, and it is the whole point: the
 * script below is several hundred characters of C# containing quotes, brackets,
 * braces and newlines, and none of them is ever seen by a command-line splitter
 * or by a console-session parser. `-NoProfile` keeps a developer's own profile
 * from printing into the table we are about to parse.
 */
async function runPowerShell(script: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { timeout: HELPER_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );

  // PowerShell will exit 0 having written a compile error to stderr and nothing
  // to stdout, and `execFile` only rejects on a non-zero exit. Swallowing that
  // is what turned a broken helper into "no editor window found" — a sentence
  // about the user's desktop, for a fault entirely on this side.
  if (stdout.trim() === '' && stderr.trim() !== '') {
    throw new Error(`powershell.exe wrote no output: ${stderr.trim()}`);
  }
  return stdout;
}

export const windowsBackend: DesktopWindowBackend = {
  async list(): Promise<readonly DesktopWindow[]> {
    return parseWindowTable(await runPowerShell(LIST_SCRIPT));
  },

  raw(): Promise<string> {
    return runPowerShell(LIST_SCRIPT);
  },

  async close(windows: readonly DesktopWindow[]): Promise<void> {
    const script = windowsCloseScript(windows.map((window) => window.handle));
    // Nothing to close, or nothing that could have come from `list`. Silent
    // either way: the only route to the second case is a bug in this file.
    if (script === undefined) return;
    await runPowerShell(script);
  },
};
