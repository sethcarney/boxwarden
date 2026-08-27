/**
 * The pure half of "Quit VS Code": what to spawn, per platform, and how to
 * read the answers. The spawning and the waiting live in `quit.ts`, this
 * module has tests.
 *
 * ## What this is, and is not
 *
 * There is no supported way to close ONE VS Code window from outside: the
 * `code` CLI can open windows and cannot enumerate or close them, and the
 * command that closes a window (`workbench.action.closeWindow`) has no
 * command-line spelling. VS Code is also one process serving every window.
 * So the honest operation — the only one that reliably exists — is quitting
 * the application, and the UI says exactly that: every VS Code window on this
 * machine, not just the one attached to a container.
 *
 * ## Why graceful first, force second
 *
 * The same shape as Stop and Force stop on a container, for the same reason:
 * the two make different promises. The graceful step is the equivalent of the
 * user quitting VS Code themselves — hot exit (`files.hotExit`, on by
 * default) backs up unsaved buffers and the windows restore on next launch.
 * The force step is SIGKILL for whatever ignored the request; hot exit's
 * continuous backups mean even that typically costs seconds of typing, not
 * files, but it is still the blunt arm and it only runs after the polite one
 * was given time.
 *
 * ## Scope: VS Code stable, deliberately
 *
 * Only VS Code is targeted — not Insiders, Cursor or Windsurf, whose launch
 * support was removed at the same time this arrived (see
 * `src/models/editor.ts`). Their processes have different names and bundle
 * paths, and a quit button that had never been exercised against them would
 * be exactly the kind of untested fork path that removal exists to avoid.
 */

export interface QuitStep {
  readonly command: string;
  /** An argv, spawned with `shell: false` — nothing here is ever a shell string. */
  readonly args: readonly string[];
}

export interface EditorQuitPlan {
  /** Answers whether any VS Code process exists — see `probeSaysRunning`. */
  readonly probe: QuitStep;
  /** Ask VS Code to quit, the way the user would. */
  readonly graceful: QuitStep;
  /** SIGKILL whatever is left. Runs only after `graceful` was given time. */
  readonly force: QuitStep;
}

/** How long the graceful step is given before force, and how often to re-probe. */
export const GRACEFUL_WAIT_MS = 5_000;
export const PROBE_INTERVAL_MS = 500;
/** How long the force step is given before declaring failure. */
export const FORCE_WAIT_MS = 1_500;

/**
 * The process-match patterns, one per POSIX platform. `pgrep -f` / `pkill -f`
 * match an extended regex against the full command line, so these match the
 * main process AND its helpers — which is what force needs, and harmless for
 * the probe.
 *
 * macOS: everything VS Code runs lives under the app bundle, helpers
 * included, so the bundle directory is the discriminator. The `.` matching
 * any character is fine — it also matches itself.
 *
 * Linux: the deb installs `/usr/share/code/code`, the snap mounts the same
 * path under `/snap/code/...` (a substring match catches both), and the
 * flatpak runs `/app/extra/vscode/code`. A tarball unpacked somewhere unusual
 * is not matched, and the shell reports "no VS Code processes found" rather
 * than guessing.
 */
const MACOS_PATTERN = '/Visual Studio Code.app/Contents/';
const LINUX_PATTERN = '/usr/share/code/code|/app/extra/vscode/code';

export function editorQuitPlan(platform: string): EditorQuitPlan | undefined {
  switch (platform) {
    case 'win32':
      return {
        // `/NH` drops the header so the parse below is a plain substring
        // check. `tasklist` exits 0 whether or not anything matched, which is
        // why the answer is read from stdout on this platform.
        probe: { command: 'tasklist', args: ['/FI', 'IMAGENAME eq Code.exe', '/NH'] },
        // Without `/F`, taskkill posts WM_CLOSE — the same message the ✕
        // button sends — so VS Code runs its ordinary shutdown, hot exit
        // included.
        graceful: { command: 'taskkill', args: ['/IM', 'Code.exe'] },
        // `/T` takes the child processes too; a GPU or renderer process left
        // behind would otherwise keep the probe reporting "still running".
        force: { command: 'taskkill', args: ['/F', '/T', '/IM', 'Code.exe'] },
      };

    case 'darwin':
      return {
        probe: { command: 'pgrep', args: ['-f', MACOS_PATTERN] },
        // An Apple event, the same one ⌘Q delivers. The `is running` guard is
        // load-bearing: a bare `tell application … to quit` LAUNCHES the app
        // to deliver the event when it is not already running.
        graceful: {
          command: 'osascript',
          args: [
            '-e',
            'if application "Visual Studio Code" is running then tell application "Visual Studio Code" to quit',
          ],
        },
        force: { command: 'pkill', args: ['-9', '-f', MACOS_PATTERN] },
      };

    case 'linux':
      return {
        probe: { command: 'pgrep', args: ['-f', LINUX_PATTERN] },
        // Electron treats SIGTERM as a quit request; hot exit's backups are
        // already on disk regardless.
        graceful: { command: 'pkill', args: ['-TERM', '-f', LINUX_PATTERN] },
        force: { command: 'pkill', args: ['-KILL', '-f', LINUX_PATTERN] },
      };

    default:
      return undefined;
  }
}

/**
 * Whether a probe's answer means "at least one VS Code process exists".
 *
 * Two conventions, because the tools disagree: `pgrep` says it in the exit
 * code (0 = matched, 1 = nothing), while `tasklist` exits 0 either way and
 * says it in stdout — a matching row carries the image name, and the no-match
 * answer is an `INFO:` sentence that does not.
 */
export function probeSaysRunning(platform: string, exitCode: number, stdout: string): boolean {
  return platform === 'win32' ? stdout.includes('Code.exe') : exitCode === 0;
}
