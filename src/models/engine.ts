import type {
  ContainerRuntimeKind,
  DockerEndpoint,
  DockerEnvironment,
  DockerTransport,
} from './docker-endpoint.js';

/**
 * Which engine boxwarden talks to, when more than one answers.
 *
 * Discovery connects to EVERY reachable engine and unions their container
 * lists, which is the right default — a Windows machine routinely has a podman
 * machine behind a named pipe and a rootless podman inside a WSL distro, and
 * the user thinks of those as "my dev containers", not as two inventories.
 *
 * It is the wrong default often enough to need an override. Docker Desktop and
 * Podman both installed means the same project can exist twice under different
 * ids; a corporate machine can have an engine the user is not supposed to touch;
 * and when something is wrong, narrowing to one engine is the fastest way to
 * find out which one. So the union is a default, not a law.
 */

/**
 * Stable identity for an endpoint, across probes.
 *
 * Derived from the transport rather than assigned, because there is nowhere to
 * persist an assigned id between runs and the transport is what the user's
 * selection actually means. Deliberately NOT the runtime kind: a machine can
 * run two Docker Engines, and "docker-engine" would then name both.
 */
export type EngineId = string & { readonly __brand: 'EngineId' };

/**
 * The canonical form of an endpoint.
 *
 * Not `describeTransport` — that one is prose for the diagnostics panel and is
 * free to change wording. This is a key that gets written to disk in the user's
 * preferences, so it has to survive a reword of the UI. Keeping the two
 * separate is the only thing stopping a copy-editing pass from silently
 * resetting everyone's engine choice.
 */
export function engineIdFor(transport: DockerTransport): EngineId {
  switch (transport.transport) {
    case 'unix':
      return `unix:${transport.socketPath}` as EngineId;
    case 'npipe':
      return `npipe:${transport.pipeName}` as EngineId;
    case 'tcp':
      return `tcp:${transport.host}:${String(transport.port)}` as EngineId;
    case 'ssh':
      return `ssh:${transport.user ?? ''}@${transport.host}:${
        transport.port === undefined ? '' : String(transport.port)
      }` as EngineId;
    case 'wsl':
      return `wsl:${transport.distro}:${transport.socketPath}` as EngineId;
  }
}

export type EngineSelection =
  /** Union every engine that answers. The default. */
  | { readonly kind: 'all' }
  /** Only this one, even if others are reachable. */
  | { readonly kind: 'only'; readonly id: EngineId };

export const ALL_ENGINES: EngineSelection = { kind: 'all' };

/**
 * One reachable engine, as the picker shows it.
 *
 * `runtime` comes from the daemon's own /version response rather than from the
 * socket path — see src/main/docker/runtime.ts for why the two disagree.
 */
export interface EngineSummary {
  readonly id: EngineId;
  readonly runtime: ContainerRuntimeKind;
  readonly serverVersion: string;
  readonly transport: DockerTransport;
  readonly origin: DockerEndpoint['origin'];
}

/** Every engine that answered, in probe order. */
export function enginesFrom(environment: DockerEnvironment): readonly EngineSummary[] {
  const seen = new Set<string>();
  const engines: EngineSummary[] = [];

  for (const attempt of environment.attempts) {
    if (!attempt.ok) continue;
    const id = engineIdFor(attempt.endpoint.transport);
    // The same endpoint cannot legitimately appear twice, but two endpoints
    // reaching one engine can (Docker Desktop answers on both `docker_engine`
    // and `dockerDesktopLinuxEngine`). Those stay separate rows on purpose:
    // they are genuinely different ways in, and if one breaks the user needs to
    // be able to pick the other.
    if (seen.has(id)) continue;
    seen.add(id);
    engines.push({
      id,
      runtime: attempt.runtime,
      serverVersion: attempt.serverVersion,
      transport: attempt.endpoint.transport,
      origin: attempt.endpoint.origin,
    });
  }

  return engines;
}

/** Whether an endpoint is in scope under this selection. */
export function selectionIncludes(selection: EngineSelection, transport: DockerTransport): boolean {
  return selection.kind === 'all' || selection.id === engineIdFor(transport);
}

/**
 * Read a selection back off disk.
 *
 * Returns `all` for anything unrecognised rather than throwing. A preferences
 * file that has been hand-edited, truncated by a crash, or written by a future
 * version should cost the user their engine choice, not their app — falling
 * back to the default is both recoverable and self-explaining, because the
 * picker visibly reads "All engines".
 */
export function parseEngineSelection(value: unknown): EngineSelection {
  if (typeof value !== 'object' || value === null) return ALL_ENGINES;
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'only') return ALL_ENGINES;
  const id = record['id'];
  if (typeof id !== 'string' || id === '') return ALL_ENGINES;
  return { kind: 'only', id: id as EngineId };
}

/**
 * Narrow a selection to what is actually reachable.
 *
 * A selected engine that has since gone away is NOT silently downgraded to
 * `all` here — the caller needs to know the difference so it can say "the
 * engine you picked is not answering" instead of quietly showing containers
 * from somewhere else. This only reports; it does not decide.
 */
export function selectionIsReachable(
  selection: EngineSelection,
  engines: readonly EngineSummary[],
): boolean {
  return selection.kind === 'all' || engines.some((engine) => engine.id === selection.id);
}
