import { execFile } from 'node:child_process';
import http from 'node:http';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import type {
  ClaudeStatus,
  ContainerId,
  ContainerRuntimeKind,
  DevContainer,
  DockerCliProbe,
  DockerEndpoint,
  DockerEnvironment,
  EndpointProbe,
  EngineSelection,
} from '../../models/index.js';
import {
  ALL_ENGINES,
  classifyTopFailure,
  parseClaudeProcesses,
  selectionIncludes,
} from '../../models/index.js';
import type { DockerBackend } from './backend.js';
import {
  MINIMUM_API_VERSION,
  PROBE_TIMEOUT_MS,
  apiVersionAtLeast,
  candidateEndpoints,
  classifyError,
  describeTransport,
} from './endpoint.js';
import { DEV_CONTAINER_LABEL, mapContainer, type InspectResponse } from './mapping.js';
import { detectRuntime, type VersionResponse } from './runtime.js';
import { createWslConnection, discoverWsl, invalidateWslCache } from './wsl.js';

const execFileAsync = promisify(execFile);

/**
 * docker-modem honours an `agent` option (modem.js sets `optionsf.agent` from
 * it) but @types/dockerode does not declare one, so it is added here rather
 * than reaching for `any` at the call site.
 */
type DockerOptions = Docker.DockerOptions & { agent?: http.Agent };

/**
 * GET /containers/{id}/top. @types/dockerode types `top()` as `any`, so the
 * shape is declared here — as loosely as the wire actually delivers it, since
 * the whole point of `parseClaudeProcesses` is to survive an engine that
 * answers in a layout we have not seen.
 */
interface TopResponse {
  readonly Titles?: unknown;
  readonly Processes?: unknown;
}

/**
 * Cap on how long a single `top` may take.
 *
 * Shorter than a discovery probe on purpose: this is a decoration on a card,
 * polled in the background. A container on a wedged engine should leave the
 * badge saying "could not tell" quickly rather than holding the batch open.
 */
const TOP_TIMEOUT_MS = 4_000;

/** dockerode options for a domain endpoint. */
function optionsFor(endpoint: DockerEndpoint): DockerOptions {
  const { transport } = endpoint;
  switch (transport.transport) {
    case 'unix':
      return { socketPath: transport.socketPath, timeout: PROBE_TIMEOUT_MS };
    case 'npipe':
      return { socketPath: transport.pipeName, timeout: PROBE_TIMEOUT_MS };
    case 'tcp':
      return { host: transport.host, port: transport.port, timeout: PROBE_TIMEOUT_MS };
    case 'ssh':
      return {
        protocol: 'ssh',
        host: transport.host,
        ...(transport.port === undefined ? {} : { port: transport.port }),
        ...(transport.user === undefined ? {} : { username: transport.user }),
        timeout: PROBE_TIMEOUT_MS,
      };
    case 'wsl': {
      // host/port are placeholders that only shape the request line; the agent
      // decides where the bytes actually go. No `timeout` — it would reach
      // net.Socket methods the relay duplex does not implement, so the timeout
      // for this transport is imposed by `withTimeout` below instead.
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => createWslConnection(transport.distro, transport.socketPath);
      return { protocol: 'http', host: 'localhost', port: 80, agent };
    }
  }
}

/** Reject after `ms`, so a wedged relay cannot hang discovery forever. */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'ETIMEDOUT' }),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A candidate that answered, kept open for the operational calls. */
interface Connection {
  readonly endpoint: DockerEndpoint;
  readonly docker: Docker;
}

interface Attempt {
  readonly probe: EndpointProbe;
  readonly connection: Connection | undefined;
}

/**
 * Try one endpoint. Resolves either way — the caller is building a diagnostic
 * list, so a rejection here would just have to be caught and converted back.
 *
 * The successful client is handed back rather than rebuilt from the endpoint,
 * because for a WSL endpoint rebuilding means a second http.Agent and a second
 * pool of relay processes for the same distro.
 */
async function probeEndpoint(endpoint: DockerEndpoint): Promise<Attempt> {
  const guess =
    endpoint.origin.kind === 'well-known' || endpoint.origin.kind === 'wsl'
      ? endpoint.origin.runtime
      : ('docker-engine' as ContainerRuntimeKind);

  try {
    const docker = new Docker(optionsFor(endpoint));
    const version = await withTimeout(
      docker.version() as Promise<VersionResponse>,
      PROBE_TIMEOUT_MS * 2,
      describeTransport(endpoint.transport),
    );
    const apiVersion = version.ApiVersion ?? '0';
    const serverVersion = version.Version ?? 'unknown';

    if (!apiVersionAtLeast(apiVersion, MINIMUM_API_VERSION)) {
      return {
        probe: {
          ok: false,
          endpoint,
          failure: { code: 'api-too-old', server: apiVersion, minimum: MINIMUM_API_VERSION },
        },
        connection: undefined,
      };
    }

    return {
      probe: {
        ok: true,
        endpoint,
        serverVersion,
        apiVersion,
        runtime: detectRuntime(version, guess),
      },
      connection: { endpoint, docker },
    };
  } catch (error) {
    return { probe: { ok: false, endpoint, failure: classifyError(error) }, connection: undefined };
  }
}

/**
 * `docker` on PATH is probed separately from the socket because the two fail
 * independently and gate different features — see the comment at the top of
 * src/domain/docker-endpoint.ts. Nothing in the MVP needs the CLI; it is
 * probed now so the diagnostics panel can say up front whether the
 * `@devcontainers/cli`-backed features (rebuild, create) will be available.
 */
async function probeCli(): Promise<DockerCliProbe> {
  try {
    const { stdout } = await execFileAsync('docker', ['--version'], { timeout: PROBE_TIMEOUT_MS });
    const match = /Docker version ([^,\s]+)/i.exec(stdout);
    if (match?.[1] === undefined) {
      return { ok: false, code: 'unparseable-version', detail: stdout.trim() };
    }
    return { ok: true, binaryPath: 'docker', version: match[1] };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    if (code === 'ENOENT') return { ok: false, code: 'not-on-path' };
    if (code === 'EACCES') return { ok: false, code: 'not-executable' };
    return {
      ok: false,
      code: 'not-on-path',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export class DockerodeBackend implements DockerBackend {
  /**
   * EVERY endpoint that answered, not just the first.
   *
   * This is the change that makes Windows work. A developer on Linux or macOS
   * has one engine, so "probe candidates in order, keep the winner" is right.
   * On Windows it routinely is not: a `podman machine` answers on
   * `\\.\pipe\docker_engine` while the dev containers the user actually cares
   * about live in a rootless podman inside a WSL distro. Stopping at the first
   * success picks the pipe, finds nothing carrying the dev-container label, and
   * reports an empty list on a machine with containers running — the failure
   * that is hardest to debug, because nothing looks broken.
   *
   * Invalidated on any operational failure, so pulling a socket out from under
   * a running app recovers on the next refresh rather than wedging.
   */
  #connections: readonly Connection[] | undefined;

  /**
   * Which engine each container came from, so start/stop go back to the daemon
   * that owns the container instead of guessing. Populated by listDevContainers.
   */
  readonly #ownerById = new Map<ContainerId, Docker>();

  /**
   * The same mapping as `#ownerById`, but as the domain endpoint rather than
   * the dockerode handle. Kept alongside instead of derived from it because a
   * `Docker` instance does not carry the endpoint it was built from — the
   * transport arm (a WSL socket in particular) is the thing the terminal
   * launcher needs, and it only exists on this side.
   */
  readonly #endpointById = new Map<ContainerId, DockerEndpoint>();

  /** Defaults to the union of every reachable engine; see src/domain/engine.ts. */
  #selection: EngineSelection = ALL_ENGINES;

  selection(): EngineSelection {
    return this.#selection;
  }

  select(selection: EngineSelection): void {
    this.#selection = selection;
    // The container-to-daemon map was built under the old selection, and
    // start/stop read it. Dropping it forces the next action to re-derive the
    // owner from a list the user could actually see.
    this.#invalidate();
  }

  async probe(): Promise<DockerEnvironment> {
    // Off Windows this resolves to not-applicable without spawning anything.
    const wsl = await discoverWsl();
    const candidates = candidateEndpoints(platform(), homedir(), process.env, wsl.sockets);

    // EVERY candidate is probed, including ones the current selection excludes.
    // That is the point: the picker can only offer engines that were tried, so
    // narrowing the probe to the selected engine would make the selection
    // impossible to change once made.
    const results = await Promise.all(candidates.map(probeEndpoint));

    const attempts = results.map((result) => result.probe);
    const connections = results
      .map((result) => result.connection)
      .filter((connection): connection is Connection => connection !== undefined);

    this.#connections = connections;
    this.#ownerById.clear();
    this.#endpointById.clear();

    const cli = await probeCli();

    // The headline. The SELECTED engine when it answered, so the header chip
    // agrees with the list below it; otherwise the first success in candidate
    // order; otherwise the FIRST failure, which is the highest-priority
    // candidate — DOCKER_HOST when set, else the platform's usual socket — and
    // so the one the user most likely meant.
    const selected = attempts.find(
      (attempt) => attempt.ok && selectionIncludes(this.#selection, attempt.endpoint.transport),
    );
    const api: EndpointProbe = selected ??
      attempts.find((attempt) => attempt.ok) ??
      attempts[0] ?? {
        ok: false,
        endpoint: {
          transport: { transport: 'unix', socketPath: '(none)' },
          origin: { kind: 'manual' },
        },
        failure: { code: 'not-present', detail: 'No candidate endpoints for this platform.' },
      };

    return { api, cli, attempts, wsl: wsl.status };
  }

  /**
   * The connections in scope for the current selection.
   *
   * A selection naming an engine that did not answer yields an EMPTY list, and
   * that resolves to "no dev containers" rather than an error. That is the
   * honest reading — the user asked for one engine and it has nothing to show —
   * and the `selected-engine-unreachable` advisory is what explains it. Falling
   * back to the other engines here would silently ignore the setting.
   */
  async #ensureConnections(): Promise<readonly Connection[]> {
    const cached = this.#connections;
    if (cached !== undefined && cached.length > 0) return this.#inScope(cached);

    await this.probe();

    // Re-read into a local rather than touching this.#connections directly:
    // TypeScript's narrowing does not know that probe() reassigns the field.
    const connections = this.#connections;
    if (connections === undefined || connections.length === 0) {
      throw new Error('No reachable Docker daemon.');
    }
    return this.#inScope(connections);
  }

  #inScope(connections: readonly Connection[]): readonly Connection[] {
    return connections.filter((connection) =>
      selectionIncludes(this.#selection, connection.endpoint.transport),
    );
  }

  /** Any operational failure drops the cached handles so the next call re-probes. */
  #invalidate(): void {
    this.#connections = undefined;
    this.#ownerById.clear();
    this.#endpointById.clear();
    // And the WSL reading, which is cached for 30s so the five-second poll does
    // not spawn wsl.exe six times a minute forever. That cache is right for a
    // machine that is working and wrong for one that has just stopped: if a
    // relay died, its socket is still in the cached reading and every call
    // would keep failing against it until the TTL expired. Clearing it here
    // puts recovery back on the poll's cadence rather than the cache's — the
    // expensive discovery is skipped while nothing is wrong, and re-run the
    // moment something is.
    invalidateWslCache();
  }

  async #listFrom(connection: Connection): Promise<readonly DevContainer[]> {
    const { docker } = connection;

    // Filter server-side on label EXISTENCE. A developer's daemon may hold
    // hundreds of containers; inspecting all of them to find four dev
    // containers would make refresh visibly slow for no benefit.
    const summaries = await docker.listContainers({
      all: true,
      filters: { label: [DEV_CONTAINER_LABEL] },
    });

    // The summary from listContainers lacks StartedAt, ExitCode and Health,
    // all of which the domain's runtime union requires. Inspecting each hit
    // is the cost of not having to model those as optional everywhere.
    const inspected = await Promise.all(
      summaries.map(async (summary) => {
        try {
          return (await docker.getContainer(summary.Id).inspect()) as unknown as InspectResponse;
        } catch {
          // Raced with a `docker rm`. Dropping this one container is right;
          // failing the whole refresh is not.
          return undefined;
        }
      }),
    );

    const containers = inspected
      .filter((value): value is InspectResponse => value !== undefined)
      .map(mapContainer)
      .filter((value): value is DevContainer => value !== undefined);

    for (const container of containers) {
      this.#ownerById.set(container.id, docker);
      this.#endpointById.set(container.id, connection.endpoint);
    }
    return containers;
  }

  async listDevContainers(): Promise<readonly DevContainer[]> {
    const connections = await this.#ensureConnections();
    const results = await Promise.allSettled(
      connections.map((connection) => this.#listFrom(connection)),
    );

    const failures = results.filter((result) => result.status === 'rejected');

    // All of them failed: that is a connectivity problem, and it has to reach
    // the UI as one. Returning [] here would render as "no dev containers" and
    // send the user looking in entirely the wrong place.
    if (failures.length === results.length && results.length > 0) {
      this.#invalidate();
      const first = failures[0];
      throw first?.reason instanceof Error ? first.reason : new Error('Failed to list containers.');
    }

    // Some failed. Report them and keep going — one flaky engine should not
    // blank out the containers belonging to the others.
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue;
      const endpoint = connections[index]?.endpoint;
      const target = endpoint === undefined ? 'an endpoint' : describeTransport(endpoint.transport);
      console.warn(`[boxwarden] Listing containers from ${target} failed:`, result.reason);
    }

    // Deduplicated by container id, because the same engine can legitimately be
    // reachable twice — Podman on Windows answers on both `docker_engine` and
    // `podman-machine-default`, and Docker Desktop on both `docker_engine` and
    // `dockerDesktopLinuxEngine`. Ids are engine-unique, so this collapses the
    // duplicates without having to identify the engine itself.
    const byId = new Map<ContainerId, DevContainer>();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const container of result.value) {
        if (!byId.has(container.id)) byId.set(container.id, container);
      }
    }

    return [...byId.values()].sort(byRunningThenName);
  }

  /**
   * The daemon holding a given container.
   *
   * A cache miss is not an error: the renderer can act on a container from a
   * scan older than the last invalidation. Re-listing repopulates the map, and
   * only then is an unknown id genuinely unknown.
   */
  async #ownerOf(id: ContainerId): Promise<Docker> {
    const cached = this.#ownerById.get(id);
    if (cached !== undefined) return cached;

    await this.listDevContainers();

    const refreshed = this.#ownerById.get(id);
    if (refreshed === undefined) {
      throw new Error('That container is no longer on any reachable daemon.');
    }
    return refreshed;
  }

  async start(id: ContainerId): Promise<void> {
    const docker = await this.#ownerOf(id);
    try {
      await docker.getContainer(id).start();
    } catch (error) {
      this.#invalidate();
      throw error;
    }
  }

  async stop(id: ContainerId): Promise<void> {
    const docker = await this.#ownerOf(id);
    try {
      await docker.getContainer(id).stop();
    } catch (error) {
      this.#invalidate();
      throw error;
    }
  }

  /**
   * Synchronous and best-effort, unlike `#ownerOf`: a miss must not trigger a
   * re-list. The caller is building a command line, and the honest answer to
   * "which daemon owns this" being unknown is to omit the flag and let the CLI
   * decide, not to make the user wait on a scan to find out.
   */
  endpointFor(id: ContainerId): DockerEndpoint | undefined {
    return this.#endpointById.get(id);
  }

  /**
   * The impure shell around `parseClaudeProcesses`, in the same shape as
   * `inspect` -> `mapContainer`: make the call, hand the raw rows to the pure
   * function, keep no logic here.
   *
   * Notably this does NOT call `#invalidate()` when a `top` fails, unlike
   * start and stop. A `top` against a container that stopped a moment ago
   * fails as a matter of course; throwing away every engine handle over it
   * would make a background poll re-probe all the sockets on a schedule.
   */
  async claudeStatus(ids: readonly ContainerId[]): Promise<ReadonlyMap<ContainerId, ClaudeStatus>> {
    const statuses = new Map<ContainerId, ClaudeStatus>();
    if (ids.length === 0) return statuses;

    // Concurrent: the calls are independent, and in series the whole batch
    // would cost the slowest container's round trip times the list length.
    const results = await Promise.all(
      ids.map(async (id): Promise<readonly [ContainerId, ClaudeStatus]> => {
        try {
          const docker = await this.#ownerOf(id);
          const response = (await withTimeout(
            docker.getContainer(id).top() as Promise<TopResponse>,
            TOP_TIMEOUT_MS,
            'Reading the container process table',
          )) as TopResponse | undefined;
          return [id, parseClaudeProcesses(response?.Titles, response?.Processes)];
        } catch (error) {
          return [id, classifyTopFailure(error instanceof Error ? error.message : String(error))];
        }
      }),
    );

    for (const [id, status] of results) statuses.set(id, status);
    return statuses;
  }
}

/** Running first, then alphabetical — the list's default order. */
function byRunningThenName(a: DevContainer, b: DevContainer): number {
  const rank = (c: DevContainer) => (c.runtime.state === 'running' ? 0 : 1);
  const delta = rank(a) - rank(b);
  return delta !== 0 ? delta : a.name.localeCompare(b.name);
}
