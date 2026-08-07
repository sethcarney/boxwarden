import { describe, expect, it } from 'vitest';
import {
  classifyTopFailure,
  cpuSamplesOf,
  foldSessionActivity,
  looksLikeClaudeCode,
  parseClaudeProcesses,
  parseCpuTime,
} from './claude.js';

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
        sessions: [
          {
            pid: 412,
            command: CLI_PATH,
            // No previous poll to subtract from, so activity is not yet
            // knowable — see the note on SessionActivity.
            activity: { kind: 'unknown' },
            cpuSeconds: 2,
            startTime: '10:31',
          },
        ],
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
        sessions: [
          {
            pid: 221,
            command: CLI_PATH,
            activity: { kind: 'unknown' },
            cpuSeconds: 11,
            elapsed: '1h12m33.0s',
          },
        ],
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

describe('parseCpuTime', () => {
  it('reads the HH:MM:SS docker prints', () => {
    expect(parseCpuTime('00:00:04')).toBe(4);
    expect(parseCpuTime('01:02:03')).toBe(3_723);
  });

  it('reads MM:SS and a bare count of seconds', () => {
    expect(parseCpuTime('02:30')).toBe(150);
    expect(parseCpuTime('7')).toBe(7);
  });

  /** ps switches to this once a process has burned more than a day of CPU. */
  it('reads the DD-HH:MM:SS form', () => {
    expect(parseCpuTime('2-01:00:00')).toBe(2 * 86_400 + 3_600);
  });

  it('keeps fractional seconds, which podman can emit', () => {
    expect(parseCpuTime('00:00:04.500')).toBe(4.5);
  });

  /**
   * Answers nothing rather than guessing. The value goes straight into a
   * subtraction, and a wrong number there is a wrong ACTIVITY — where
   * `undefined` is merely "not measured", which the fold handles.
   */
  it('refuses anything it does not recognise', () => {
    expect(parseCpuTime('')).toBeUndefined();
    expect(parseCpuTime('   ')).toBeUndefined();
    expect(parseCpuTime('n/a')).toBeUndefined();
    expect(parseCpuTime('1:2:3:4')).toBeUndefined();
    expect(parseCpuTime('-5')).toBeUndefined();
  });
});

describe('foldSessionActivity', () => {
  it('reports working when CPU was consumed since the last poll', () => {
    expect(
      foldSessionActivity({ hasSubprocess: false, cpuSeconds: 12, previousCpuSeconds: 9 }),
    ).toEqual({ kind: 'working', signal: 'cpu' });
  });

  /**
   * The instantaneous half. A tool call is a child process, and it shows on the
   * very first reading — before there is any CPU baseline to subtract from.
   */
  it('reports working when a subprocess is running, with no baseline at all', () => {
    expect(
      foldSessionActivity({
        hasSubprocess: true,
        cpuSeconds: undefined,
        previousCpuSeconds: undefined,
      }),
    ).toEqual({ kind: 'working', signal: 'subprocess' });
  });

  it('names both signals when both fired', () => {
    expect(
      foldSessionActivity({ hasSubprocess: true, cpuSeconds: 12, previousCpuSeconds: 9 }),
    ).toEqual({ kind: 'working', signal: 'both' });
  });

  it('reports idle when the counter did not move and nothing is running under it', () => {
    expect(
      foldSessionActivity({ hasSubprocess: false, cpuSeconds: 9, previousCpuSeconds: 9 }),
    ).toEqual({ kind: 'idle' });
  });

  /**
   * The first poll of a session, and the reason `unknown` exists. Saying `idle`
   * here would put "safe to stop" on a session that might be mid-task, which is
   * the one error this feature must not make.
   */
  it('reports unknown with no baseline to subtract from', () => {
    expect(
      foldSessionActivity({ hasSubprocess: false, cpuSeconds: 9, previousCpuSeconds: undefined }),
    ).toEqual({ kind: 'unknown' });
  });

  it('reports unknown when the engine gave no readable TIME column', () => {
    expect(
      foldSessionActivity({ hasSubprocess: false, cpuSeconds: undefined, previousCpuSeconds: 9 }),
    ).toEqual({ kind: 'unknown' });
  });

  /**
   * The bias, pinned. Any movement counts — there is no threshold to tune,
   * because an idle Node process blocked on its event loop consumes none, and a
   * false `working` costs a moment's hesitation where a false `idle` costs the
   * work in a running agent.
   */
  it('treats a single second of CPU as working', () => {
    expect(
      foldSessionActivity({ hasSubprocess: false, cpuSeconds: 10, previousCpuSeconds: 9 }),
    ).toMatchObject({ kind: 'working' });
  });

  /** A counter that went BACKWARDS is a recycled pid, not negative work. */
  it('does not read a counter that went backwards as working', () => {
    expect(
      foldSessionActivity({ hasSubprocess: false, cpuSeconds: 2, previousCpuSeconds: 9 }),
    ).toEqual({ kind: 'idle' });
  });
});

describe('parseClaudeProcesses — activity', () => {
  /** `UID PID PPID C STIME TTY TIME CMD`, with TIME at index 6. */
  function rowWithCpu(pid: string, command: string, cpu: string, ppid = '1'): string[] {
    return ['node', pid, ppid, '0', '10:31', 'pts/0', cpu, command];
  }

  it('reports working once the CPU counter has moved between polls', () => {
    const first = parseClaudeProcesses(DOCKER_TITLES, [rowWithCpu('412', CLI_PATH, '00:00:02')]);
    expect(first.kind === 'running' && first.sessions[0]?.activity).toEqual({ kind: 'unknown' });

    const second = parseClaudeProcesses(
      DOCKER_TITLES,
      [rowWithCpu('412', CLI_PATH, '00:00:09')],
      cpuSamplesOf(first),
    );
    expect(second.kind === 'running' && second.sessions[0]?.activity).toEqual({
      kind: 'working',
      signal: 'cpu',
    });
  });

  it('reports idle when the counter stood still', () => {
    const first = parseClaudeProcesses(DOCKER_TITLES, [rowWithCpu('412', CLI_PATH, '00:00:02')]);
    const second = parseClaudeProcesses(
      DOCKER_TITLES,
      [rowWithCpu('412', CLI_PATH, '00:00:02')],
      cpuSamplesOf(first),
    );
    expect(second.kind === 'running' && second.sessions[0]?.activity).toEqual({ kind: 'idle' });
  });

  /**
   * A tool call. The child row's PPID names the session, and it is caught on
   * the FIRST poll — before any CPU baseline exists.
   */
  it('reports working when a subprocess is running under the session', () => {
    const status = parseClaudeProcesses(DOCKER_TITLES, [
      rowWithCpu('412', CLI_PATH, '00:00:02'),
      rowWithCpu('998', 'bash -lc bun run test', '00:00:00', '412'),
    ]);
    expect(status.kind === 'running' && status.sessions[0]?.activity).toEqual({
      kind: 'working',
      signal: 'subprocess',
    });
  });

  /**
   * The child can appear before its parent in `ps` output, so the parent set is
   * built in a pass of its own. One pass would make the answer depend on order.
   */
  it('finds a subprocess listed above its parent', () => {
    const status = parseClaudeProcesses(DOCKER_TITLES, [
      rowWithCpu('998', 'bash -lc bun run test', '00:00:00', '412'),
      rowWithCpu('412', CLI_PATH, '00:00:02'),
    ]);
    expect(status.kind === 'running' && status.sessions[0]?.activity).toMatchObject({
      kind: 'working',
    });
  });

  it('matches baselines per pid, so a restarted session gets no stale one', () => {
    const first = parseClaudeProcesses(DOCKER_TITLES, [rowWithCpu('412', CLI_PATH, '00:01:00')]);
    // Same container, new process: the counter restarted with the pid.
    const second = parseClaudeProcesses(
      DOCKER_TITLES,
      [rowWithCpu('500', CLI_PATH, '00:00:01')],
      cpuSamplesOf(first),
    );
    expect(second.kind === 'running' && second.sessions[0]?.activity).toEqual({ kind: 'unknown' });
  });

  it('reads the podman layout the same way', () => {
    const podman = (pid: string, cpu: string, ppid = '1') => [
      'node',
      pid,
      ppid,
      '0.310',
      '1h12m33.0s',
      'pts/0',
      cpu,
      CLI_PATH,
    ];
    const first = parseClaudeProcesses(PODMAN_TITLES, [podman('221', '00:00:11')]);
    const second = parseClaudeProcesses(
      PODMAN_TITLES,
      [podman('221', '00:00:14')],
      cpuSamplesOf(first),
    );
    expect(second.kind === 'running' && second.sessions[0]?.activity).toEqual({
      kind: 'working',
      signal: 'cpu',
    });
  });
});

describe('cpuSamplesOf', () => {
  it('carries the pid and counter forward', () => {
    const status = parseClaudeProcesses(DOCKER_TITLES, [
      ['node', '412', '1', '0', '10:31', 'pts/0', '00:00:07', CLI_PATH],
    ]);
    expect(cpuSamplesOf(status)).toEqual([{ pid: 412, cpuSeconds: 7 }]);
  });

  it('has nothing to carry for a container with no session', () => {
    expect(cpuSamplesOf({ kind: 'none' })).toEqual([]);
    expect(cpuSamplesOf({ kind: 'unknown', reason: 'x' })).toEqual([]);
  });

  /**
   * A session with no readable TIME is DROPPED rather than stored as zero. A
   * fabricated baseline of 0 would make the very next poll read as a large
   * burn and report `working` for a session that has been still all day.
   */
  it('drops a session whose CPU could not be read, rather than storing a zero', () => {
    const noTimeColumn = ['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'CMD'];
    const status = parseClaudeProcesses(noTimeColumn, [
      ['node', '412', '1', '0', '10:31', 'pts/0', CLI_PATH],
    ]);
    expect(status.kind).toBe('running');
    expect(cpuSamplesOf(status)).toEqual([]);
  });
});
