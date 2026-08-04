import { describe, expect, it } from 'vitest';
import type { TerminalTarget } from '../../models/index.js';
import {
  appleScriptString,
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
  it('prefers bash and falls back to sh, because dash reads as a broken terminal', () => {
    const script = containerShellScript();
    expect(script).toContain('command -v bash');
    expect(script).toContain('exec bash -l');
    expect(script).toContain('exec sh -l');
  });

  it('execs rather than nesting, so one Ctrl-D closes the window', () => {
    expect(containerShellScript()).not.toMatch(/\bbash -l\s*$/);
    expect(containerShellScript('echo hi')).toContain('exec bash -l');
  });

  it('runs the startup command before handing over to the interactive shell', () => {
    const script = containerShellScript('bun run dev');
    const startup = script.indexOf('bun run dev');
    expect(startup).toBeGreaterThanOrEqual(0);
    expect(startup).toBeLessThan(script.indexOf('exec bash -l'));
  });

  it('does not background the startup command', () => {
    // Deliberate: a dev server should hold the window and show its output, and
    // interrupting it should land in a shell rather than close the terminal.
    expect(containerShellScript('bun run dev')).not.toContain('&\n');
  });

  it('separates with a newline, not a semicolon, so a trailing comment cannot swallow the handover', () => {
    expect(containerShellScript('echo hi # note')).toBe(
      `echo hi # note\n${containerShellScript()}`,
    );
  });

  it('treats a blank or whitespace-only command as no command', () => {
    expect(containerShellScript('')).toBe(containerShellScript());
    expect(containerShellScript('   ')).toBe(containerShellScript());
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
      '-lc',
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
      '-lc',
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
      '-lc',
      'exec sh -l',
    ]);
  });

  it('keeps a hostile startup command in exactly one argv element', () => {
    const argv = containerExecArgv({
      cli,
      containerId: CONTAINER_ID,
      script: containerShellScript(HOSTILE),
    });
    // Not split, not escaped, not interpreted: one element, passed through.
    expect(argv.filter((part) => part.includes('rm -rf $HOME'))).toHaveLength(1);
    expect(argv.at(-1)).toContain(HOSTILE);
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
    const script = containerShellScript(HOSTILE);
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
