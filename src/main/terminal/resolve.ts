import { platform } from 'node:os';
import type {
  ContainerCli,
  ContainerCliKind,
  ResolvedTerminal,
  TerminalTarget,
} from '../../models/index.js';
import { resolveBinary } from '../discovery/resolve.js';

/**
 * Terminal emulators and the container CLI, located on this machine.
 *
 * Two separate questions with a shared mechanism: the emulator is what opens a
 * window, and the CLI is what runs inside it. They fail independently and the
 * UI has to say which one is missing — "no terminal emulator found" and "docker
 * is not on PATH" send the user to entirely different places.
 *
 * Which platform we are on is NOT asked here: `hostPlatform` already exists in
 * `src/models/advice.ts`, is already how the main process narrows
 * `process.platform`, and a second one would be a second thing to keep in step.
 */

export async function resolveTerminal(
  target: TerminalTarget,
  os: NodeJS.Platform = platform(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedTerminal> {
  const found = await resolveBinary(target.discovery, os, env);
  return found.ok
    ? { ok: true, target, binaryPath: found.binaryPath, via: found.via }
    : { ok: false, target, code: 'not-found' };
}

/**
 * Order matters and is not the same as the daemon's identity.
 *
 * `docker` first because Podman installs commonly provide a `docker` shim, and
 * on those the shim is the interface the user's muscle memory already uses.
 * When it is genuinely absent, `podman` is the only other CLI this app knows
 * how to pass a daemon URL to.
 */
const CLI_ORDER: readonly ContainerCliKind[] = ['docker', 'podman'];

export async function resolveContainerCli(
  os: NodeJS.Platform = platform(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ContainerCli | undefined> {
  for (const kind of CLI_ORDER) {
    const found = await resolveBinary([{ kind: 'path-lookup', command: kind }], os, env);
    if (found.ok) return { kind, binaryPath: found.binaryPath };
  }
  return undefined;
}
