import type { DevContainerRuntime, EndpointFailure, MaybeHostPath } from '../domain/index.js';

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
