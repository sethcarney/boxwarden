import type {
  ContainerId,
  DevContainer,
  DockerEndpoint,
  DockerEnvironment,
  EndpointProbe,
  EngineSelection,
} from '../../models/index.js';
import { ALL_ENGINES, engineIdFor, selectionIncludes } from '../../models/index.js';
import type { DockerBackend } from './backend.js';
import { mapContainer, type InspectResponse, type InspectState } from './mapping.js';

/**
 * A backend that serves fixtures instead of talking to a daemon.
 *
 * Enabled with BOXWARDEN_FAKE_DOCKER=1. Two reasons it exists:
 *
 *   1. The UI can be built and demonstrated on a machine with no Docker — and
 *      more to the point, on a machine where Docker is *broken*, which is
 *      exactly when someone is most likely to be looking at this app.
 *   2. The fixtures are real inspect payloads run through the real
 *      `mapContainer`, so the awkward cases have somewhere permanent to live:
 *      an unparseable host path, a container with no workspace folder, a
 *      Windows path, a compose-managed container. Those are the rows most
 *      likely to render badly and least likely to exist on the developer's
 *      own machine.
 *
 * This is a development aid, not a demo mode: it is never reachable in a
 * packaged build unless the variable is set deliberately.
 */

const HOUR = 60 * 60 * 1000;

function fixtures(now: number): InspectResponse[] {
  return [
    {
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000001',
      Name: '/vsc-webapp-9f2c1a-uid',
      Created: new Date(now - 26 * HOUR).toISOString(),
      State: {
        Status: 'running',
        StartedAt: new Date(now - 3 * HOUR).toISOString(),
        Health: { Status: 'healthy' },
      },
      Config: {
        Image: 'vsc-webapp-9f2c1a-features',
        WorkingDir: '/workspaces/webapp',
        Labels: {
          'devcontainer.local_folder': '/home/dev/code/webapp',
          'devcontainer.config_file': '/home/dev/code/webapp/.devcontainer/devcontainer.json',
        },
        // A working agent, the Docker Desktop way. The decoy variables beside
        // it are the point of the fixture as much as the socket is: this is
        // the shape of a real environment block, and only SSH_AUTH_SOCK may
        // survive `mapContainer`.
        Env: [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'NODE_ENV=development',
          'DATABASE_URL=postgres://app:not-a-real-password@db:5432/app',
          'SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock',
        ],
      },
      Mounts: [
        { Source: '/home/dev/code/webapp', Destination: '/workspaces/webapp' },
        {
          Source: '/run/host-services/ssh-auth.sock',
          Destination: '/run/host-services/ssh-auth.sock',
        },
      ],
      NetworkSettings: {
        Ports: {
          '5173/tcp': [{ HostIp: '0.0.0.0', HostPort: '5173' }],
          '9229/tcp': null,
        },
      },
    },
    {
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000002',
      Name: '/vsc-api-service-3d8e77-uid',
      Created: new Date(now - 5 * 24 * HOUR).toISOString(),
      State: {
        Status: 'exited',
        ExitCode: 0,
        StartedAt: new Date(now - 30 * HOUR).toISOString(),
        FinishedAt: new Date(now - 28 * HOUR).toISOString(),
      },
      Config: {
        Image: 'mcr.microsoft.com/devcontainers/go:1.24',
        WorkingDir: '/workspaces/api-service',
        Labels: { 'devcontainer.local_folder': '/home/dev/code/api-service' },
      },
    },
    {
      // Compose-managed, and the whole point of carrying composeProject in the
      // domain: stopping this one leaves its database sibling running.
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000003',
      Name: '/platform_devcontainer-app-1',
      Created: new Date(now - 9 * HOUR).toISOString(),
      State: { Status: 'running', StartedAt: new Date(now - 9 * HOUR).toISOString() },
      Config: {
        Image: 'platform_devcontainer-app',
        WorkingDir: '/workspaces/platform',
        Labels: {
          'devcontainer.local_folder': '/home/dev/code/platform',
          'com.docker.compose.project': 'platform_devcontainer',
        },
        // The silent failure, and the reason this feature exists: the compose
        // file exports SSH_AUTH_SOCK and forgets the matching volume, so the
        // container looks configured to every check a user knows how to make
        // and `git push` fails. Left in the compose group on purpose — that is
        // where the mistake is easiest to make and hardest to spot.
        Env: ['SSH_AUTH_SOCK=/ssh-agent', 'POSTGRES_HOST=db'],
      },
      Mounts: [{ Source: '/home/dev/code/platform', Destination: '/workspaces/platform' }],
      NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } },
    },
    {
      // Windows host path, and no WorkingDir — exercises the
      // /workspaces/<basename> fallback and the backslash-aware basename.
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000004',
      Name: '/vsc-reporting-tool-be41c9-uid',
      Created: new Date(now - 2 * HOUR).toISOString(),
      State: { Status: 'running', StartedAt: new Date(now - 2 * HOUR).toISOString() },
      Config: {
        Image: 'vsc-reporting-tool-be41c9',
        Labels: { 'devcontainer.local_folder': 'C:\\Users\\dev\\code\\reporting-tool' },
      },
    },
    {
      // Unparseable label. The row must still render, greyed, showing the raw
      // value — a container that silently vanishes from the list is a bug
      // report nobody can act on.
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000005',
      Name: '/vsc-legacy-thing-77aa20-uid',
      Created: new Date(now - 40 * 24 * HOUR).toISOString(),
      State: {
        Status: 'exited',
        ExitCode: 137,
        FinishedAt: new Date(now - 12 * HOUR).toISOString(),
      },
      Config: {
        Image: 'vsc-legacy-thing-77aa20',
        Labels: { 'devcontainer.local_folder': 'relative/not/absolute' },
      },
    },
    {
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000006',
      Name: '/vsc-infra-scripts-01fe3b-uid',
      Created: new Date(now - 3 * 24 * HOUR).toISOString(),
      State: { Status: 'paused', StartedAt: new Date(now - 20 * HOUR).toISOString() },
      Config: {
        Image: 'mcr.microsoft.com/devcontainers/base:trixie',
        WorkingDir: '/workspaces/infra-scripts',
        // The AMBIGUOUS spelling on purpose: a bare POSIX label that is
        // actually inside a WSL distro. VS Code running in WSL writes it this
        // way, indistinguishable from a native Linux path. Only the mount
        // below reveals the distro — this fixture is what exercises that.
        Labels: { 'devcontainer.local_folder': '/home/dev/infra-scripts' },
      },
      Mounts: [
        { Source: '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/01fe3b' },
        { Source: '/var/run/docker.sock' },
      ],
    },
    {
      // Second member of the compose project above. Its whole reason for
      // existing is to make the grouping visible: stopping `platform` without
      // this one would leave the database running.
      Id: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000007',
      Name: '/platform_devcontainer-db-1',
      Created: new Date(now - 9 * HOUR).toISOString(),
      State: { Status: 'running', StartedAt: new Date(now - 9 * HOUR).toISOString() },
      Config: {
        Image: 'postgres:17',
        Labels: {
          'devcontainer.local_folder': '/home/dev/code/platform',
          'com.docker.compose.project': 'platform_devcontainer',
        },
      },
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] } },
    },
  ];
}

/**
 * THREE engines, not one — and one WSL distro that is missing socat.
 *
 * The fake used to report a single reachable daemon, which meant the engine
 * picker and every WSL advisory were unreachable without a Windows machine in a
 * broken state. Since those are exactly the screens that have to be right for a
 * user whose setup does not work, the fixture now presents the awkward
 * arrangement rather than the tidy one: a Docker Desktop pipe, a podman machine,
 * and a distro holding containers boxwarden cannot see.
 */
const DOCKER_ENDPOINT: DockerEndpoint = {
  transport: { transport: 'unix', socketPath: '/var/run/docker.sock (fake)' },
  origin: { kind: 'manual', label: 'BOXWARDEN_FAKE_DOCKER' },
};

const PODMAN_MACHINE_ENDPOINT: DockerEndpoint = {
  transport: { transport: 'npipe', pipeName: '//./pipe/podman-machine-default (fake)' },
  origin: { kind: 'well-known', runtime: 'podman' },
};

const WSL_ENDPOINT: DockerEndpoint = {
  transport: { transport: 'wsl', distro: 'dev', socketPath: '/run/user/1000/podman/podman.sock' },
  origin: { kind: 'wsl', distro: 'dev', runtime: 'podman' },
};

const FAKE_ENDPOINTS: readonly DockerEndpoint[] = [
  DOCKER_ENDPOINT,
  PODMAN_MACHINE_ENDPOINT,
  WSL_ENDPOINT,
];

const FAKE_PROBES: readonly EndpointProbe[] = [
  {
    ok: true,
    endpoint: DOCKER_ENDPOINT,
    serverVersion: '29.3.1 (fake)',
    apiVersion: '1.51',
    runtime: 'docker-engine',
  },
  {
    ok: true,
    endpoint: PODMAN_MACHINE_ENDPOINT,
    serverVersion: '5.7.0 (fake)',
    apiVersion: '1.44',
    runtime: 'podman',
  },
  {
    ok: true,
    endpoint: WSL_ENDPOINT,
    serverVersion: '5.7.0 (fake)',
    apiVersion: '1.44',
    runtime: 'podman',
  },
];

export class FakeDockerBackend implements DockerBackend {
  #containers: InspectResponse[];
  #selection: EngineSelection = ALL_ENGINES;

  constructor(now: number = Date.now()) {
    this.#containers = fixtures(now);
  }

  selection(): EngineSelection {
    return this.#selection;
  }

  select(selection: EngineSelection): void {
    this.#selection = selection;
  }

  probe(): Promise<DockerEnvironment> {
    const selected = FAKE_PROBES.find((probe) =>
      selectionIncludes(this.#selection, probe.endpoint.transport),
    );
    const api: EndpointProbe = selected ?? {
      ok: true,
      endpoint: DOCKER_ENDPOINT,
      serverVersion: '29.3.1 (fake)',
      apiVersion: '1.51',
      runtime: 'docker-engine',
    };

    return Promise.resolve({
      api,
      cli: { ok: true, binaryPath: '/usr/bin/docker (fake)', version: '29.3.1' },
      attempts: FAKE_PROBES,
      // A distro with podman in it and no relay — the case that renders as a
      // silently short container list on a real machine.
      wsl: {
        kind: 'ready',
        distros: [
          {
            distro: 'dev',
            hasSocat: true,
            hasPodman: true,
            socketPath: '/run/user/1000/podman/podman.sock',
          },
          { distro: 'legacy-ubuntu', hasSocat: false, hasPodman: true },
        ],
      },
    });
  }

  listDevContainers(): Promise<readonly DevContainer[]> {
    const mapped = this.#containers
      // Round-robin across the fake engines, so switching the picker visibly
      // changes the list instead of being a setting with no observable effect.
      .filter((_container, index) => {
        const endpoint = FAKE_ENDPOINTS[index % FAKE_ENDPOINTS.length];
        return endpoint !== undefined && selectionIncludes(this.#selection, endpoint.transport);
      })
      .map(mapContainer)
      .filter((value): value is DevContainer => value !== undefined)
      .sort((a, b) => {
        const rank = (c: DevContainer) => (c.runtime.state === 'running' ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
    return Promise.resolve(mapped);
  }

  /** The ids the picker offers, for anyone reading this fixture to write a test. */
  static engineIds(): readonly string[] {
    return FAKE_ENDPOINTS.map((endpoint) => engineIdFor(endpoint.transport));
  }

  /**
   * The same round-robin `listDevContainers` filters by, so a fixture container
   * reports the engine it appears to have come from.
   *
   * Worth mirroring rather than always answering DOCKER_ENDPOINT: it puts a
   * `wsl.exe -d dev --` command line in front of anyone running the fake on
   * Linux, which is the arm of `containerExecArgv` least likely to be looked at
   * otherwise. The socket paths say "(fake)" out loud for the same reason they
   * do above — that string reaches the command line the terminal shows.
   */
  endpointFor(id: ContainerId): DockerEndpoint | undefined {
    const index = this.#containers.findIndex((container) => container.Id === id);
    return index === -1 ? undefined : FAKE_ENDPOINTS[index % FAKE_ENDPOINTS.length];
  }

  /** Mutates the fixture so the UI's optimistic update has something real to land on. */
  start(id: ContainerId): Promise<void> {
    return this.#transition(id, {
      Status: 'running',
      StartedAt: new Date().toISOString(),
    });
  }

  stop(id: ContainerId): Promise<void> {
    return this.#transition(id, {
      Status: 'exited',
      ExitCode: 0,
      FinishedAt: new Date().toISOString(),
    });
  }

  #transition(id: ContainerId, state: InspectState): Promise<void> {
    const index = this.#containers.findIndex((c) => c.Id === id);
    if (index === -1) return Promise.reject(new Error(`No such container: ${id}`));
    const existing = this.#containers[index];
    if (existing === undefined) return Promise.reject(new Error(`No such container: ${id}`));
    this.#containers[index] = { ...existing, State: state };
    return Promise.resolve();
  }
}
