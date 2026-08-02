import type {
  ContainerCli,
  ContainerCliKind,
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
 * The startup command runs BEFORE that handover and is not backgrounded, so a
 * long-running one (`bun run dev`) holds the window and shows its output,
 * which is the point of designating it. Interrupting it lands in the
 * interactive shell rather than closing the window.
 *
 * `exec` throughout: no leftover `sh` waiting underneath, so Ctrl-D closes the
 * window once rather than twice.
 */
export function containerShellScript(startupCommand?: string): string {
  const handover = 'if command -v bash > /dev/null 2>&1; then exec bash -l; else exec sh -l; fi';
  const startup = startupCommand?.trim();
  return startup === undefined || startup === '' ? handover : `${startup}\n${handover}`;
}

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
 * The WSL arm is the interesting one. A socket inside a WSL2 distro cannot be
 * opened from Windows at all (see the `wsl` arm of `DockerTransport`), so the
 * exec has to happen on the Linux side: `wsl.exe -d <distro> --` and then the
 * distro's own CLI, by bare name because a Windows path would be meaningless
 * there. Everywhere else the host CLI is used at its resolved absolute path.
 */
export function containerExecArgv(options: {
  readonly cli: ContainerCli;
  readonly containerId: string;
  readonly transport?: DockerTransport;
  readonly script: string;
}): readonly string[] {
  const { cli, containerId, transport, script } = options;
  const url = transport === undefined ? undefined : daemonUrl(transport);
  const flags = url === undefined ? [] : daemonFlag(cli.kind, url);
  const exec = ['exec', '-it', containerId, 'sh', '-lc', script];

  if (transport?.transport === 'wsl') {
    return ['wsl.exe', '-d', transport.distro, '--', cli.kind, ...flags, ...exec];
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
