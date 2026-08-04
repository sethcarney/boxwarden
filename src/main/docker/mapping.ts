import type {
  ContainerPath,
  DevContainer,
  DevContainerLabels,
  DevContainerRuntime,
  Health,
  MaybeHostPath,
  PortBinding,
} from '../../models/index.js';
import { asContainerId, asContainerPath, sshAgentState } from '../../models/index.js';
import { parseLocalFolder, withWslDistro, wslDistroFromMountSources } from './host-path.js';

/**
 * Docker inspect JSON -> DevContainer. Pure, and typed against a structural
 * subset of the response rather than dockerode's own types.
 *
 * That indirection earns its keep twice: the tests can build a fixture from a
 * literal without constructing a full `ContainerInspectInfo`, and the fields
 * this app actually depends on are listed in one place instead of being
 * implied by scattered property accesses.
 */

export interface InspectState {
  readonly Status?: string;
  readonly ExitCode?: number;
  readonly StartedAt?: string;
  readonly FinishedAt?: string;
  readonly Health?: { readonly Status?: string };
}

export interface InspectPortBinding {
  readonly HostIp?: string;
  readonly HostPort?: string;
}

/**
 * Two fields, each read for exactly one thing.
 *
 * `Source` recovers a WSL distro name — see `wslDistroFromMountSources`.
 * `Destination` answers whether the SSH agent socket a container claims to
 * have is actually mounted there — see `sshAgentState`.
 *
 * The rest of the mount record stays unmodelled, and the reason is unchanged
 * from when this listed only `Source`: nothing in the app needs it, and a
 * field named here implies a dependency that does not exist. `Type` is the one
 * most obviously missing, and deliberately so — a socket arriving as a bind, a
 * volume, or anything else is forwarded just the same, so branching on it
 * would only add a way to be wrong.
 */
export interface InspectMount {
  readonly Source?: string;
  readonly Destination?: string;
}

export interface InspectResponse {
  readonly Id: string;
  readonly Name?: string;
  readonly Created?: string;
  readonly State?: InspectState;
  readonly Config?: {
    readonly Image?: string;
    readonly WorkingDir?: string;
    /** The image's configured user. `resolveRemoteUser` reads it as a last resort. */
    readonly User?: string;
    readonly Labels?: Readonly<Record<string, string>>;
    /**
     * `KEY=VALUE` strings — and the most sensitive thing this app ever holds.
     *
     * A container's environment routinely carries registry credentials,
     * database passwords, and API tokens that were never meant to leave the
     * daemon. Exactly ONE variable is read from it (`SSH_AUTH_SOCK`, in
     * `mapContainer` below) and the array is then dropped; it must never reach
     * `DevContainer`, cross IPC to the renderer, be written to a snapshot, or
     * appear in a log line. `mapContainer does not carry any environment
     * variable other than SSH_AUTH_SOCK` in mapping.test.ts is what keeps that
     * true.
     */
    readonly Env?: readonly string[];
  };
  readonly NetworkSettings?: {
    readonly Ports?: Readonly<Record<string, readonly InspectPortBinding[] | null>>;
  };
  readonly Mounts?: readonly InspectMount[];
}

export const DEV_CONTAINER_LABEL = 'devcontainer.local_folder';

/**
 * Docker uses this sentinel for "never happened" rather than omitting the
 * field, so a container that has never run reports StartedAt in year 1.
 * Passing that through would render as "started 2025 years ago".
 */
const NEVER = '0001-01-01T00:00:00Z';

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined || value === '' || value.startsWith('0001-01-01')) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseHealth(status: string | undefined): Health | undefined {
  switch (status) {
    case 'starting':
    case 'healthy':
    case 'unhealthy':
    case 'none':
      return status;
    default:
      return undefined;
  }
}

/**
 * `{"3000/tcp": [{HostIp, HostPort}]}` -> PortBinding[].
 *
 * A null value means the port is exposed by the image but not published to the
 * host, which the domain models as a binding with no `hostPort`. Dropping
 * those would be wrong: "3000 exposed, not published" is exactly the state a
 * user is trying to diagnose when they wonder why localhost:3000 is dead.
 */
export function parsePorts(
  ports: Readonly<Record<string, readonly InspectPortBinding[] | null>> | undefined,
): readonly PortBinding[] {
  if (ports === undefined) return [];
  const result: PortBinding[] = [];

  for (const [spec, bindings] of Object.entries(ports)) {
    const [portText, protocolText] = spec.split('/');
    const containerPort = Number.parseInt(portText ?? '', 10);
    if (Number.isNaN(containerPort)) continue;
    const protocol = protocolText === 'udp' ? 'udp' : 'tcp';

    if (bindings === null || bindings.length === 0) {
      result.push({ containerPort, protocol });
      continue;
    }

    for (const binding of bindings) {
      const hostPort = Number.parseInt(binding.HostPort ?? '', 10);
      result.push({
        containerPort,
        protocol,
        ...(binding.HostIp === undefined || binding.HostIp === ''
          ? {}
          : { hostIp: binding.HostIp }),
        ...(Number.isNaN(hostPort) ? {} : { hostPort }),
      });
    }
  }

  return result.sort((a, b) => a.containerPort - b.containerPort);
}

/**
 * Docker's seven states map one-to-one onto the domain union, so this is a
 * translation rather than a decision. Anything unrecognised becomes `dead`,
 * which is the safest default: it renders as stopped and offers a start
 * button, where guessing `running` would offer a stop that does nothing.
 */
export function mapRuntime(state: InspectState | undefined): DevContainerRuntime {
  const startedAt = parseDate(state?.StartedAt);
  const ports: readonly PortBinding[] = [];

  switch (state?.Status) {
    case 'created':
      return { state: 'created' };
    case 'running': {
      const health = parseHealth(state.Health?.Status);
      return {
        state: 'running',
        startedAt: startedAt ?? new Date(0),
        ports,
        ...(health === undefined ? {} : { health }),
      };
    }
    case 'paused':
      return { state: 'paused', startedAt: startedAt ?? new Date(0), ports };
    case 'restarting':
      return { state: 'restarting', ...(startedAt === undefined ? {} : { startedAt }) };
    case 'exited':
      return {
        state: 'exited',
        exitCode: state.ExitCode ?? 0,
        finishedAt: parseDate(state.FinishedAt) ?? new Date(0),
      };
    case 'removing':
      return { state: 'removing' };
    case 'dead':
    default:
      return { state: 'dead' };
  }
}

/**
 * The container-side path that becomes the last segment of the editor URI.
 *
 * Three sources in descending order of trustworthiness. Returning undefined is
 * a real outcome, not a failure to try: the domain disables "Open in editor"
 * with a reason rather than opening a path that may not exist.
 */
export function resolveWorkspaceFolder(
  inspect: InspectResponse,
  localFolder: MaybeHostPath,
): ContainerPath | undefined {
  // 1. devcontainer.metadata, when it names one. The label's shape is not
  //    stable across CLI versions, so this reads defensively and gives up
  //    quietly rather than trusting it.
  const metadata = inspect.Config?.Labels?.['devcontainer.metadata'];
  if (metadata !== undefined) {
    const fromMetadata = workspaceFolderFromMetadata(metadata);
    if (fromMetadata !== undefined) return asContainerPath(fromMetadata);
  }

  // 2. WorkingDir, which the devcontainer CLI sets to the workspace folder.
  //    '/' is excluded — that is the Docker default meaning "unset", not a
  //    workspace anybody wants opened.
  const workingDir = inspect.Config?.WorkingDir;
  if (workingDir !== undefined && workingDir !== '' && workingDir !== '/') {
    return asContainerPath(workingDir);
  }

  // 3. The /workspaces/<basename> convention. A guess, but the convention the
  //    CLI follows by default, so it is right far more often than not.
  if (localFolder.kind !== 'unresolved') {
    const separator = localFolder.kind === 'windows' ? '\\' : '/';
    const trimmed = localFolder.path.replace(/[/\\]+$/, '');
    const index = trimmed.lastIndexOf(separator);
    const base = index === -1 ? trimmed : trimmed.slice(index + 1);
    if (base !== '') return asContainerPath(`/workspaces/${base}`);
  }

  return undefined;
}

/**
 * Who to become inside the container — the account VS Code attaches as.
 *
 * `docker exec` runs as the image's configured user, which for a dev container
 * built from a `root`-based image is root. VS Code does not: it attaches as
 * `remoteUser`, and everything a dev container sets up for the developer —
 * PATH entries, nvm, pyenv, cargo, the shell prompt, `~/.local/bin` — belongs
 * to that account. A terminal opened as root is in the same container and a
 * different world: none of the tools resolve, and the prompt is the giveaway
 * (`root ➜ /workspaces/x` rather than `vscode@devcontainer:/workspaces/x`).
 *
 * Three sources, most specific first:
 *
 *   1. `remoteUser` from `devcontainer.metadata` — literally the field VS Code
 *      reads for the same decision, so matching it is not a guess.
 *   2. `containerUser`, which the spec allows instead when the container
 *      PROCESS should run as someone other than root but no separate remote
 *      user is named.
 *   3. `Config.User` from the image. Passing it back explicitly is a no-op —
 *      it is what `exec` would have used anyway — so it is here only to keep
 *      the answer honest rather than to change anything.
 *
 * Undefined means "say nothing and let the daemon decide", which is exactly
 * the behaviour this app had before. A wrong `-u` is worse than no `-u`: the
 * daemon refuses the exec outright for a user that does not exist, and most
 * emulators close the window of a command that exited immediately.
 */
export function resolveRemoteUser(inspect: InspectResponse): string | undefined {
  const metadata = inspect.Config?.Labels?.['devcontainer.metadata'];
  if (metadata !== undefined) {
    const fromMetadata =
      userFromMetadata(metadata, 'remoteUser') ?? userFromMetadata(metadata, 'containerUser');
    if (fromMetadata !== undefined) return fromMetadata;
  }

  const imageUser = inspect.Config?.User;
  return imageUser === undefined || imageUser === '' ? undefined : imageUser;
}

/**
 * Read one user field out of the metadata label.
 *
 * LAST match wins, unlike `workspaceFolderFromMetadata` above, and the
 * difference is not an oversight. The label is an ordered list of fragments —
 * image metadata first, then each feature, then the devcontainer.json itself —
 * and the spec merges single-valued properties by letting later entries
 * override earlier ones. A feature that declares `remoteUser: root` would
 * otherwise win over the `vscode` the developer wrote in their own config,
 * which is the exact inversion this whole function exists to prevent.
 */
function userFromMetadata(raw: string, field: 'remoteUser' | 'containerUser'): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  let found: string | undefined;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = (entry as Record<string, unknown>)[field];
    if (typeof value === 'string' && value !== '') found = value;
  }
  return found;
}

function workspaceFolderFromMetadata(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  // Seen as both a bare object and an array of merged fragments.
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = (entry as Record<string, unknown>)['workspaceFolder'];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Docker prefixes container names with a slash. */
function displayName(name: string | undefined, id: string): string {
  const trimmed = (name ?? '').replace(/^\//, '');
  return trimmed === '' ? id.slice(0, 12) : trimmed;
}

/**
 * Returns undefined when the container is not a dev container — i.e. carries
 * no `devcontainer.local_folder` label. Callers filter on that rather than
 * this throwing, because a non-dev-container is an ordinary thing to meet when
 * listing a developer's daemon, not an error.
 */
export function mapContainer(inspect: InspectResponse): DevContainer | undefined {
  const labels = inspect.Config?.Labels ?? {};
  const localFolderRaw = labels[DEV_CONTAINER_LABEL];
  if (localFolderRaw === undefined) return undefined;

  const mounts = inspect.Mounts ?? [];

  // A bare POSIX label is ambiguous between a native Linux path and a path
  // inside a WSL distro; the mounts can settle it. A no-op on every other
  // platform and whenever the mounts say nothing.
  const mountSources = mounts
    .map((mount) => mount.Source)
    .filter((source): source is string => source !== undefined);
  const localFolder = withWslDistro(
    parseLocalFolder(localFolderRaw),
    wslDistroFromMountSources(mountSources),
  );

  /*
   * The one line where the environment block is allowed to exist.
   *
   * `sshAgentState` reads SSH_AUTH_SOCK and returns a three-arm value; the
   * array itself is never bound to a name that outlives this call, so there is
   * no variable holding a container's tokens for a later edit to accidentally
   * spread into the returned object. See the note on `Config.Env` above — this
   * is the rule that note describes, in code.
   */
  const sshAgent = sshAgentState(
    inspect.Config?.Env,
    mounts
      .map((mount) => mount.Destination)
      .filter((destination): destination is string => destination !== undefined),
  );

  const runtime = mapRuntime(inspect.State);
  const ports = parsePorts(inspect.NetworkSettings?.Ports);

  const devContainerLabels: DevContainerLabels = {
    localFolderRaw,
    ...(labels['devcontainer.config_file'] === undefined
      ? {}
      : { configFileRaw: labels['devcontainer.config_file'] }),
    ...(labels['devcontainer.metadata'] === undefined
      ? {}
      : { metadataRaw: labels['devcontainer.metadata'] }),
    ...(labels['com.docker.compose.project'] === undefined
      ? {}
      : { composeProject: labels['com.docker.compose.project'] }),
  };

  const configFileRaw = labels['devcontainer.config_file'];
  const configFile = configFileRaw === undefined ? undefined : parseLocalFolder(configFileRaw);
  const workspaceFolder = resolveWorkspaceFolder(inspect, localFolder);
  const remoteUser = resolveRemoteUser(inspect);

  return {
    id: asContainerId(inspect.Id),
    name: displayName(inspect.Name, inspect.Id),
    image: inspect.Config?.Image ?? '(unknown image)',
    createdAt: parseDate(inspect.Created) ?? new Date(0),
    localFolder,
    ...(workspaceFolder === undefined ? {} : { workspaceFolder }),
    ...(remoteUser === undefined ? {} : { remoteUser }),
    ...(configFile === undefined || configFile.kind === 'unresolved' ? {} : { configFile }),
    sshAgent,
    labels: devContainerLabels,
    // `ports` only exists on the running/paused arms, so it is attached after
    // the fact rather than threaded through mapRuntime, which would have to
    // take a parameter it ignores in five of seven cases.
    runtime:
      runtime.state === 'running'
        ? { ...runtime, ports }
        : runtime.state === 'paused'
          ? { ...runtime, ports }
          : runtime,
  };
}

export { NEVER as DOCKER_NEVER_TIMESTAMP };
