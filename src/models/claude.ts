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
 * ## Scope: presence, not activity
 *
 * "Running / not running / for how long" is all this answers. Claude Code
 * exposes no supported status API, so working-vs-idle would mean reading
 * session transcripts or the IDE lock files under the container's `~/.claude`,
 * neither of which is a versioned interface, and both of which would need the
 * container's home directory located first. The process table is documented
 * and stable; that is the line this file stays on.
 *
 * ## Why not `exec`
 *
 * `top` needs no shell, writes nothing, and runs no code in the container. An
 * `exec` with a `ps | grep` string would be a far larger surface for a
 * strictly smaller answer, over data — the container's process table — that is
 * influenced by anyone who can create containers on the daemon. See
 * docs/electron-security.md.
 */

export interface ClaudeSession {
  readonly pid: number;
  /** The command line exactly as the engine reported it. */
  readonly command: string;
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
export function parseClaudeProcesses(titles: unknown, processes: unknown): ClaudeStatus {
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

  const sessions: ClaudeSession[] = [];
  let readableRows = 0;

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

    sessions.push({
      pid: pidValue,
      command: commandText,
      // exactOptionalPropertyTypes: an absent column is an absent key.
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
