import { describe, expect, it } from 'vitest';
import type { TerminalTarget } from '../../models/index.js';
import { asContainerPath } from '../../models/index.js';
import {
  appleScriptString,
  LOGIN_BOOTSTRAP,
  containerExecArgv,
  containerShellScript,
  daemonUrl,
  escapeForWindowsTerminal,
  posixQuote,
  posixQuoteOne,
  terminalLaunch,
} from './command.js';

/**
 * The startup command is the adversarial input in this file. It is authored by
 * the user and is *supposed* to be shell code — inside the container. Every
 * test below is really the same question asked of a different code path: does
 * it stay on the container's side of the boundary?
 */
const HOSTILE = `touch /tmp/pwned; echo 'quoted' && rm -rf $HOME "x"`;

const CONTAINER_ID = 'a1b2c3d4e5f6';

describe('posixQuoteOne', () => {
  it('leaves the value recoverable byte for byte', () => {
    expect(posixQuoteOne('bun run dev')).toBe(`'bun run dev'`);
    expect(posixQuoteOne('')).toBe(`''`);
  });

  it('neutralises every metacharacter by wrapping rather than escaping', () => {
    // The point of single quotes: this is a denylist-free guarantee. Nothing
    // inside is interpreted, so there is no character to have forgotten.
    expect(posixQuoteOne('$HOME `id` && rm -rf / | tee #')).toBe(
      `'$HOME \`id\` && rm -rf / | tee #'`,
    );
  });

  it('closes, escapes and reopens for the one character it cannot contain', () => {
    expect(posixQuoteOne(`it's`)).toBe(`'it'\\''s'`);
  });

  it('survives a round trip through a real shell', () => {
    // Not executed here — vitest runs without a shell in the pure suite — but
    // the reconstruction is mechanical: strip the quotes, undo the '\'' dance.
    const quoted = posixQuoteOne(HOSTILE);
    const unquoted = quoted.slice(1, -1).replaceAll(`'\\''`, `'`);
    expect(unquoted).toBe(HOSTILE);
  });
});

describe('posixQuote', () => {
  it('quotes every element, so an argument boundary cannot be forged', () => {
    expect(posixQuote(['docker', 'exec', '-it', 'id', 'sh', '-lc', 'echo hi'])).toBe(
      `'docker' 'exec' '-it' 'id' 'sh' '-lc' 'echo hi'`,
    );
  });
});

describe('appleScriptString', () => {
  /**
   * AppleScript string literals cannot contain a raw newline — the script
   * fails to COMPILE, so the symptom is osascript exiting with a syntax error
   * and no terminal appearing. The shell script this wraps is deliberately
   * multi-line, so these escapes are load-bearing, not defensive.
   */
  it('escapes the newline that would otherwise fail to compile', () => {
    expect(appleScriptString('a\nb')).toBe('"a\\nb"');
  });

  it('escapes backslashes before anything that introduces one', () => {
    expect(appleScriptString('C:\\x')).toBe('"C:\\\\x"');
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('cannot be closed early by a quote in the payload', () => {
    const literal = appleScriptString(posixQuote(['sh', '-lc', `echo "out"`]));
    // Exactly two unescaped quotes: the ones this function added.
    expect(literal.replaceAll('\\"', '').match(/"/g)).toHaveLength(2);
  });
});

describe('escapeForWindowsTerminal', () => {
  it('escapes the semicolon wt reads as a subcommand separator', () => {
    // Unescaped, `wt new-tab docker exec ... "a; b"` runs `docker exec ... a`
    // and then treats `b` as a second wt subcommand.
    expect(escapeForWindowsTerminal('a; b')).toBe('a\\; b');
  });

  it('leaves everything else alone', () => {
    expect(escapeForWindowsTerminal('docker')).toBe('docker');
  });
});

describe('containerShellScript', () => {
  /**
   * INTERACTIVE, not login: `LOGIN_BOOTSTRAP` already ran this script under
   * `bash -lc`, so the profile is sourced once and what remains for the shell
   * the developer types into is ~/.bashrc. `$BASH` lands in whichever shell the
   * bootstrap chose without asking twice.
   */
  it('hands over to an interactive shell, the one the bootstrap already chose', () => {
    expect(containerShellScript()).toContain('exec "${BASH:-sh}" -i');
  });

  it('execs rather than nesting, so one Ctrl-D closes the window', () => {
    expect(containerShellScript({ startupCommand: 'echo hi' })).toMatch(/^exec /m);
  });

  it('runs the startup command before handing over to the interactive shell', () => {
    const script = containerShellScript({ startupCommand: 'bun run dev' });
    const startup = script.indexOf('bun run dev');
    expect(startup).toBeGreaterThanOrEqual(0);
    expect(startup).toBeLessThan(script.indexOf('exec "${BASH:-sh}"'));
  });

  it('does not background the startup command', () => {
    // Deliberate: a dev server should hold the window and show its output, and
    // interrupting it should land in a shell rather than close the terminal.
    expect(containerShellScript({ startupCommand: 'bun run dev' })).not.toContain('&\n');
  });

  it('separates with a newline, not a semicolon, so a trailing comment cannot swallow the handover', () => {
    expect(containerShellScript({ startupCommand: 'echo hi # note' })).toBe(
      `echo hi # note\n${containerShellScript()}`,
    );
  });

  it('treats a blank or whitespace-only command as no command', () => {
    expect(containerShellScript({ startupCommand: '' })).toBe(containerShellScript());
    expect(containerShellScript({ startupCommand: '   ' })).toBe(containerShellScript());
  });

  /**
   * `docker exec` starts in the image's WorkingDir, which for most base images
   * is `/`. A terminal opened on a workspace has to land IN the workspace.
   */
  it('enters the workspace folder before anything else runs', () => {
    const script = containerShellScript({
      workspaceFolder: asContainerPath('/workspaces/webapp'),
      startupCommand: 'bun run dev',
    });

    expect(script).toContain(`cd '/workspaces/webapp'`);
    expect(script.indexOf('cd ')).toBeLessThan(script.indexOf('bun run dev'));
    expect(script.indexOf('bun run dev')).toBeLessThan(script.indexOf('exec "${BASH:-sh}"'));
  });

  it('says nothing about a folder the container did not name', () => {
    expect(containerShellScript()).not.toContain('cd ');
    expect(containerShellScript({ workspaceFolder: asContainerPath('  ') })).not.toContain('cd ');
  });

  /**
   * The reason this is a `cd` and not `docker exec -w`: the third source of
   * `workspaceFolder` is the `/workspaces/<basename>` convention, i.e. a guess.
   * A `-w` at a path that does not exist makes the daemon refuse the exec, and
   * an emulator closes the window of a command that exited — clicking Terminal
   * would look like it did nothing. This degrades to the old behaviour instead,
   * out loud.
   */
  it('carries on into a shell when the folder is not there, and says so', () => {
    const script = containerShellScript({ workspaceFolder: asContainerPath('/workspaces/gone') });

    expect(script).toContain('||');
    expect(script).toContain('exec "${BASH:-sh}" -i');
    expect(script).toMatch(/boxwarden: could not enter/);
  });

  /**
   * The path can come from a container label, so it is attacker-influenced by
   * anyone who can create containers on the daemon — the same standing as the
   * container id. It becomes shell code INSIDE the container, so it goes
   * through the same quoting as everything else that does.
   */
  it('quotes a hostile workspace folder rather than interpolating it', () => {
    const script = containerShellScript({ workspaceFolder: asContainerPath(HOSTILE) });

    // Wrapped, not escaped: nothing between the quotes is interpreted, and the
    // one quote inside is closed and reopened.
    expect(script).toContain(posixQuoteOne(HOSTILE));
    expect(script).not.toMatch(/^cd touch \/tmp\/pwned/m);
    // The complaint carries the path too, and is quoted just the same.
    expect(script).not.toContain(`rm -rf $HOME "x"\n`);
  });
});

describe('daemonUrl', () => {
  it('spells each transport the way the CLI expects', () => {
    expect(daemonUrl({ transport: 'unix', socketPath: '/var/run/docker.sock' })).toBe(
      'unix:///var/run/docker.sock',
    );
    expect(daemonUrl({ transport: 'tcp', host: '10.0.0.2', port: 2375 })).toBe(
      'tcp://10.0.0.2:2375',
    );
    expect(daemonUrl({ transport: 'ssh', host: 'box', user: 'dev', port: 2222 })).toBe(
      'ssh://dev@box:2222',
    );
  });

  it('turns a named pipe into forward slashes', () => {
    expect(daemonUrl({ transport: 'npipe', pipeName: '\\\\.\\pipe\\docker_engine' })).toBe(
      'npipe:////./pipe/docker_engine',
    );
  });

  /**
   * A TLS-protected tcp daemon needs certificates the spawned CLI would also
   * have to be handed. Passing the URL without them produces a confident wrong
   * answer — a connection that fails at handshake — so nothing is passed and
   * the CLI's own configuration decides.
   */
  it('declines to name a tcp daemon it cannot hand the certificates to', () => {
    expect(
      daemonUrl({ transport: 'tcp', host: 'remote', port: 2376, tls: { caPath: '/ca.pem' } }),
    ).toBeUndefined();
  });
});

describe('containerExecArgv', () => {
  const cli = { kind: 'docker', binaryPath: '/usr/bin/docker' } as const;

  /**
   * `docker exec` without `-u` enters as the IMAGE's user, which for most dev
   * container base images is root — while VS Code attaches as `remoteUser`.
   * Same container, different world: none of the tools a dev container installs
   * for its user are on root's PATH.
   */
  it("enters as the container's remote user, the way VS Code does", () => {
    const argv = containerExecArgv({
      cli,
      containerId: CONTAINER_ID,
      user: 'vscode',
      script: 'exec sh -l',
    });

    expect(argv).toEqual([
      '/usr/bin/docker',
      'exec',
      '-it',
      '-u',
      'vscode',
      CONTAINER_ID,
      'sh',
      '-c',
      LOGIN_BOOTSTRAP,
      'exec sh -l',
    ]);
  });

  /**
   * Position is not cosmetic: everything after the container id is the command
   * to run, so a `-u` there would be passed to `sh` rather than to the daemon.
   */
  it('puts -u before the container id, where the CLI expects it', () => {
    const argv = containerExecArgv({
      cli,
      containerId: CONTAINER_ID,
      user: 'vscode',
      script: 'exec sh -l',
    });

    expect(argv.indexOf('-u')).toBeLessThan(argv.indexOf(CONTAINER_ID));
  });

  it('says nothing when no user is known, leaving the daemon its default', () => {
    const argv = containerExecArgv({ cli, containerId: CONTAINER_ID, script: 'exec sh -l' });
    expect(argv).not.toContain('-u');
    expect(
      containerExecArgv({ cli, containerId: CONTAINER_ID, user: '', script: 'x' }),
    ).not.toContain('-u');
  });

  it('carries the user through the WSL arm as well', () => {
    const argv = containerExecArgv({
      cli: { kind: 'podman', binaryPath: '' },
      containerId: CONTAINER_ID,
      transport: { transport: 'wsl', distro: 'dev', socketPath: '/run/podman/podman.sock' },
      user: 'vscode',
      script: 'exec sh -l',
    });

    expect(argv.slice(0, 4)).toEqual(['wsl.exe', '-d', 'dev', '--']);
    expect(argv.indexOf('-u')).toBeLessThan(argv.indexOf(CONTAINER_ID));
  });

  it('names the daemon that owns the container, rather than trusting the default', () => {
    // boxwarden connects to every engine that answers. Without -H the exec
    // reaches whichever one the CLI defaults to and fails with "no such
    // container" on a machine where the container is plainly running.
    expect(
      containerExecArgv({
        cli,
        containerId: CONTAINER_ID,
        transport: { transport: 'unix', socketPath: '/run/user/1000/podman/podman.sock' },
        script: 'exec sh -l',
      }),
    ).toEqual([
      '/usr/bin/docker',
      '-H',
      'unix:///run/user/1000/podman/podman.sock',
      'exec',
      '-it',
      CONTAINER_ID,
      'sh',
      '-c',
      LOGIN_BOOTSTRAP,
      'exec sh -l',
    ]);
  });

  it('uses podman\u2019s spelling of the same flag', () => {
    const argv = containerExecArgv({
      cli: { kind: 'podman', binaryPath: '/usr/bin/podman' },
      containerId: CONTAINER_ID,
      transport: { transport: 'unix', socketPath: '/run/podman.sock' },
      script: 'exec sh -l',
    });
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/podman', '--url', 'unix:///run/podman.sock']);
  });

  it('omits the flag entirely when there is nothing honest to say', () => {
    const argv = containerExecArgv({ cli, containerId: CONTAINER_ID, script: 'exec sh -l' });
    expect(argv).toEqual([
      '/usr/bin/docker',
      'exec',
      '-it',
      CONTAINER_ID,
      'sh',
      '-c',
      LOGIN_BOOTSTRAP,
      'exec sh -l',
    ]);
  });

  /**
   * Windows cannot open a unix socket inside a WSL2 distro at all — see the
   * `wsl` arm of DockerTransport. So the exec has to happen on the Linux side,
   * which means the CLI is named bare (a Windows path would be meaningless in
   * there) and the socket becomes an ordinary unix path again.
   */
  it('runs inside the distro for a WSL socket', () => {
    expect(
      containerExecArgv({
        cli: { kind: 'podman', binaryPath: 'C:\\ignored\\podman.exe' },
        containerId: CONTAINER_ID,
        transport: { transport: 'wsl', distro: 'Ubuntu', socketPath: '/run/user/1000/podman.sock' },
        script: 'exec sh -l',
      }),
    ).toEqual([
      'wsl.exe',
      '-d',
      'Ubuntu',
      '--',
      'podman',
      '--url',
      'unix:///run/user/1000/podman.sock',
      'exec',
      '-it',
      CONTAINER_ID,
      'sh',
      '-c',
      LOGIN_BOOTSTRAP,
      'exec sh -l',
    ]);
  });

  it('keeps a hostile startup command in exactly one argv element', () => {
    const argv = containerExecArgv({
      cli,
      containerId: CONTAINER_ID,
      script: containerShellScript({ startupCommand: HOSTILE }),
    });
    // Not split, not escaped, not interpreted: one element, passed through.
    expect(argv.filter((part) => part.includes('rm -rf $HOME'))).toHaveLength(1);
    expect(argv.at(-1)).toContain(HOSTILE);
  });
});

describe('LOGIN_BOOTSTRAP', () => {
  const cli = { kind: 'docker', binaryPath: '/usr/bin/docker' } as const;

  /**
   * THE BUG. `sh -lc` made a LOGIN shell out of /bin/sh, which on every
   * Debian-based dev container image is dash, so dash sourced profile files
   * written for bash. dash's `echo` interprets backslash escapes where bash's
   * does not, so an ordinary prompt definition was emitted as raw escape
   * sequences and a bell before the real shell ever started.
   */
  it('never makes a login shell out of sh, which is dash', () => {
    const argv = containerExecArgv({ cli, containerId: CONTAINER_ID, script: 'exec sh -l' });

    // The literal that caused it. `sh` is invoked, but never as a login shell.
    expect(argv).not.toContain('-lc');
    expect(argv[argv.indexOf('sh') + 1]).toBe('-c');
  });

  it('runs the script under a login BASH when the container has one', () => {
    expect(LOGIN_BOOTSTRAP).toContain('command -v bash');
    expect(LOGIN_BOOTSTRAP).toContain('exec bash -lc "$0"');
  });

  /**
   * The fallback is the old behaviour, and it is safe precisely where it
   * applies: on an image with no bash, dash IS the shell those profile files
   * were written for.
   */
  it('still gives a login shell to an image that has no bash', () => {
    expect(LOGIN_BOOTSTRAP).toContain('exec sh -lc "$0"');
  });

  /**
   * The script rides as the operand that POSIX turns into `$0`, so it stays
   * its own argv element. That is what keeps a user-authored startup command
   * from needing a second layer of quoting — the layer most likely to be got
   * wrong.
   */
  it('passes the script as its own argument rather than interpolating it', () => {
    const script = containerShellScript({ startupCommand: HOSTILE });
    const argv = containerExecArgv({ cli, containerId: CONTAINER_ID, script });

    expect(argv.at(-1)).toBe(script);
    expect(argv.at(-2)).toBe(LOGIN_BOOTSTRAP);
    // The bootstrap is a constant: nothing the user or a label can influence
    // reaches it.
    expect(LOGIN_BOOTSTRAP).not.toContain(HOSTILE);
  });

  it('keeps the bootstrap in front of the container id, so it is the command', () => {
    const argv = containerExecArgv({ cli, containerId: CONTAINER_ID, script: 'x' });
    expect(argv.indexOf(CONTAINER_ID)).toBeLessThan(argv.indexOf(LOGIN_BOOTSTRAP));
  });
});

describe('terminalLaunch', () => {
  const exec = ['/usr/bin/docker', 'exec', '-it', CONTAINER_ID, 'sh', '-lc', 'echo hi'];

  function target(overrides: Partial<TerminalTarget>): TerminalTarget {
    return {
      id: 'test',
      displayName: 'Test',
      platforms: ['linux'],
      discovery: [],
      invocation: { kind: 'argv', flags: [] },
      ...overrides,
    };
  }

  it('passes argv through untouched for the emulators that accept it', () => {
    const launch = terminalLaunch(
      target({ invocation: { kind: 'argv', flags: ['--'] } }),
      '/usr/bin/gnome-terminal',
      exec,
    );
    expect(launch).toEqual({ command: '/usr/bin/gnome-terminal', args: ['--', ...exec] });
  });

  it('collapses to one quoted string only where the emulator demands it', () => {
    const launch = terminalLaunch(
      target({ invocation: { kind: 'command-string', flags: ['-e'] } }),
      '/usr/bin/x-terminal-emulator',
      exec,
    );
    expect(launch.args).toHaveLength(2);
    expect(launch.args[1]).toBe(posixQuote(exec));
  });

  it('escapes wt\u2019s separator, and only for wt', () => {
    const withSemicolon = [...exec.slice(0, -1), 'echo a; echo b'];
    const wt = terminalLaunch(
      target({
        invocation: { kind: 'argv', flags: ['new-tab'] },
        argumentEscaping: 'windows-terminal',
      }),
      'wt.exe',
      withSemicolon,
    );
    expect(wt.args.at(-1)).toBe('echo a\\; echo b');

    const plain = terminalLaunch(target({}), 'kitty', withSemicolon);
    expect(plain.args.at(-1)).toBe('echo a; echo b');
  });

  /**
   * Terminal.app and iTerm2 have no command-line interface, so this is the one
   * path where the command becomes a string a shell will parse. Two layers of
   * quoting have to hold: POSIX inside, AppleScript outside.
   */
  it('double-quotes through AppleScript for Terminal.app', () => {
    const launch = terminalLaunch(
      target({
        invocation: { kind: 'applescript', application: 'Terminal', dialect: 'terminal-app' },
      }),
      '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
      exec,
    );
    expect(launch.command).toBe('osascript');
    expect(launch.args[1]).toContain('tell application "Terminal" to do script ');
    expect(launch.args[3]).toBe('tell application "Terminal" to activate');
  });

  it('uses iTerm2\u2019s verb, which is not do script', () => {
    // iTerm2 3.x dropped `do script`. Sending it anyway compiles and silently
    // does nothing, which is the worst kind of wrong.
    const launch = terminalLaunch(
      target({ invocation: { kind: 'applescript', application: 'iTerm', dialect: 'iterm2' } }),
      '/Applications/iTerm.app/Contents/MacOS/iTerm2',
      exec,
    );
    expect(launch.args[1]).toContain(
      'tell application "iTerm" to create window with default profile command ',
    );
  });

  it('keeps a hostile startup command inside the AppleScript literal', () => {
    const script = containerShellScript({ startupCommand: HOSTILE });
    const launch = terminalLaunch(
      target({
        invocation: { kind: 'applescript', application: 'Terminal', dialect: 'terminal-app' },
      }),
      '/bin/Terminal',
      containerExecArgv({
        cli: { kind: 'docker', binaryPath: '/usr/bin/docker' },
        containerId: CONTAINER_ID,
        script,
      }),
    );

    const statement = launch.args[1] ?? '';
    // The literal opened after `do script ` must not be closed until the end:
    // if it were, everything after would be AppleScript source rather than a
    // string, which is how this path would become host-side execution.
    const literal = statement.slice(statement.indexOf('do script ') + 'do script '.length);
    expect(literal.startsWith('"')).toBe(true);
    expect(literal.endsWith('"')).toBe(true);
    expect(literal.slice(1, -1).replaceAll('\\"', '')).not.toContain('"');
    expect(literal).not.toContain('\n');
  });
});
