import type { HostPlatform } from './advice.js';
import type { BinaryDiscovery } from './discovery.js';

/**
 * Opening a shell inside a dev container is `docker exec -it <id> <shell>`
 * running in a terminal window. Neither half is uniform:
 *
 *   - Which CLI. `docker` and `podman` take different flags for "talk to THIS
 *     daemon", and the daemon matters because boxwarden connects to every
 *     engine that answers (see DockerEnvironment.attempts). Sending the exec to
 *     whichever daemon the CLI happens to default to would fail with "no such
 *     container" on a machine where the container is plainly running.
 *
 *   - Which terminal, and how it wants to be told what to run. There are three
 *     genuinely different answers, modelled as `TerminalInvocation` below, and
 *     the differences are not cosmetic: one of them cannot take an argv array
 *     at all, which is what forces the quoting code in
 *     `src/main/terminal/command.ts` to exist.
 */

export type KnownTerminalId =
  | 'macos-terminal'
  | 'iterm2'
  | 'gnome-terminal'
  | 'konsole'
  | 'xfce4-terminal'
  | 'kitty'
  | 'alacritty'
  | 'wezterm'
  | 'x-terminal-emulator'
  | 'xterm'
  | 'windows-terminal'
  | 'windows-console';

/** Open-ended for the same reason `EditorId` is: a fork should not need a code change. */
export type TerminalId = KnownTerminalId | (string & {});

/**
 * How a terminal emulator accepts the command it should run.
 *
 * `argv` is the safe one and the default: the command and its arguments are
 * separate argv elements all the way down, so nothing is ever parsed as shell
 * syntax. `command-string` and `applescript` are concessions to emulators that
 * only accept a single string — the quoting for those is in
 * `src/main/terminal/command.ts`, written once and tested, rather than
 * open-coded per target.
 */
export type TerminalInvocation =
  /** `gnome-terminal -- docker exec ...` — flags, then the argv verbatim. */
  | { readonly kind: 'argv'; readonly flags: readonly string[] }
  /** `x-terminal-emulator -e "docker exec ..."` — flags, then ONE POSIX-quoted string. */
  | { readonly kind: 'command-string'; readonly flags: readonly string[] }
  /**
   * Terminal.app and iTerm2, which have no command-line interface at all.
   *
   * `dialect` because the two do not share a verb: Terminal.app takes the
   * classic `do script`, while iTerm2 3.x dropped it in favour of
   * `create window with default profile command`. A single template with the
   * app name substituted in would produce a script that compiles and does
   * nothing on one of them.
   */
  | {
      readonly kind: 'applescript';
      readonly application: string;
      readonly dialect: 'terminal-app' | 'iterm2';
    };

/**
 * Quoting a terminal applies to the arguments it is handed, beyond the shell
 * quoting the invocation already implies.
 *
 * Only Windows Terminal needs one: `wt` reads `;` as a subcommand separator, so
 * a startup command containing one would be split into two `wt` subcommands
 * rather than reaching the container.
 */
export type TerminalArgumentEscaping = 'windows-terminal';

export interface TerminalTarget {
  readonly id: TerminalId;
  readonly displayName: string;
  /**
   * Probed only on these platforms — an mdfind per Linux terminal is wasted
   * work. `HostPlatform` carries an `other` arm that no target claims, so a
   * BSD build offers no terminals at all, which is the honest answer given
   * nothing in the table has been checked there.
   */
  readonly platforms: readonly HostPlatform[];
  readonly discovery: readonly BinaryDiscovery[];
  readonly invocation: TerminalInvocation;
  readonly argumentEscaping?: TerminalArgumentEscaping;
}

export type ResolvedTerminal =
  | {
      readonly ok: true;
      readonly target: TerminalTarget;
      readonly binaryPath: string;
      readonly via: BinaryDiscovery['kind'];
    }
  | { readonly ok: false; readonly target: TerminalTarget; readonly code: 'not-found' };

/**
 * Which container CLI to shell out to.
 *
 * Not the same question as `DockerEnvironment.api.runtime`: that is what the
 * DAEMON is, this is what is installed on PATH. Podman ships a `docker` shim on
 * many distributions, and Docker Desktop users running a podman machine have
 * both — so the CLI is resolved on its own rather than inferred from the engine.
 */
export type ContainerCliKind = 'docker' | 'podman';

export interface ContainerCli {
  readonly kind: ContainerCliKind;
  /** Absolute path on the host. Ignored for the WSL transport, where the CLI is inside the distro. */
  readonly binaryPath: string;
}

/**
 * ---- Startup commands ----
 *
 * A command run inside the container before the interactive shell, each time a
 * terminal opens. Persisted, so the parsing lives here beside
 * `parseEngineSelection` and `parseProjectRoots`: the file is on disk where a
 * user, an editor, or a half-finished write can reach it, and every function
 * below is total for that reason.
 */

/**
 * Upper bound on one command, so a paste accident cannot produce a preferences
 * file that is slow to read on every launch. Generous enough for a real
 * one-liner with a long path in it.
 */
export const MAX_STARTUP_COMMAND_LENGTH = 2_000;

/**
 * Normalise a startup command, or reject it.
 *
 * `undefined` means "store nothing" — that is how the command is cleared, and
 * why a blank string is not an error.
 *
 * NUL is stripped rather than rejected because it cannot survive the journey
 * anyway: it terminates the string at the exec boundary, so a command
 * containing one would be silently truncated somewhere less visible than here.
 * Carriage returns go the same way, since the script is assembled with `\n`
 * separators and a stray `\r` reaches the container's shell as part of a
 * filename.
 *
 * Nothing else is filtered. The command is shell code by design and runs
 * inside the user's own container; containment is argv, not a denylist — see
 * `src/main/terminal/command.ts`.
 */
export function normaliseStartupCommand(value: string): string | undefined {
  const cleaned = value.replaceAll('\0', '').replaceAll('\r', '').trim();
  if (cleaned === '') return undefined;
  return cleaned.slice(0, MAX_STARTUP_COMMAND_LENGTH);
}

/**
 * Read the stored map, discarding anything unrecognised.
 *
 * Per-entry rather than all-or-nothing: one malformed command should cost the
 * user that command, not every other one in the file.
 */
export function parseStartupCommands(raw: unknown): Readonly<Record<string, string>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '' || typeof value !== 'string') continue;
    const command = normaliseStartupCommand(value);
    if (command !== undefined) out[key] = command;
  }
  return out;
}

/** Set or clear one entry, returning a new map rather than mutating. */
export function withStartupCommand(
  commands: Readonly<Record<string, string>>,
  key: string,
  command: string,
): Readonly<Record<string, string>> {
  const normalised = normaliseStartupCommand(command);
  if (normalised === undefined) {
    // Removed, not stored as '': an empty entry is indistinguishable from a
    // mistake, and the file would grow for every container the user ever typed
    // into and cleared again.
    const { [key]: _cleared, ...rest } = commands;
    return rest;
  }
  return { ...commands, [key]: normalised };
}
