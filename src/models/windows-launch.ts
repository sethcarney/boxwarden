/**
 * Running a Windows `.cmd` shim without a shell.
 *
 * ## Why this exists
 *
 * Node refuses to spawn a `.cmd` or `.bat` unless `shell: true` — a deliberate
 * fix for CVE-2024-27980, where a batch file's arguments could break out into
 * cmd.exe. `shell: true` is exactly what this app's launchers must never do,
 * so `isSpawnableOnWindows` has always rejected shims and resolution fell
 * through to the GUI executable beside them.
 *
 * That compromise held until it did not. Cursor's `Cursor.exe` is no longer the
 * IDE — it opens the agents surface — so the executable that resolution falls
 * through to is the wrong program, and the CLI shim next to it is the right
 * one. The choice became "run a shim safely" or "launch the wrong window".
 *
 * ## How it is made safe
 *
 * Not by escaping. Escaping means modelling cmd.exe's parser correctly and
 * forever, which is the same losing bet `terminal/command.ts` refuses to make
 * about Windows Terminal. This models none of it: every argument must consist
 * ONLY of characters that cmd.exe does not interpret, and a launch whose
 * arguments do not qualify is REFUSED rather than escaped.
 *
 * An allowlist and not a denylist, because the failure directions are not
 * symmetric. A denylist that forgets `%` ships a variable expansion; an
 * allowlist that forgets a legal URI character costs a launch that says so and
 * offers the URI to copy. Fail closed.
 *
 * The arguments this actually has to carry are `--folder-uri`, `--new-window`
 * and `vscode-remote://dev-container+<hex>/<container path>` — a scheme, a hex
 * blob and a POSIX path — so the set below is wide enough for every ordinary
 * case and narrow enough to be obviously inert.
 */

/** `.cmd` and `.bat`: the two extensions Node will not spawn directly. */
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

export function isWindowsShim(path: string): boolean {
  const lower = path.toLowerCase();
  return SHIM_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Characters cmd.exe passes through untouched.
 *
 * Everything cmd treats as syntax is absent by construction: no `&` `|` `<` `>`
 * `^` `(` `)` `"` `%` `!`, no whitespace, no newline. `%` and `!` are the two
 * worth naming, because they are expansions rather than operators and a
 * denylist written from memory tends to miss them.
 *
 * A backslash is in, because it is not cmd syntax and every Windows path is
 * made of them. A SPACE is not, which is the deliberate cost: an editor
 * installed under `C:\Program Files\…` is refused here and falls back to
 * whatever the target table found instead. Quoting the path would fix that and
 * would mean reasoning about how cmd re-parses quotes — the exact bet this
 * module exists to avoid taking.
 */
const CMD_SAFE = /^[A-Za-z0-9+\-._~:/\\@]+$/;

export function isCmdSafeArgument(argument: string): boolean {
  return CMD_SAFE.test(argument);
}

/** What to spawn to run a shim, or undefined when an argument disqualifies it. */
export interface CmdShimLaunch {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Wrap a shim invocation in `cmd.exe /c`, or refuse.
 *
 * `/d` skips any AutoRun command the user's registry has configured, which is
 * a program this app has no business executing on their behalf. `/c` runs the
 * shim and exits.
 *
 * The shim's own PATH is checked the same way the arguments are: an install
 * directory containing a space is ordinary on Windows (`C:\Program Files\…`),
 * so this refuses far more often than it needs to — which is why it is a
 * fallback for shims and not the general launch path. When it refuses, the
 * caller still has a resolved binary and a URI to offer for copying.
 */
export function cmdShimLaunch(
  shimPath: string,
  args: readonly string[],
): CmdShimLaunch | undefined {
  if (!isCmdSafeArgument(shimPath)) return undefined;
  if (!args.every(isCmdSafeArgument)) return undefined;
  return { file: 'cmd.exe', args: ['/d', '/c', shimPath, ...args] };
}
