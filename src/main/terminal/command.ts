import type {
  ContainerCli,
  ContainerCliKind,
  ContainerPath,
  DockerTransport,
  TerminalTarget,
} from '../../models/index.js';

/**
 * Everything about "open a shell in this container" that can be decided
 * without touching the machine. The impure edge is `launch.ts`, which does
 * nothing but `spawn` what this file returns.
 *
 * This is where the security of the feature lives, so it is worth being
 * explicit about the threat. Two attacker-influenced strings flow through here:
 *
 *   - The container id, from Docker. Hex in practice, but not validated by us.
 *   - The startup command, authored by the user. Running it inside their own
 *     container is the entire point of the feature — it is *supposed* to be
 *     shell code, on the container's side of the boundary.
 *
 * Neither may become shell code on the HOST. Wherever possible that is
 * guaranteed structurally, by keeping everything an argv element and never
 * passing `shell: true`. Two terminal emulators make that impossible — macOS
 * Terminal and iTerm2 have no command-line interface, only AppleScript — and
 * for those the quoting below is the guarantee instead, which is why it is a
 * pure function with tests rather than a template literal at the call site.
 *
 * ## THE ARGV RULE, and why Windows forced it
 *
 * An argv array is only inert if every layer between here and the container
 * passes it along unchanged. On Linux and macOS that is true. **On Windows it
 * is not**, and there are two layers that rewrite it:
 *
 *   1. **Windows Terminal.** `wt new-tab a b c` does not forward an argv. It
 *      JOINS the remaining arguments back into one command line, wrapping an
 *      argument in double quotes if it contains a space and doing nothing about
 *      double quotes already inside it. An argument holding `exec "${BASH:-sh}"`
 *      therefore closes wt's quoting early, and whatever followed is re-split
 *      by CreateProcess as separate arguments. (microsoft/terminal#9313 is
 *      users discovering this by trial and error.)
 *
 *   2. **`wsl.exe`.** Without `--exec` a command line is handed to the distro's
 *      DEFAULT SHELL, which parses it again — so `$0`, `$(…)` and quotes in the
 *      payload are expanded on the Linux side of the boundary before the
 *      container ever sees them. `containerExecArgv` passes `--exec` for
 *      exactly this reason.
 *
 * The symptom was a terminal that opened at `/` instead of the workspace, with
 * a stray quote and the raw prompt escape sequences that `CONTAINER_BOOTSTRAP` was
 * written to prevent — the bootstrap itself had been chewed up in transit, so
 * dash ran bash's profile after all.
 *
 * So the rule this file now keeps, and `command.test.ts` pins over a hostile
 * startup command on every transport:
 *
 * > **No element of the launch argv may contain a double quote, a newline or a
 * > carriage return.**
 *
 * Spaces are fine — every layer above handles those. It is the quote and the
 * newline that no layer handles. The rule is kept by encoding the script (see
 * `encodeShellScript`) rather than by escaping anything, because escaping means
 * modelling three parsers correctly and encoding means modelling none.
 */

/**
 * Wrap a string so a POSIX shell reproduces it byte for byte.
 *
 * Single quotes rather than an escape-the-dangerous-characters list, because a
 * denylist is a bet that you thought of everything. Inside single quotes a
 * POSIX shell interprets nothing at all; the only character that cannot appear
 * is the single quote itself, which is closed, escaped, and reopened.
 */
export function posixQuoteOne(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** An argv array as a single shell command line. */
export function posixQuote(argv: readonly string[]): string {
  return argv.map(posixQuoteOne).join(' ');
}

/**
 * Wrap a string as an AppleScript string literal, quotes included.
 *
 * AppleScript string literals cannot contain a raw newline — the script fails
 * to compile — and the container shell script below is deliberately
 * multi-line, so the escapes are load-bearing rather than defensive. Backslash
 * has to be escaped first, or it would double-escape the ones the other rules
 * introduce.
 */
export function appleScriptString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `"${escaped}"`;
}

/**
 * `wt` reads `;` as a separator between its own subcommands, so an argument
 * containing one has to escape it or the tail of the command line silently
 * becomes a second `wt` subcommand. Node's spawn handles the space and quote
 * quoting around this; only `;` is `wt`'s own syntax.
 */
export function escapeForWindowsTerminal(value: string): string {
  return value.replaceAll(';', '\\;');
}

/**
 * The script the container's own shell runs.
 *
 * `sh -lc` because /bin/sh is the one shell every image is guaranteed to have,
 * and the script's first job is to hand over to bash when there is one — a
 * dev container almost always has bash, and dropping a developer into dash
 * with no history and no completion reads as a broken terminal.
 *
 * Three things happen in order, and the order is the whole design:
 *
 *   1. **`cd` to the workspace folder.** `docker exec` starts in the image's
 *      `WorkingDir`, which for most base images is `/` — so a terminal opened
 *      on a workspace lands nowhere near it.
 *   2. **The startup command**, which therefore runs FROM the workspace. It is
 *      not backgrounded, so a long-running one (`bun run dev`) holds the window
 *      and shows its output, which is the point of designating it.
 *      Interrupting it lands in the interactive shell rather than closing the
 *      window.
 *   3. **The handover**, which inherits that working directory.
 *
 * `exec` at the end: no leftover `sh` waiting underneath, so Ctrl-D closes the
 * window once rather than twice.
 *
 * ## Why `cd` here and not `docker exec -w`
 *
 * `-w` is the tidier mechanism and it is the wrong one, because
 * `workspaceFolder` is not always known — its third source is the
 * `/workspaces/<basename>` convention, i.e. a GUESS (see
 * `resolveWorkspaceFolder`). A `-w` at a path that does not exist makes the
 * daemon refuse the exec outright, and most emulators close a window whose
 * command exited immediately: clicking Terminal would appear to do nothing at
 * all. A `cd` that fails leaves the developer exactly where they are today,
 * with one line saying so. Degrading to the old behaviour beats failing shut.
 *
 * The path is attacker-influenced — it can come from a container label — so it
 * goes through `posixQuoteOne` like every other value this file turns into
 * shell code. That is inside the container, which is the boundary that matters:
 * on the HOST the whole script remains a single argv element.
 */
/**
 * Source the login files for their ENVIRONMENT, not for their output.
 *
 * ## The bug this exists for, which is the third face of the same one
 *
 * A terminal opened on Windows showed a line of garbage before the prompt —
 *
 *     \]\u@devcontainer\[\]:\[\]\w\[\]$(parse_git_branch)\[\]\$ '
 *
 * — and then worked perfectly. **Once, on the first load.** That "once" is the
 * whole diagnosis: it is not a mangled command line, which would be wrong on
 * every line forever. It is a login file printing on the way past.
 *
 * The signature is `\033` consumed while `\[`, `\]`, `\u` and `\w` survive,
 * which is what `echo -e` (or dash's `echo`) does to a `PS1` template. Some
 * profile script in the image echoes its prompt instead of only assigning it.
 *
 * boxwarden was the only thing that made that visible, because it ran the
 * developer's shell as a LOGIN shell — `bash -l` — while **VS Code's terminal
 * is not a login shell**. VS Code sources the login files once, out of band,
 * in `userEnvProbe`, keeps the environment and throws the output away; the
 * terminal it then opens reads only `~/.bashrc`. Running `bash -l` for the
 * terminal itself put that same output on the developer's screen, and on a
 * Debian image it also ran `~/.bashrc` an extra time, non-interactively, via
 * `~/.profile`.
 *
 * ## So this is `userEnvProbe`, done in one shell
 *
 * The profile is still sourced — dropping it would lose everything
 * `/etc/profile.d` puts on PATH, which is most of what a dev container
 * installs — but its stdout goes to `/dev/null`, and the shell is no longer a
 * login shell. That is the same bargain VS Code makes, in one process instead
 * of two.
 *
 * Three details worth keeping:
 *
 *   - **BOTH streams are discarded**, and that reverses an earlier decision
 *     here. Keeping stderr looked like the careful choice — the garbage is a
 *     successful `echo`, so why hide a real failure? — and it was wrong twice
 *     over. It did not fix the reported bug, because the noise was on stderr;
 *     and the premise was false, because a login file's stderr in a terminal
 *     window is not a diagnostic anybody acts on. It is the same line VS Code
 *     draws: `userEnvProbe` keeps the environment and discards the output,
 *     both streams, without qualification. A profile that genuinely fails
 *     shows up as the thing it broke, which is what the developer will
 *     actually notice.
 *   - **The search order is bash's own**: `/etc/profile`, then the FIRST of
 *     `~/.bash_profile`, `~/.bash_login`, `~/.profile`. Sourcing all three
 *     would run `~/.profile` on a machine where `~/.bash_profile` deliberately
 *     replaces it.
 *   - It lives in the SCRIPT rather than the bootstrap, so it is inside the
 *     base64 payload and free to use quotes, loops and newlines. The bootstrap
 *     has none of those available — see the argv rule at the top of this file.
 */
export const PROFILE = [
  '[ -r /etc/profile ] && . /etc/profile > /dev/null 2>&1',
  'for boxwarden_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do',
  '  [ -r "$boxwarden_profile" ] || continue',
  '  . "$boxwarden_profile" > /dev/null 2>&1',
  '  break',
  'done',
  'unset boxwarden_profile',
].join('\n');

export function containerShellScript(
  options: {
    /** Where to start. Omitted when the container did not say. */
    readonly workspaceFolder?: ContainerPath;
    readonly startupCommand?: string;
  } = {},
): string {
  // This script is never a command-line argument — `CONTAINER_BOOTSTRAP`
  // decodes it into a file inside the container and runs that. So it is free to
  // contain quotes and newlines, which is the whole point of the encoding, and
  // it is also responsible for tidying the file away.
  //
  // `$0` is the script's own path, set by `bash -l <file>` and by `sh -l
  // <file>` alike. Unlinking a script a shell is part-way through reading is
  // safe: the descriptor stays open and keeps the inode alive, so nothing here
  // races with the lines below it.
  const cleanup = 'rm -f -- "$0"';
  // INTERACTIVE, not login. The login files are sourced by `PROFILE` just
  // below, so what is left for the shell the developer types into is
  // `~/.bashrc` — the prompt, the aliases, the completions. Asking for `-l`
  // again would source the profile a second time, which is how PATH ends up
  // with every entry twice.
  //
  // `$BASH` is set by bash and unset by dash, so this lands in whichever shell
  // the bootstrap actually chose without asking a second time.
  const handover = 'exec "${BASH:-sh}" -i';
  const lines: string[] = [cleanup, PROFILE];

  const folder = options.workspaceFolder?.trim();
  if (folder !== undefined && folder !== '') {
    // Said out loud rather than swallowed: a shell that silently started
    // somewhere else is the bug this line exists to fix, and repeating it
    // quietly in the failure case would be the same bug with extra steps.
    const complaint = posixQuoteOne(
      `boxwarden: could not enter ${folder} — staying in the image's working directory.`,
    );
    lines.push(`cd ${posixQuoteOne(folder)} 2>/dev/null || printf '%s\\n' ${complaint} >&2`);
  }

  const startup = options.startupCommand?.trim();
  if (startup !== undefined && startup !== '') lines.push(startup);

  lines.push(handover);
  return lines.join('\n');
}

/**
 * The script, as a single argv element that no host-side parser can damage.
 *
 * Base64 and not an escape scheme, for the reason given at the top of this
 * file: escaping means modelling Windows Terminal's joiner, the C runtime's
 * command-line parser and `wsl.exe` correctly and forever, while encoding means
 * modelling none of them. The alphabet is `A-Za-z0-9+/=` — no quote, no
 * newline, no space, no semicolon — so there is nothing left for any of those
 * layers to interpret, and the same string reaches the container on every
 * platform.
 *
 * It costs one thing worth naming: the command boxwarden offers to copy when a
 * terminal cannot be opened is no longer readable. It is still correct, and it
 * still pastes and runs, which is what that fallback is for — and a single
 * unquoted token survives a paste into PowerShell or cmd rather better than the
 * multi-line quoted script it replaces.
 */
export function encodeShellScript(script: string): string {
  return Buffer.from(script, 'utf8').toString('base64');
}

/** Inverse of the above, for tests and for explaining a command line in diagnostics. */
export function decodeShellScript(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * Hand the script to a LOGIN BASH, never to a login `sh`.
 *
 * ## The bug this exists for
 *
 * `sh -lc <script>` — what this used to run — makes a LOGIN shell out of
 * `/bin/sh`, which on every Debian-based dev container image is **dash**. A
 * login shell sources `/etc/profile`, `/etc/profile.d/*` and `~/.profile`, and
 * in a dev container those files are written for bash: prompt definitions,
 * `PROMPT_COMMAND`, nvm's loader, a developer's own dotfiles.
 *
 * dash runs them anyway, and gets one thing importantly wrong: its `echo`
 * interprets backslash escapes, where bash's does not. So a perfectly ordinary
 * prompt line comes out as garbage the moment the terminal opens —
 *
 *     \]\u@devcontainer\[\]:\[\]\w\[\]$(parse_git_branch)\[\]\$
 *
 * — the `\033[…` colour codes consumed as real escapes, the `\[`/`\]` prompt
 * markers left as text, and any `\a` in a title sequence ringing the system
 * bell.
 *
 * ## Why it kept happening on Windows after the first fix
 *
 * The first fix passed the script as `$0` and had the bootstrap re-exec
 * `bash -lc "$0"`. That is correct, and on Windows it never arrived: the
 * bootstrap contains double quotes, and both `wt` and a shell-mode `wsl.exe`
 * rewrite an argument that has them (see the top of this file). What reached
 * the container was a fragment, `sh` fell back to running the profile itself,
 * and the same garbled prompt appeared — from the same cause, two layers away
 * from where anyone was looking.
 *
 * ## What this does instead
 *
 * The script arrives base64-encoded as `$0`, and the bootstrap writes it into a
 * file inside the container before running it. That buys three things at once:
 *
 *   - **The bootstrap contains no quote and no newline of its own.** Every
 *     expansion in it is either a fixed path or `$0`, which is base64 and
 *     therefore has nothing to word-split on — so the double quotes that used
 *     to be load-bearing are not needed anywhere.
 *   - **The script chooses the shell those files were written for.** The
 *     profile itself is sourced by the SCRIPT rather than by a `-l` here — see
 *     `PROFILE`, and the third face of this bug that made that necessary.
 *   - **The script can be anything at all**, since it is no longer a command
 *     line. That is what makes a user-authored startup command containing
 *     quotes, newlines or semicolons a non-event.
 *
 * `(umask 077 && …)` in a subshell so the file is never briefly world-readable
 * — it holds the user's startup command, which is the one thing here that might
 * carry a secret — and so the umask is restored before the developer's shell
 * inherits it.
 *
 * `test -s` is the guard for an image with no `base64` at all: rather than
 * running an empty script and closing the window instantly — which is how a
 * button appears to do nothing — it degrades to a bare interactive shell. That
 * substitute carries its own `rm` because the script it replaced was the thing
 * that would have tidied the file away.
 *
 * The `sh` fallback survives for an image with no bash. On such an image dash
 * IS the shell the profile was written for, so the failure mode above cannot
 * arise.
 *
 * ## Why this is a `&&` chain and not statements separated by `;`
 *
 * `;` is Windows Terminal's own subcommand separator, so one inside an argument
 * has to be escaped as `\;` and un-escaped again by a parser this repo has
 * never run — the exact kind of dependence on an unverified layer that the
 * argv rule at the top of this file exists to end. `&&`, `||` and `|` mean
 * nothing to `wt`, so the chain crosses untouched. `escapeForWindowsTerminal`
 * stays, and now has nothing left to escape.
 *
 * The short-circuiting is load-bearing, so it is worth reading once:
 *
 *   - `… || true` keeps a failed decode from skipping the guard behind it.
 *   - the last `exec` is deliberately NOT in a subshell. `exec` inside `( … )`
 *     replaces the SUBSHELL, leaving the parent `sh` waiting underneath the
 *     developer's shell — which is the "Ctrl-D twice to close the window" bug
 *     `containerShellScript` already avoids at its own end.
 */
export const CONTAINER_BOOTSTRAP = [
  'f=/tmp/.boxwarden-$$.sh',
  '((umask 077 && printf %s $0 | base64 -d > $f) 2>/dev/null || true)',
  '(test -s $f || (echo rm -f $f && echo exec sh -i) > $f)',
  'command -v bash > /dev/null 2>&1',
  'exec bash $f || exec sh $f',
].join(' && ');

/**
 * `DOCKER_HOST`-style URL for a transport, as the CLI spells it.
 *
 * Returns undefined when there is nothing useful to say, in which case the
 * caller omits the flag and lets the CLI use its own default — better than
 * passing a URL we invented.
 */
export function daemonUrl(transport: DockerTransport): string | undefined {
  switch (transport.transport) {
    case 'unix':
      return `unix://${transport.socketPath}`;
    case 'npipe':
      // The CLI wants forward slashes here even though Windows wrote the pipe
      // name with backslashes: `npipe:////./pipe/docker_engine`.
      return `npipe://${transport.pipeName.replaceAll('\\', '/')}`;
    case 'tcp':
      // TLS material is not carried over — a tcp+TLS daemon needs certificates
      // the spawned CLI would have to be handed as well, and guessing at
      // DOCKER_CERT_PATH would produce a confident wrong answer.
      return transport.tls === undefined
        ? `tcp://${transport.host}:${String(transport.port)}`
        : undefined;
    case 'ssh': {
      const user = transport.user === undefined ? '' : `${transport.user}@`;
      const port = transport.port === undefined ? '' : `:${String(transport.port)}`;
      return `ssh://${user}${transport.host}${port}`;
    }
    case 'wsl':
      // Meaningful only INSIDE the distro, where the socket is an ordinary unix
      // socket. containerExecArgv is what puts it on the right side of that
      // boundary.
      return `unix://${transport.socketPath}`;
  }
}

/** How each CLI spells "use this daemon". */
function daemonFlag(cli: ContainerCliKind, url: string): readonly string[] {
  return cli === 'podman' ? ['--url', url] : ['-H', url];
}

/**
 * The full argv that opens a shell in a container, ready to hand to a terminal.
 *
 * Every element it returns satisfies the argv rule at the top of this file — no
 * double quote, no newline — which is what lets `terminalLaunch` hand it to
 * Windows Terminal without inventing an escape scheme for it.
 *
 * The WSL arm is the interesting one. A socket inside a WSL2 distro cannot be
 * opened from Windows at all (see the `wsl` arm of `DockerTransport`), so the
 * exec has to happen on the Linux side: `wsl.exe -d <distro> --exec` and then
 * the distro's own CLI, by bare name because a Windows path would be
 * meaningless there. Everywhere else the host CLI is used at its resolved
 * absolute path.
 *
 * **`--exec` and not `--`**, and the difference is the whole Windows bug.
 * `wsl.exe` runs a command line through the distro's DEFAULT SHELL unless
 * `--exec` is given, so `--` meant the payload was parsed by bash on the Linux
 * side before `docker` ever saw it: the quotes became bash's quotes, `$0`
 * became bash's `$0`, and what arrived at the container was a mangled
 * fragment. `--exec` hands the arguments across as an argv, which is what every
 * other transport here already does.
 */
export function containerExecArgv(options: {
  readonly cli: ContainerCli;
  readonly containerId: string;
  readonly transport?: DockerTransport;
  /**
   * Who to become inside the container — `remoteUser` from the dev container's
   * own metadata. Omitted means the daemon uses the image's user, which is
   * what happens without the flag.
   *
   * This is the difference between a shell that has the developer's tools and
   * one that does not: everything a dev container installs for its user lands
   * on that user's PATH, and `docker exec` without `-u` lands as the image's
   * user, which is root far more often than not.
   */
  readonly user?: string;
  readonly script: string;
}): readonly string[] {
  const { cli, containerId, transport, user, script } = options;
  const url = transport === undefined ? undefined : daemonUrl(transport);
  const flags = url === undefined ? [] : daemonFlag(cli.kind, url);
  // `-u` before the container id, which is where both CLIs want it: everything
  // after the id is the command to run, so a flag there would be an argument
  // to `sh` instead.
  const asUser = user === undefined || user === '' ? [] : ['-u', user];
  // `sh -c <bootstrap> <encoded script>`: the script is the operand that
  // becomes `$0`, so it crosses as its own argv element and is never
  // interpolated into another shell string — and it is encoded, so no layer
  // between here and the container can damage it either. See CONTAINER_BOOTSTRAP.
  const exec = [
    'exec',
    '-it',
    ...asUser,
    containerId,
    'sh',
    '-c',
    CONTAINER_BOOTSTRAP,
    encodeShellScript(script),
  ];

  if (transport?.transport === 'wsl') {
    return ['wsl.exe', '-d', transport.distro, '--exec', cli.kind, ...flags, ...exec];
  }
  return [cli.binaryPath, ...flags, ...exec];
}

/** What `launch.ts` spawns: a program and its arguments, never a command line. */
export interface TerminalLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Wrap a container-exec argv in whatever the chosen terminal emulator wants.
 *
 * No window title is set. Every emulator spells that flag differently and, more
 * to the point, positions it differently relative to the flag that introduces
 * the command — `alacritty --title X -e cmd` versus `wt new-tab --title X cmd`
 * — so a single ordering in this function would silently mis-assemble half the
 * table. The emulators' own default is the running command line, which is
 * accurate and costs nothing to be right about.
 *
 * The AppleScript arm builds two `-e` fragments rather than one script with a
 * newline in it: `osascript` accepts repeated `-e` and joins them itself, which
 * keeps each fragment a single line and therefore keeps the string literal
 * legal. `activate` is separate because neither dialect focuses the window it
 * opens, and a terminal that appears behind the app reads as nothing having
 * happened.
 */
export function terminalLaunch(
  target: TerminalTarget,
  binaryPath: string,
  exec: readonly string[],
): TerminalLaunch {
  const { invocation } = target;

  switch (invocation.kind) {
    case 'argv': {
      const escaped =
        target.argumentEscaping === 'windows-terminal' ? exec.map(escapeForWindowsTerminal) : exec;
      return { command: binaryPath, args: [...invocation.flags, ...escaped] };
    }

    case 'command-string':
      return { command: binaryPath, args: [...invocation.flags, posixQuote(exec)] };

    case 'applescript': {
      const application = appleScriptString(invocation.application);
      const command = appleScriptString(posixQuote(exec));
      const open =
        invocation.dialect === 'iterm2'
          ? `tell application ${application} to create window with default profile command ${command}`
          : `tell application ${application} to do script ${command}`;
      return {
        command: 'osascript',
        args: ['-e', open, '-e', `tell application ${application} to activate`],
      };
    }
  }
}
