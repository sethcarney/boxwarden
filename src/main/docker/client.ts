import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import type {
  ContainerId,
  DevContainer,
  DockerCliProbe,
  DockerEndpoint,
  DockerEnvironment,
  EndpointProbe,
} from '../../domain/index.js';
import type { DockerBackend } from './backend.js';
import {
  MINIMUM_API_VERSION,
  PROBE_TIMEOUT_MS,
  apiVersionAtLeast,
  candidateEndpoints,
  classifyError,
} from './endpoint.js';
import { DEV_CONTAINER_LABEL, mapContainer, type InspectResponse } from './mapping.js';

const execFileAsync = promisify(execFile);

/** dockerode options for a domain endpoint. */
function optionsFor(endpoint: DockerEndpoint): Docker.DockerOptions {
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
  }
}

/**
 * Try one endpoint. Resolves either way — the caller is building a diagnostic
 * list, so a rejection here would just have to be caught and converted back.
 */
async function probeEndpoint(endpoint: DockerEndpoint): Promise<EndpointProbe> {
  try {
    const docker = new Docker(optionsFor(endpoint));
    const version = (await docker.version()) as { ApiVersion?: string; Version?: string };
    const apiVersion = version.ApiVersion ?? '0';
    const serverVersion = version.Version ?? 'unknown';

    if (!apiVersionAtLeast(apiVersion, MINIMUM_API_VERSION)) {
      return {
        ok: false,
        endpoint,
        failure: { code: 'api-too-old', server: apiVersion, minimum: MINIMUM_API_VERSION },
      };
    }

    return { ok: true, endpoint, serverVersion, apiVersion };
  } catch (error) {
    return { ok: false, endpoint, failure: classifyError(error) };
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
        ? String((error as { code: unknown }).code)
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
   * Cached so that list/start/stop do not re-probe every candidate on each
   * call. Invalidated on any operational failure, so pulling the socket out
   * from under a running app recovers on the next refresh rather than wedging
   * on a dead handle.
   */
  #connected: { docker: Docker; probe: EndpointProbe } | undefined;

  async probe(): Promise<DockerEnvironment> {
    const attempts: EndpointProbe[] = [];
    let connected: { docker: Docker; probe: EndpointProbe } | undefined;

    for (const endpoint of candidateEndpoints()) {
      const probe = await probeEndpoint(endpoint);
      attempts.push(probe);
      if (probe.ok) {
        connected = { docker: new Docker(optionsFor(endpoint)), probe };
        break;
      }
    }

    this.#connected = connected;
    const cli = await probeCli();

    // When nothing connected, report the FIRST failure as the headline. It is
    // the highest-priority candidate — DOCKER_HOST when set, otherwise the
    // platform's usual socket — so it is the one the user most likely meant.
    const api: EndpointProbe = connected?.probe ??
      attempts[0] ?? {
        ok: false,
        endpoint: { transport: { transport: 'unix', socketPath: '(none)' }, origin: { kind: 'manual' } },
        failure: { code: 'not-present', detail: 'No candidate endpoints for this platform.' },
      };

    return { api, cli, attempts };
  }

  async #docker(): Promise<Docker> {
    const cached = this.#connected;
    if (cached !== undefined) return cached.docker;

    await this.probe();

    // Re-read into a local rather than touching this.#connected directly:
    // TypeScript's narrowing does not know that probe() reassigns the field,
    // so the field still reads as `undefined` here from the check above.
    const connected = this.#connected;
    if (connected === undefined) {
      throw new Error('No reachable Docker daemon.');
    }
    return connected.docker;
  }

  /** Any operational failure drops the cached handle so the next call re-probes. */
  #invalidate(): void {
    this.#connected = undefined;
  }

  async listDevContainers(): Promise<readonly DevContainer[]> {
    const docker = await this.#docker();
    try {
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

      return inspected
        .filter((value): value is InspectResponse => value !== undefined)
        .map(mapContainer)
        .filter((value): value is DevContainer => value !== undefined)
        .sort(byRunningThenName);
    } catch (error) {
      this.#invalidate();
      throw error;
    }
  }

  async start(id: ContainerId): Promise<void> {
    const docker = await this.#docker();
    try {
      await docker.getContainer(id).start();
    } catch (error) {
      this.#invalidate();
      throw error;
    }
  }

  async stop(id: ContainerId): Promise<void> {
    const docker = await this.#docker();
    try {
      await docker.getContainer(id).stop();
    } catch (error) {
      this.#invalidate();
      throw error;
    }
  }
}

/** Running first, then alphabetical — the list's default order. */
function byRunningThenName(a: DevContainer, b: DevContainer): number {
  const rank = (c: DevContainer) => (c.runtime.state === 'running' ? 0 : 1);
  const delta = rank(a) - rank(b);
  return delta !== 0 ? delta : a.name.localeCompare(b.name);
}
