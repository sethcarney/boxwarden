import { describe, expect, it } from 'vitest';
import { classifyTopFailure, looksLikeClaudeCode, parseClaudeProcesses } from './claude.js';

/**
 * The fixtures are real `top` shapes, and the two engine layouts are the point
 * of most of this file. Docker's default `ps -ef` and Podman's default put the
 * command in the same position by coincidence and the timing column in
 * different ones — a parser written against one engine's indices passes half
 * of these and mislabels the rest.
 */

/** Docker: `UID PID PPID C STIME TTY TIME CMD`. */
const DOCKER_TITLES = ['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'TIME', 'CMD'];

/** Podman: `USER PID PPID %CPU ELAPSED TTY TIME COMMAND`. */
const PODMAN_TITLES = ['USER', 'PID', 'PPID', '%CPU', 'ELAPSED', 'TTY', 'TIME', 'COMMAND'];

const CLI_PATH =
  'node /usr/local/share/npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js';

function dockerRow(pid: string, command: string, stime = '10:31'): string[] {
  return ['node', pid, '1', '0', stime, 'pts/0', '00:00:02', command];
}

function podmanRow(pid: string, command: string, elapsed = '1h12m33.0s'): string[] {
  return ['node', pid, '1', '0.310', elapsed, 'pts/0', '00:00:11', command];
}

describe('parseClaudeProcesses', () => {
  describe('the Docker column layout', () => {
    it('finds the session and reports the start time, not a fabricated duration', () => {
      const status = parseClaudeProcesses(DOCKER_TITLES, [
        dockerRow('1', '/bin/sh -c sleep infinity', '09:02'),
        dockerRow('412', CLI_PATH, '10:31'),
      ]);

      expect(status).toEqual({
        kind: 'running',
        sessions: [{ pid: 412, command: CLI_PATH, startTime: '10:31' }],
      });
    });

    it('does not treat STIME as an elapsed time', () => {
      const status = parseClaudeProcesses(DOCKER_TITLES, [dockerRow('412', CLI_PATH)]);
      // The whole reason the two are separate fields: "10:31" is when it
      // started, and rendering it as "up 10:31" would age the session by ten
      // hours.
      expect(status.kind === 'running' && status.sessions[0]?.elapsed).toBeUndefined();
    });
  });

  describe('the Podman column layout', () => {
    it('finds the session by title, not by the index Docker uses', () => {
      const status = parseClaudeProcesses(PODMAN_TITLES, [
        podmanRow('1', '/usr/bin/sleep infinity', '9h2m1.0s'),
        podmanRow('221', CLI_PATH, '1h12m33.0s'),
      ]);

      expect(status).toEqual({
        kind: 'running',
        sessions: [{ pid: 221, command: CLI_PATH, elapsed: '1h12m33.0s' }],
      });
    });

    it('reads ELAPSED as a duration and leaves startTime absent', () => {
      const status = parseClaudeProcesses(PODMAN_TITLES, [podmanRow('221', CLI_PATH)]);
      expect(status.kind === 'running' && status.sessions[0]?.startTime).toBeUndefined();
    });
  });

  it('counts every session, so two agents in one container read as two', () => {
    const status = parseClaudeProcesses(PODMAN_TITLES, [
      podmanRow('221', CLI_PATH),
      podmanRow('907', '/usr/local/bin/claude', '4m8.0s'),
    ]);
    expect(status.kind === 'running' && status.sessions.map((s) => s.pid)).toEqual([221, 907]);
  });

  it('finds a wrapper script named claude, with no package path in sight', () => {
    const status = parseClaudeProcesses(DOCKER_TITLES, [dockerRow('88', '/usr/local/bin/claude')]);
    expect(status.kind).toBe('running');
  });

  /**
   * The false positive this feature would otherwise ship with. A dev container
   * runs Node constantly, and a badge that fires on any of it is worse than no
   * badge — the point is to be believed when it says "do not stop this".
   */
  it('is `none` for a container running Node but not Claude Code', () => {
    const status = parseClaudeProcesses(DOCKER_TITLES, [
      dockerRow('1', 'node /workspaces/webapp/server.js'),
      dockerRow('42', 'node /workspaces/webapp/node_modules/.bin/vite'),
      // A checkout whose path is full of the word.
      dockerRow('77', 'node /workspaces/claude-experiments/scripts/build.mjs'),
    ]);
    expect(status).toEqual({ kind: 'none' });
  });

  it('is `none` for an empty process list rather than unknown', () => {
    expect(parseClaudeProcesses(DOCKER_TITLES, [])).toEqual({ kind: 'none' });
  });

  it('rejoins a command that was split across extra cells', () => {
    // The engine splits `ps` output on whitespace, so an argument containing a
    // space arrives as a row wider than the title list.
    const row = [...dockerRow('412', CLI_PATH), '--append-system-prompt', 'be', 'terse'];
    const status = parseClaudeProcesses(DOCKER_TITLES, [row]);
    expect(status.kind === 'running' && status.sessions[0]?.command).toBe(
      `${CLI_PATH} --append-system-prompt be terse`,
    );
  });

  describe('a response we cannot read', () => {
    it('is unknown, not a throw, when the titles are missing', () => {
      expect(parseClaudeProcesses(undefined, [dockerRow('412', CLI_PATH)]).kind).toBe('unknown');
      expect(parseClaudeProcesses([], []).kind).toBe('unknown');
      expect(parseClaudeProcesses(null, null).kind).toBe('unknown');
    });

    it('is unknown when no column names the command', () => {
      const status = parseClaudeProcesses(['UID', 'PID', 'PPID'], [['node', '412', '1']]);
      expect(status.kind).toBe('unknown');
      // The reason names the columns that WERE there — this is the diagnostic
      // for an engine layout nobody has seen yet.
      expect(status.kind === 'unknown' && status.reason).toMatch(/UID, PID, PPID/);
    });

    it('is unknown when no column names the PID', () => {
      expect(parseClaudeProcesses(['USER', 'COMMAND'], [['node', CLI_PATH]]).kind).toBe('unknown');
    });

    it('is unknown — never none — when a session matched but its PID would not parse', () => {
      // "none" here would render a card whose Stop button looks safe while an
      // agent is mid-task in it. That is the failure this feature exists to
      // prevent, so an unreadable match has to stay loud.
      const status = parseClaudeProcesses(DOCKER_TITLES, [dockerRow('n/a', CLI_PATH)]);
      expect(status.kind).toBe('unknown');
    });

    it('is unknown when the rows are not arrays of strings', () => {
      expect(parseClaudeProcesses(DOCKER_TITLES, [{ pid: 412 }, 'nonsense']).kind).toBe('unknown');
    });

    it('skips an unreadable row but keeps a readable one', () => {
      const status = parseClaudeProcesses(DOCKER_TITLES, [null, dockerRow('412', CLI_PATH)]);
      expect(status.kind).toBe('running');
    });
  });

  it('matches titles case-insensitively, with surrounding whitespace', () => {
    const status = parseClaudeProcesses(
      [' uid ', 'Pid', 'ppid', 'c', 'Stime', 'tty', 'time', ' cmd '],
      [dockerRow('412', CLI_PATH)],
    );
    expect(status.kind).toBe('running');
  });
});

describe('looksLikeClaudeCode', () => {
  it.each([
    CLI_PATH,
    'node /home/node/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js --continue',
    '/usr/local/bin/claude',
    'claude',
    'claude --resume',
    '/bin/sh /usr/local/bin/claude',
    '/usr/bin/env claude',
    'node --max-old-space-size=8192 /opt/node_modules/@anthropic-ai/claude-code/cli.js',
  ])('matches %s', (command) => {
    expect(looksLikeClaudeCode(command)).toBe(true);
  });

  it.each([
    'node /workspaces/webapp/server.js',
    'node /workspaces/claude-experiments/build.mjs',
    // A path full of the word, and an executable that merely starts with it.
    '/usr/local/bin/claude-monitor --watch',
    'vim claude',
    'less /home/dev/claude',
    'postgres',
    '',
    '   ',
  ])('does not match %s', (command) => {
    expect(looksLikeClaudeCode(command)).toBe(false);
  });
});

describe('classifyTopFailure', () => {
  /**
   * `top` only answers for a live container, so a stopped one fails as a matter
   * of course. Mapping that to `unknown` would put a "could not tell" badge on
   * every stopped row in the list.
   */
  it.each([
    'Container a1b2c3 is not running',
    '(HTTP code 409) unexpected - Container abc is not running',
    'container state improper',
    'No such container: abc',
  ])('maps "%s" to not-applicable', (message) => {
    expect(classifyTopFailure(message)).toEqual({ kind: 'not-applicable' });
  });

  it('keeps a genuine failure as unknown, with the message intact', () => {
    expect(classifyTopFailure('connect ENOENT /var/run/docker.sock')).toEqual({
      kind: 'unknown',
      reason: 'connect ENOENT /var/run/docker.sock',
    });
  });
});
