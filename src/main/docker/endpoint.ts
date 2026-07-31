import { homedir, platform } from 'node:os';
import { posix } from 'node:path';

/**
 * `posix.join`, never the bare `join`.
 *
 * `node:path`'s default export switches separator on the HOST platform, but
 * every path built below is a unix socket path on a TARGET platform that the
 * caller passes in as an argument. Those are different questions, and `join`
 * answers the wrong one: on a Windows host, `candidateEndpoints('darwin', ...)`
 * produced `/Users/dev\.orbstack\run\docker.sock`.
 *
 * That only ever surfaced as two failing tests, because in production the host
 * and target always agreed — but it makes the suite unrunnable on Windows,
 * which is precisely where this app most needs to be developed.
 */
const join = posix.join;
import type {
  ContainerRuntimeKind,
  DockerEndpoint,
  DockerTransport,
  EndpointFailure,
} from '../../domain/index.js';

/**
 * Where to look for a Docker daemon, and in what order.
 *
 * Kept pure and separate from the probing so the ordering can be unit-tested
 * per platform without a daemon anywhere in sight.
 */

/** Minimum Docker API version. 1.41 is Docker 20.10, which is where `Health` on inspect stabilised. */
export const MINIMUM_API_VERSION = '1.41';

interface Env {
  readonly DOCKER_HOST?: string | undefined;
  readonly XDG_RUNTIME_DIR?: string | undefined;
}

/**
 * Parse a DOCKER_HOST value. Returns undefined rather than throwing for
 * anything unrecognised — a malformed DOCKER_HOST should downgrade to "try the
 * well-known sockets instead", not crash the app on launch.
 */
export function parseDockerHost(value: string): DockerTransport | undefined {
  const raw = value.trim();
  if (raw === '') return undefined;

  if (raw.startsWith('unix://')) {
    const socketPath = raw.slice('unix://'.length);
    return socketPath === '' ? undefined : { transport: 'unix', socketPath };
  }

  if (raw.startsWith('npipe://')) {
    // npipe:////./pipe/docker_engine -> //./pipe/docker_engine
    const pipeName = raw.slice('npipe://'.length);
    return pipeName === '' ? undefined : { transport: 'npipe', pipeName };
  }

  if (raw.startsWith('tcp://') || raw.startsWith('http://') || raw.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(raw.replace(/^tcp:/, 'http:'));
    } catch {
      return undefined;
    }
    const secure = raw.startsWith('https://');
    const port = url.port === '' ? (secure ? 2376 : 2375) : Number(url.port);
    return { transport: 'tcp', host: url.hostname, port };
  }

  if (raw.startsWith('ssh://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    // exactOptionalPropertyTypes: an absent user must be an absent key, not
    // an explicit undefined, so these are spread in conditionally.
    return {
      transport: 'ssh',
      host: url.hostname,
      ...(url.port === '' ? {} : { port: Number(url.port) }),
      ...(url.username === '' ? {} : { user: url.username }),
    };
  }

  return undefined;
}

interface WellKnownSocket {
  readonly runtime: ContainerRuntimeKind;
  readonly path: string;
}

/**
 * The well-known sockets per platform, most-likely first.
 *
 * Docker Desktop's user socket comes before /var/run/docker.sock on macOS
 * because the latter is usually a symlink to the former — probing the real
 * path first means the diagnostic names the runtime rather than a symlink.
 */
function wellKnownSockets(os: NodeJS.Platform, home: string, env: Env): readonly WellKnownSocket[] {
  if (os === 'win32') {
    // `docker_engine` is a contested name, not a Docker Desktop one. Podman's
    // docker-compat service and Rancher Desktop in moby mode both claim it, so
    // the `runtime` here is only a placeholder for the diagnostics line when
    // nothing answers — `detectRuntime` overwrites it the moment one does.
    return [
      { runtime: 'docker-desktop', path: '//./pipe/docker_engine' },
      // Docker Desktop's WSL2 backend also exposes this second, unshared pipe.
      // Worth probing because a user can disable the generic `docker_engine`
      // one ("Expose daemon on tcp://" / compat settings) and keep this.
      { runtime: 'docker-desktop', path: '//./pipe/dockerDesktopLinuxEngine' },
      // `podman machine` publishes its own pipe under the machine's name. The
      // default machine covers the overwhelmingly common case; a user with a
      // renamed machine still has DOCKER_HOST.
      { runtime: 'podman', path: '//./pipe/podman-machine-default' },
    ];
  }

  if (os === 'darwin') {
    return [
      { runtime: 'docker-desktop', path: join(home, '.docker', 'run', 'docker.sock') },
      { runtime: 'orbstack', path: join(home, '.orbstack', 'run', 'docker.sock') },
      { runtime: 'colima', path: join(home, '.colima', 'default', 'docker.sock') },
      { runtime: 'rancher-desktop', path: join(home, '.rd', 'docker.sock') },
      { runtime: 'docker-engine', path: '/var/run/docker.sock' },
    ];
  }

  // Linux, including inside this project's own dev container, where
  // docker-outside-of-docker bind-mounts the host socket to /var/run/docker.sock.
  const runtimeDir = env.XDG_RUNTIME_DIR;
  return [
    { runtime: 'docker-engine', path: '/var/run/docker.sock' },
    ...(runtimeDir === undefined || runtimeDir === ''
      ? []
      : [
          { runtime: 'docker-engine' as const, path: join(runtimeDir, 'docker.sock') },
          { runtime: 'podman' as const, path: join(runtimeDir, 'podman', 'podman.sock') },
        ]),
    { runtime: 'docker-desktop', path: join(home, '.docker', 'desktop', 'docker.sock') },
  ];
}

/**
 * WSL distributions that host an engine of their own but are already covered by
 * a Windows named pipe, so relaying into them would only find the same
 * containers a second time.
 *
 * `docker-desktop-data` is listed for a different reason: it is a storage
 * volume with no daemon in it at all, and probing it can only ever waste a
 * second on the way to failing.
 */
function isRedundantDistro(distro: string): boolean {
  const name = distro.toLowerCase();
  return (
    name === 'docker-desktop' || name === 'docker-desktop-data' || name.startsWith('podman-machine')
  );
}

/**
 * Parse `wsl.exe --list --quiet --running` into distro names.
 *
 * `--quiet --running` and not `-l -v` on purpose. The verbose table is
 * LOCALISED — on a German Windows the STATE column reads "Wird ausgeführt" —
 * so any parser that greps for "Running" silently finds nothing for a large
 * fraction of users, and reports "no WSL distros" on a machine full of them.
 * The quiet list is names only, and names are not translated.
 *
 * The NUL stripping is not defensive padding: wsl.exe writes UTF-16LE, and when
 * that is decoded as UTF-8 (or when only the BOM is trimmed) every character
 * arrives interleaved with NUL bytes. Callers that decode properly lose
 * nothing by this running anyway.
 */
export function parseWslDistroList(stdout: string): readonly string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replaceAll('\0', '').trim())
    .filter((line) => line !== '')
    .filter((line) => !isRedundantDistro(line));
}

/** A socket found (or started) inside a WSL distribution. */
export interface WslSocket {
  readonly distro: string;
  readonly socketPath: string;
  readonly runtime: ContainerRuntimeKind;
}

/**
 * Full ordered candidate list. DOCKER_HOST always wins when set and parseable:
 * a user who exported it meant it, and silently probing something else would
 * make the resulting error impossible to understand.
 *
 * WSL candidates come last, after the named pipes. Order matters much less than
 * it used to — the client now connects to every candidate that answers rather
 * than stopping at the first — but a pipe is an order of magnitude cheaper to
 * probe than spawning `wsl.exe`, so the cheap ones go first.
 */
export function candidateEndpoints(
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  env: Env = process.env,
  wslSockets: readonly WslSocket[] = [],
): readonly DockerEndpoint[] {
  const candidates: DockerEndpoint[] = [];

  const dockerHost = env.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== '') {
    const transport = parseDockerHost(dockerHost);
    if (transport !== undefined) {
      candidates.push({
        transport,
        origin: { kind: 'env', variable: 'DOCKER_HOST', value: dockerHost },
      });
    }
  }

  for (const { runtime, path } of wellKnownSockets(os, home, env)) {
    const transport: DockerTransport =
      os === 'win32'
        ? { transport: 'npipe', pipeName: path }
        : { transport: 'unix', socketPath: path };
    candidates.push({ transport, origin: { kind: 'well-known', runtime } });
  }

  for (const { distro, socketPath, runtime } of wslSockets) {
    candidates.push({
      transport: { transport: 'wsl', distro, socketPath },
      origin: { kind: 'wsl', distro, runtime },
    });
  }

  return candidates;
}

/** Human-readable target, for the diagnostics panel. */
export function describeTransport(transport: DockerTransport): string {
  switch (transport.transport) {
    case 'unix':
      return transport.socketPath;
    case 'npipe':
      return transport.pipeName;
    case 'tcp':
      return `tcp://${transport.host}:${transport.port}`;
    case 'ssh':
      return `ssh://${transport.user === undefined ? '' : `${transport.user}@`}${transport.host}${
        transport.port === undefined ? '' : `:${transport.port}`
      }`;
    case 'wsl':
      return `\\\\wsl.localhost\\${transport.distro}${transport.socketPath.replaceAll('/', '\\')}`;
  }
}

/**
 * Map a thrown connection error onto the domain's failure taxonomy.
 *
 * The distinction that matters most is `not-present` vs `connection-refused`:
 * a missing socket means the runtime is not installed, a socket that refuses
 * means it is installed and not running. Those are different sentences in the
 * UI and different fixes for the user.
 */
export function classifyError(error: unknown): EndpointFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
  const detail = error instanceof Error ? error.message : String(error);

  switch (code) {
    case 'ENOENT':
      return { code: 'not-present', detail };
    case 'EACCES':
    case 'EPERM':
      return { code: 'permission-denied', detail };
    case 'ECONNREFUSED':
      return { code: 'connection-refused' };
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return { code: 'timeout', ms: PROBE_TIMEOUT_MS };
    default:
      return { code: 'unknown', detail };
  }
}

export const PROBE_TIMEOUT_MS = 3_000;

/** Numeric compare for Docker's "1.41" style versions. */
export function apiVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(actual);
  const b = parse(minimum);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
