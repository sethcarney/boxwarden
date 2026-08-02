import type {
  ContainerRuntimeKind,
  DevContainerProject,
  DevContainerRuntime,
  DockerTransport,
  EndpointFailure,
  EngineSummary,
  MaybeHostPath,
} from '../models/index.js';

/** Pure display helpers. Kept out of the components so they can be tested without a DOM. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 hours ago", "just now".
 *
 * `now` is a parameter rather than a call to Date.now() inside, because a
 * function that reads the clock cannot be tested without either freezing time
 * globally or asserting on a moving target.
 */
export function relativeTime(then: Date, now: number = Date.now()): string {
  const delta = now - then.getTime();
  if (delta < 0) return 'just now';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(delta / DAY);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The precise state, spelled out. The coarse three-way bucket for colour comes
 * from the domain's `displayStatus`; this is the text beside it, and it keeps
 * the detail that the bucket discards — a non-zero exit code above all, since
 * "Exited (137)" tells a user their container was OOM-killed and "Stopped"
 * does not.
 */
export function statusLabel(runtime: DevContainerRuntime, now: number = Date.now()): string {
  switch (runtime.state) {
    case 'running': {
      const health =
        runtime.health === undefined || runtime.health === 'none' ? '' : ` · ${runtime.health}`;
      return `Up ${relativeTime(runtime.startedAt, now).replace(/ ago$/, '')}${health}`;
    }
    case 'paused':
      return 'Paused';
    case 'created':
      return 'Created, never started';
    case 'restarting':
      return 'Restarting';
    case 'removing':
      return 'Removing';
    case 'dead':
      return 'Dead';
    case 'exited':
      return runtime.exitCode === 0
        ? `Exited ${relativeTime(runtime.finishedAt, now)}`
        : `Exited (${runtime.exitCode}) ${relativeTime(runtime.finishedAt, now)}`;
  }
}

/** Whether a start action makes sense for this state. */
export function canStart(runtime: DevContainerRuntime): boolean {
  return runtime.state === 'created' || runtime.state === 'exited' || runtime.state === 'dead';
}

/** Whether a stop action makes sense for this state. */
export function canStop(runtime: DevContainerRuntime): boolean {
  return runtime.state === 'running' || runtime.state === 'paused';
}

/**
 * Whether a shell can be opened in this container.
 *
 * Stricter than `canStop`, and the difference is `paused`: a paused container
 * still holds its process namespace, so `docker exec` is accepted and then
 * blocks forever against frozen processes. A terminal that opens and hangs is
 * worse than a disabled button, so pausing takes the action away.
 */
export function canExec(runtime: DevContainerRuntime): boolean {
  return runtime.state === 'running';
}

/**
 * Turn an endpoint failure into a sentence with a fix in it.
 *
 * This is the screen a user sees when the app looks broken, so the text is the
 * feature. "Could not connect to Docker" is what makes this class of tool
 * infuriating; naming the socket that was missing is what makes it useful.
 */
export function explainFailure(failure: EndpointFailure, target: string): string {
  switch (failure.code) {
    case 'not-present':
      return `No Docker socket at ${target}. Docker does not appear to be installed, or it is listening somewhere else — check DOCKER_HOST.`;
    case 'permission-denied':
      return `Found ${target} but was not allowed to read it. On Linux this usually means your user is not in the "docker" group.`;
    case 'connection-refused':
      return `${target} exists but refused the connection. Docker is installed and not running — start Docker Desktop, or "sudo systemctl start docker".`;
    case 'timeout':
      return `${target} did not answer within ${failure.ms}ms. The daemon may be starting up, or wedged.`;
    case 'tls-required':
      return `${target} requires TLS certificates that boxwarden was not given.`;
    case 'api-too-old':
      return `${target} speaks Docker API ${failure.server}, but boxwarden needs at least ${failure.minimum}.`;
    case 'unknown':
      return `${target} failed in a way boxwarden does not recognise: ${failure.detail}`;
  }
}

/**
 * The engine's name as its makers spell it.
 *
 * Worth a lookup table rather than a hardcoded "Docker" because the version
 * string beside it belongs to whatever actually answered. "Docker 5.7.0" is not
 * a cosmetic slip — Docker has no 5.7.0, so it sends a user debugging an empty
 * container list searching for a release that does not exist, when what they
 * are running is Podman.
 */
const RUNTIME_NAMES: Readonly<Record<ContainerRuntimeKind, string>> = {
  'docker-desktop': 'Docker Desktop',
  'docker-engine': 'Docker',
  orbstack: 'OrbStack',
  colima: 'Colima',
  'rancher-desktop': 'Rancher Desktop',
  podman: 'Podman',
};

export function runtimeLabel(runtime: ContainerRuntimeKind): string {
  return RUNTIME_NAMES[runtime];
}

/**
 * The connection target, for the diagnostics list.
 *
 * A WSL endpoint is rendered in the `\\wsl.localhost\...` form even though that
 * path is precisely the thing Windows cannot open — it is the form the user can
 * paste into Explorer to confirm the distro is the one they think it is, and
 * the only spelling of "this socket, in that distro" they will recognise.
 */
export function describeTarget(transport: DockerTransport): string {
  switch (transport.transport) {
    case 'unix':
      return transport.socketPath;
    case 'npipe':
      return transport.pipeName;
    case 'tcp':
      return `tcp://${transport.host}:${transport.port}`;
    case 'ssh':
      return `ssh://${transport.host}`;
    case 'wsl':
      return `\\\\wsl.localhost\\${transport.distro}${transport.socketPath.replaceAll('/', '\\')}`;
  }
}

/**
 * One engine, as the picker lists it.
 *
 * The qualifier in brackets is what distinguishes two entries that would
 * otherwise read identically — and they routinely do. A Windows machine running
 * podman answers as "Podman 5.7.0" on both a named pipe and a WSL relay, and a
 * picker offering that name twice is worse than no picker at all.
 */
export function engineOptionLabel(engine: EngineSummary): string {
  const name = `${runtimeLabel(engine.runtime)} ${engine.serverVersion}`;
  const where =
    engine.transport.transport === 'wsl'
      ? `WSL: ${engine.transport.distro}`
      : describeTarget(engine.transport);
  return `${name} (${where})`;
}

/**
 * The `devcontainer` CLI invocation that builds a project, for the copy button.
 *
 * SHOWN, NEVER RUN — the same rule the setup advice follows, and for a stronger
 * reason here. `devcontainer up` pulls images, executes `postCreateCommand`
 * from a file in the repo, and can take ten minutes; a button that did it
 * silently would be boxwarden running arbitrary code out of whatever the user
 * last cloned. Copy-and-paste keeps them able to read it first, and leaves the
 * build output somewhere they can watch it.
 *
 * A `wsl` project gets the `wsl -d` prefix because the CLI has to run INSIDE
 * the distro: run from Windows against `\\wsl.localhost\...`, the bind mount is
 * a 9P share and the container gets the wrong filesystem.
 *
 * Quoting is deliberately simple — double quotes, which both bash and
 * PowerShell honour. A folder whose name contains a double quote is not
 * handled, and would be visibly wrong rather than quietly wrong.
 */
export function devcontainerUpCommand(project: DevContainerProject): string {
  const quote = (path: string): string => (/[\s"'$`\\&|;()<>]/.test(path) ? `"${path}"` : path);

  switch (project.folder.kind) {
    case 'posix':
    case 'windows':
      return `devcontainer up --workspace-folder ${quote(project.folder.path)}`;
    case 'wsl':
      return `wsl -d ${project.folder.distro} devcontainer up --workspace-folder ${quote(project.folder.path)}`;
  }
}

/** One-line host path for the row, with the WSL and unresolved cases spelled out. */
export function hostPathLabel(path: MaybeHostPath): string {
  switch (path.kind) {
    case 'posix':
    case 'windows':
      return path.path;
    case 'wsl':
      return `${path.path}  (WSL: ${path.distro})`;
    case 'unresolved':
      return path.raw;
  }
}
