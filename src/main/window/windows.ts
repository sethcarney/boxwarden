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
 */

/**
 * The P/Invoke surface, compiled once per helper run.
 *
 * A constant, with nothing interpolated into it ever. The handles the close
 * script acts on are checked against `/^\d+$/` in Node first — they are
 * integers this same helper printed on the previous call, so the check is a
 * restatement of what is already true rather than a sanitiser standing between
 * a user and a parser.
 */
const PREAMBLE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BoxwardenWindows {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@
`;

/**
 * `$procId` and not `$pid`: `$pid` is a PowerShell automatic variable holding
 * the current process's own id, and assigning to it fails outright under
 * `Set-StrictMode`. The symptom would be an enumeration that throws on every
 * machine rather than one that answers wrongly, but it is the kind of thing
 * that is only obvious once.
 */
const LIST_SCRIPT = `${PREAMBLE}
$rows = New-Object System.Collections.ArrayList
$callback = [BoxwardenWindows+EnumProc] {
  param($hWnd, $lParam)
  if ([BoxwardenWindows]::IsWindowVisible($hWnd)) {
    $length = [BoxwardenWindows]::GetWindowTextLengthW($hWnd)
    if ($length -gt 0) {
      $buffer = New-Object System.Text.StringBuilder ($length + 1)
      [void][BoxwardenWindows]::GetWindowTextW($hWnd, $buffer, $buffer.Capacity)
      $procId = 0
      [void][BoxwardenWindows]::GetWindowThreadProcessId($hWnd, [ref]$procId)
      $name = ''
      try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $name = '' }
      if ($name -ne '') {
        [void]$rows.Add(($hWnd.ToInt64().ToString() + "\`t" + $name + "\`t" + $buffer.ToString()))
      }
    }
  }
  return $true
}
[void][BoxwardenWindows]::EnumWindows($callback, [IntPtr]::Zero)
$rows | ForEach-Object { Write-Output $_ }
`;

const WM_CLOSE = '0x0010';

function closeScript(handles: readonly string[]): string {
  const list = handles.map((handle) => `'${handle}'`).join(',');
  return `${PREAMBLE}
foreach ($handle in @(${list})) {
  [void][BoxwardenWindows]::PostMessageW([IntPtr][int64]$handle, ${WM_CLOSE}, [IntPtr]::Zero, [IntPtr]::Zero)
}
`;
}

/**
 * Run a script through `powershell.exe` on STDIN.
 *
 * `-Command -` reads the script from standard input, which sidesteps both the
 * command line's length limit and its quoting rules entirely — the P/Invoke
 * block above is several hundred characters of C# containing quotes, brackets
 * and newlines, and every one of those is inert on a pipe. `-NoProfile` keeps a
 * developer's own profile from printing into the table we are about to parse.
 */
async function runPowerShell(script: string): Promise<string> {
  const child = execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { timeout: HELPER_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  child.child.stdin?.end(script);
  const { stdout } = await child;
  return stdout;
}

export const windowsBackend: DesktopWindowBackend = {
  async list(): Promise<readonly DesktopWindow[]> {
    return parseWindowTable(await runPowerShell(LIST_SCRIPT));
  },

  async close(windows: readonly DesktopWindow[]): Promise<void> {
    // A handle that is not a run of digits cannot have come from `list`, so
    // there is nothing to do about it but drop it. Silently, because the only
    // way to reach this line is a bug in this file rather than anything the
    // user did.
    const handles = windows.map((window) => window.handle).filter((h) => /^\d+$/.test(h));
    if (handles.length === 0) return;
    await runPowerShell(closeScript(handles));
  },
};
