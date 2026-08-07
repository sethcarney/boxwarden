/**
 * Whether a Claude Code session is running inside a container.
 *
 * The whole feature is derived from one read-only Docker call —
 * `GET /containers/{id}/top` — and everything in this file is the pure half of
 * it: given the `Titles`/`Processes` pair that endpoint returns, decide what to
 * say. No I/O, no engine handles, so the awkward cases (a Podman column
 * layout, a wrapper script, a container running Node for something else
 * entirely) are testable without a daemon.
 *
 * ## Scope: presence, and how hard it is working — but not what it wants
 *
 * This used to answer only "running / not running / for how long", on the
 * grounds that working-vs-idle would mean reading session transcripts or the
 * IDE lock files under the container's `~/.claude`. That reasoning was right
 * about the transcripts and wrong about the conclusion: two columns of the
 * SAME process table already answer most of it, so the activity signal costs
 * no extra call and stays on exactly the documented interface this file was
 * drawn around.
 *
 *   - **`TIME`** is cumulative CPU time. Diffed against the previous poll it
 *     says whether this session burned any CPU in the window — which is what
 *     a model streaming a response or a tool call chewing through a repo does,
 *     and what a session sitting at a prompt does not.
 *   - **`PPID`** identifies a row as a CHILD of a session, i.e. a tool call
 *     running right now. Sharper than the CPU delta because it is
 *     instantaneous rather than averaged over the poll interval.
 *
 * What is still out of reach is the state everyone wants most: **"waiting on a
 * prompt".** A session blocked on a permission question and a session sitting
 * idle after finishing are the same process to `top` — sleeping, no children,
 * no CPU — so there is no column that separates them and no honest way to
 * guess. `working` and `idle` are what the table supports, and folding a third
 * meaning into `idle` would be a lie in the one direction that costs work.
 *
 * Note what `%CPU` is NOT good for, since it looks like the obvious answer:
 * `ps` computes it as cumulative CPU over process LIFETIME, so a session that
 * worked hard an hour ago still reads high. The delta is the correct signal,
 * and it is the correct one on both engines.
 *
 * ## Why not `exec`
 *
 * `top` needs no shell, writes nothing, and runs no code in the container. An
 * `exec` with a `ps | grep` string would be a far larger surface for a
 * strictly smaller answer, over data — the container's process table — that is
 * influenced by anyone who can create containers on the daemon. See
 * docs/electron-security.md.
 */

/**
 * Whether a session is doing anything, as far as the process table can tell.
 *
 * Three arms and deliberately not four: `waiting-on-a-prompt` is not derivable
 * from `top` (see the note at the top of this file), and inventing it would put
 * a confident label on a guess.
 *
 * `unknown` is the honest first-poll answer. The CPU signal is a DELTA, so the
 * very first reading of a container has nothing to subtract from — and claiming
 * `idle` there would put "safe to stop" on a session that might be mid-task.
 * A subprocess is visible on the first reading, though, so a tool call is
 * caught even before there is a baseline.
 */
export type SessionActivity =
  | {
      readonly kind: 'working';
      /** Which signal fired, so a badge can say why and a bug report can be read. */
      readonly signal: 'cpu' | 'subprocess' | 'both';
    }
  | { readonly kind: 'idle' }
  | { readonly kind: 'unknown' };

/**
 * One reading of a session's CPU counter, kept so the next poll has something
 * to subtract from.
 *
 * Carried by the caller — the main process holds the last sample per container
 * — rather than by this module, which stays pure. `pid` is what pairs the two
 * readings up: a restarted session gets a new pid and therefore no baseline,
 * which is correct, because its counter restarted too.
 */
export interface ClaudeCpuSample {
  readonly pid: number;
  readonly cpuSeconds: number;
}

export interface ClaudeSession {
  readonly pid: number;
  /** The command line exactly as the engine reported it. */
  readonly command: string;
  /** Working, idle, or not yet knowable. */
  readonly activity: SessionActivity;
  /**
   * Cumulative CPU seconds, when the engine gave a `TIME` column this could
   * read. Absent leaves `activity` on the subprocess signal alone.
   */
  readonly cpuSeconds?: number;
  /**
   * A duration, from an `ELAPSED`-style column. Podman supplies one; Docker's
   * default `ps -ef` does not.
   */
  readonly elapsed?: string;
  /**
   * A wall-clock start time, from an `STIME`-style column — Docker's default.
   *
   * Kept separate from `elapsed` rather than folded into it because the two
   * are not interchangeable: an `STIME` of `10:32` is when the process
   * started, and rendering it as an elapsed time would claim a session had
   * been up for ten and a half hours when it started ten minutes ago.
   */
  readonly startTime?: string;
}

export type ClaudeStatus =
  /** Container is not running; the process table does not exist. */
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'none' }
  | { readonly kind: 'running'; readonly sessions: readonly ClaudeSession[] }
  /** top failed, or the engine returned a shape we could not read. */
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Column titles, by role.
 *
 * **Columns are found by title, never by index.** Docker's default is `ps -ef`
 * (`UID PID PPID C STIME TTY TIME CMD`); Podman returns
 * `USER PID PPID %CPU ELAPSED TTY TIME COMMAND`. The command happens to land
 * at the same index in both, and the elapsed/start column does not — indexing
 * would produce a parser that works on the author's machine and silently
 * mislabels every session on someone else's.
 */
const COMMAND_TITLES = ['CMD', 'COMMAND', 'ARGS', 'ARGUMENTS'];
const PID_TITLES = ['PID'];
const ELAPSED_TITLES = ['ELAPSED', 'ETIME', 'ETIMES'];
const START_TITLES = ['STIME', 'START', 'STARTED', 'START_TIME'];
/**
 * Cumulative CPU time. Both engines call it `TIME` — docker's `ps -ef` and
 * podman's default descriptors agree here, which is the only reason the
 * activity signal is portable at all.
 *
 * Not to be confused with `ELAPSED` above, which is wall-clock and already has
 * a job: `TIME` is how much CPU the process has consumed, `ELAPSED` is how long
 * it has existed. Reading one as the other is the same class of mistake as
 * `STIME` versus `ELAPSED`, which this file already warns about.
 */
const CPU_TIME_TITLES = ['TIME', 'TIME+', 'CPUTIME'];
const PPID_TITLES = ['PPID'];

/**
 * `[[DD-]HH:]MM:SS[.frac]` — what `ps` prints for a cumulative CPU time — as
 * seconds.
 *
 * Written tolerantly on purpose. The field is decoration on a badge, and the
 * cost of an unparseable value is `undefined`, which degrades to "we could not
 * tell" rather than to a wrong answer. Anything unrecognised therefore answers
 * `undefined` instead of guessing at a number that would go straight into a
 * subtraction.
 */
export function parseCpuTime(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  // `DD-HH:MM:SS` for a process that has burned more than a day of CPU.
  const [dayPart, clockPart] = trimmed.includes('-') ? trimmed.split('-', 2) : [undefined, trimmed];

  let seconds = 0;
  if (dayPart !== undefined) {
    // An EMPTY day part means the string simply began with `-`, i.e. a negative
    // duration. `Number('')` is 0, so without this check `-5` would parse as
    // five seconds — a value that then goes into a subtraction and reports
    // activity that never happened.
    if (dayPart === '') return undefined;
    const days = Number(dayPart);
    if (!Number.isFinite(days) || days < 0) return undefined;
    seconds += days * 86_400;
  }

  // `clockPart` is always a string: the `includes('-')` split guarantees a
  // second element, and the no-dash branch supplies the whole value.
  const parts = clockPart.split(':');
  if (parts.length > 3) return undefined;

  // Read right to left so `MM:SS`, `HH:MM:SS` and a bare `SS` all land on the
  // right multipliers without three separate branches.
  const multipliers = [1, 60, 3_600];
  for (let index = 0; index < parts.length; index += 1) {
    const value = Number(parts[parts.length - 1 - index]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    seconds += value * (multipliers[index] ?? 0);
  }

  return seconds;
}

/**
 * Fold the two signals into an activity.
 *
 * **Biased towards `working`, deliberately.** The two errors available here are
 * not symmetric: a false `idle` tells someone it is safe to stop an agent that
 * is mid-task, and a false `working` costs them a moment's hesitation. So ANY
 * CPU consumed since the last poll counts, with no threshold to tune — an idle
 * Node process blocked on its event loop consumes none, so the floor is already
 * where it needs to be, and a rounding tick at a one-second boundary that
 * occasionally reads as `working` is the error worth having.
 */
export function foldSessionActivity(reading: {
  /** A row in this same table whose PPID is this session's PID. */
  readonly hasSubprocess: boolean;
  readonly cpuSeconds: number | undefined;
  /** The same session's reading last poll, matched by pid. */
  readonly previousCpuSeconds: number | undefined;
}): SessionActivity {
  const { hasSubprocess, cpuSeconds, previousCpuSeconds } = reading;

  const burnedCpu =
    cpuSeconds !== undefined && previousCpuSeconds !== undefined && cpuSeconds > previousCpuSeconds;

  if (burnedCpu && hasSubprocess) return { kind: 'working', signal: 'both' };
  if (burnedCpu) return { kind: 'working', signal: 'cpu' };
  if (hasSubprocess) return { kind: 'working', signal: 'subprocess' };

  // No baseline to subtract from and nothing running under it. That is the
  // first poll for this session, not a statement that it is idle.
  if (cpuSeconds === undefined || previousCpuSeconds === undefined) return { kind: 'unknown' };

  return { kind: 'idle' };
}

/** The npm package path, which is what actually identifies the CLI. */
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';

/**
 * Programs that run *another* program named in their arguments. Only for these
 * is the second token considered as the executable, so
 * `/bin/sh /usr/local/bin/claude` matches while `vim claude` does not.
 */
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ash',
  'busybox',
  'env',
  'node',
  'nodejs',
  'bun',
  'deno',
]);

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Case-insensitive title lookup; first title in `wanted` that appears wins. */
function columnIndex(titles: readonly string[], wanted: readonly string[]): number | undefined {
  const normalised = titles.map((title) => title.trim().toUpperCase());
  for (const candidate of wanted) {
    const index = normalised.indexOf(candidate);
    if (index !== -1) return index;
  }
  return undefined;
}

function baseName(token: string): string {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return cut === -1 ? token : token.slice(cut + 1);
}

/**
 * The tokens that could name the program being run: the first, plus the first
 * non-flag argument when the first is an interpreter.
 */
function executableTokens(tokens: readonly string[]): readonly string[] {
  const first = tokens[0];
  if (first === undefined) return [];
  if (!INTERPRETERS.has(baseName(first))) return [first];

  const argument = tokens.slice(1).find((token) => !token.startsWith('-'));
  return argument === undefined ? [first] : [first, argument];
}

/**
 * Whether a command line is the Claude Code CLI.
 *
 * The CLI runs as a Node process, so the process name is `node` and the
 * identifying part is the script path — matching on a process literally named
 * `claude` would miss the common case entirely. Two rules, in order of
 * confidence:
 *
 *   1. Some token contains the package path `@anthropic-ai/claude-code`. Every
 *      install layout keeps that directory, so this covers a global npm
 *      install, a project-local one, and the native installer's bundled copy.
 *   2. The executable is named `claude` — the wrapper script the installers
 *      put on PATH.
 *
 * Deliberately NOT matched: any token merely containing "claude". A container
 * with a `/workspaces/claude-experiments` checkout runs plenty of commands
 * full of the word, and a badge that fires on those is worse than no badge:
 * the point of the feature is to be believed when it says "something is
 * running in here, do not stop it".
 */
export function looksLikeClaudeCode(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => token.includes(CLAUDE_CODE_PACKAGE))) return true;
  return executableTokens(tokens).some((token) => baseName(token) === 'claude');
}

/**
 * Read one row's command cell.
 *
 * When the command is the last column, any extra cells belong to it: engines
 * split the `ps` output on whitespace, and an argument list containing spaces
 * arrives as several cells that have to be rejoined. Splitting on that seam is
 * what turns `claude --append-system-prompt "be terse"` into a row wider than
 * the title list.
 */
function commandCell(
  row: readonly string[],
  index: number,
  columnCount: number,
): string | undefined {
  if (index !== columnCount - 1) return row[index];
  const tail = row.slice(index);
  return tail.length === 0 ? undefined : tail.join(' ');
}

/**
 * Every command line in a `top` response, or why it could not be read.
 *
 * Shared with `editor-session.ts`, which asks a different question of the same
 * table: whether an editor server is running in here. One reader rather than
 * two because the awkward parts — a title list that has to be searched by name,
 * a command column that has to be rejoined when it is last — are awkward in
 * exactly the same way for both, and a second copy would drift on the day
 * Podman changes a column heading.
 */
export function readCommandLines(
  titles: unknown,
  processes: unknown,
):
  | { readonly ok: true; readonly commands: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  if (!isStringArray(titles) || titles.length === 0) {
    return {
      ok: false,
      reason: 'The container engine returned a process table with no column titles.',
    };
  }
  if (!Array.isArray(processes)) {
    return { ok: false, reason: 'The container engine returned a process table with no rows.' };
  }

  const command = columnIndex(titles, COMMAND_TITLES);
  if (command === undefined) {
    return {
      ok: false,
      reason: `No command column in the process table (columns: ${titles.join(', ')}).`,
    };
  }

  const commands: string[] = [];
  for (const row of processes) {
    if (!isStringArray(row)) continue;
    const text = commandCell(row, command, titles.length);
    if (text !== undefined) commands.push(text);
  }
  return { ok: true, commands };
}

/**
 * Turn a `top` response into a status.
 *
 * `unknown` rather than a throw for every shape we cannot read: this runs on a
 * poll, the caller renders the result, and an engine that answers in an
 * unfamiliar layout should produce a badge that says so — not a crashed
 * refresh, and above all not a confident "no session running" that would make
 * the Stop button look safe.
 */
export function parseClaudeProcesses(
  titles: unknown,
  processes: unknown,
  /**
   * The previous poll's CPU readings for this container, matched by pid.
   *
   * A parameter and not module state, for the reason every clock and platform
   * in this codebase is one: a function that remembered its own last answer
   * could not be tested without running it twice in the right order. The main
   * process owns the memory; this owns the arithmetic.
   */
  previous: readonly ClaudeCpuSample[] = [],
): ClaudeStatus {
  if (!isStringArray(titles) || titles.length === 0) {
    return {
      kind: 'unknown',
      reason: 'The container engine returned a process table with no column titles.',
    };
  }
  if (!Array.isArray(processes)) {
    return {
      kind: 'unknown',
      reason: 'The container engine returned a process table with no rows.',
    };
  }

  const columns = titles.join(', ');
  const command = columnIndex(titles, COMMAND_TITLES);
  if (command === undefined) {
    return {
      kind: 'unknown',
      reason: `No command column in the process table (columns: ${columns}).`,
    };
  }
  const pid = columnIndex(titles, PID_TITLES);
  if (pid === undefined) {
    return { kind: 'unknown', reason: `No PID column in the process table (columns: ${columns}).` };
  }

  const elapsed = columnIndex(titles, ELAPSED_TITLES);
  const startTime = columnIndex(titles, START_TITLES);
  const cpuTime = columnIndex(titles, CPU_TIME_TITLES);
  const ppid = columnIndex(titles, PPID_TITLES);

  const sessions: ClaudeSession[] = [];
  let readableRows = 0;

  // Two passes, because a session's activity depends on OTHER rows: a tool call
  // is a row whose PPID names it, and that row can appear before or after its
  // parent. One pass would make the answer depend on `ps` output order.
  const parentPids = new Set<number>();
  if (ppid !== undefined) {
    for (const row of processes) {
      if (!isStringArray(row)) continue;
      const parent = Number.parseInt(row[ppid] ?? '', 10);
      if (Number.isInteger(parent)) parentPids.add(parent);
    }
  }

  const previousByPid = new Map(previous.map((sample) => [sample.pid, sample.cpuSeconds]));

  for (const row of processes) {
    if (!isStringArray(row)) continue;
    readableRows += 1;

    const commandText = commandCell(row, command, titles.length);
    if (commandText === undefined || !looksLikeClaudeCode(commandText)) continue;

    const pidText = row[pid];
    const pidValue = pidText === undefined ? Number.NaN : Number.parseInt(pidText, 10);
    if (!Number.isInteger(pidValue)) {
      // A row that matched but cannot be read is the one case where "none"
      // would be a lie: something IS running in there.
      return {
        kind: 'unknown',
        reason: `Found a Claude Code process but could not read its PID from "${pidText ?? ''}".`,
      };
    }

    const elapsedText = elapsed === undefined ? undefined : row[elapsed]?.trim();
    const startText = startTime === undefined ? undefined : row[startTime]?.trim();
    const cpuText = cpuTime === undefined ? undefined : row[cpuTime];
    const cpuSeconds = cpuText === undefined ? undefined : parseCpuTime(cpuText);

    sessions.push({
      pid: pidValue,
      command: commandText,
      activity: foldSessionActivity({
        hasSubprocess: parentPids.has(pidValue),
        cpuSeconds,
        previousCpuSeconds: previousByPid.get(pidValue),
      }),
      // exactOptionalPropertyTypes: an absent column is an absent key.
      ...(cpuSeconds === undefined ? {} : { cpuSeconds }),
      ...(elapsedText === undefined || elapsedText === '' ? {} : { elapsed: elapsedText }),
      ...(startText === undefined || startText === '' ? {} : { startTime: startText }),
    });
  }

  if (readableRows === 0 && processes.length > 0) {
    return {
      kind: 'unknown',
      reason: 'Every row of the process table was in an unreadable shape.',
    };
  }

  return sessions.length === 0 ? { kind: 'none' } : { kind: 'running', sessions };
}

/**
 * Patterns an engine uses to say "this container has no process table".
 *
 * `top` only answers for a live container. Docker replies 409 "Container ... is
 * not running", Podman "container state improper". Those are the ordinary case
 * for a stopped container, not a failure — mapping them to `unknown` would put
 * a "could not tell" badge on every stopped row in the list.
 */
const NO_PROCESS_TABLE = /not running|state improper|no such container|is not up|is paused/i;

/**
 * Whether a failed `top` means "this container has no process table" rather
 * than "something went wrong".
 *
 * Shared with `editor-session.ts` for the same reason `readCommandLines` is:
 * both features ask `top` the same question and both have to tell a stopped
 * container apart from a broken call, and two copies of this regex would drift.
 */
export function hasNoProcessTable(message: string): boolean {
  return NO_PROCESS_TABLE.test(message);
}

/** Classify a failed `top` call. The impure caller supplies the message. */
export function classifyTopFailure(message: string): ClaudeStatus {
  return hasNoProcessTable(message)
    ? { kind: 'not-applicable' }
    : { kind: 'unknown', reason: message };
}

/** How many sessions a status accounts for. `unknown` counts as none — it is not a session. */
export function sessionCount(status: ClaudeStatus | undefined): number {
  return status?.kind === 'running' ? status.sessions.length : 0;
}

/**
 * The CPU readings to hand back on the next poll.
 *
 * The caller stores these per container and passes them to the next
 * `parseClaudeProcesses`. Sessions with no readable `TIME` are dropped rather
 * than stored as zero — a fabricated baseline of 0 would make the very next
 * poll read as a large CPU burn and report `working` for a session that has
 * been sitting still all day.
 */
export function cpuSamplesOf(status: ClaudeStatus): readonly ClaudeCpuSample[] {
  if (status.kind !== 'running') return [];
  return status.sessions
    .filter((session) => session.cpuSeconds !== undefined)
    .map((session) => ({ pid: session.pid, cpuSeconds: session.cpuSeconds ?? 0 }));
}

/** Whether any session in a status is doing work right now. */
export function isWorking(status: ClaudeStatus | undefined): boolean {
  return status?.kind === 'running' && status.sessions.some((s) => s.activity.kind === 'working');
}
