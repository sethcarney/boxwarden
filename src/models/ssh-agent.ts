/**
 * Whether an SSH agent socket is actually usable inside a container.
 *
 * WHY THIS EXISTS
 *
 * Agent forwarding is the difference between `git push` working and a
 * container that looks completely healthy and cannot reach a private repo. It
 * fails silently — nothing in the container's state, health or logs mentions
 * it — and it surfaces minutes later as `Permission denied (publickey)` at the
 * first fetch, which reads like a key problem rather than a plumbing one.
 *
 * Everything needed to spot it is already in the `inspect` response discovery
 * reads, so this costs no extra Docker call and no new IPC verb: it is a pure
 * fold over two lists of strings.
 */

/** The variable every SSH client reads to find the agent. */
export const SSH_AUTH_SOCK = 'SSH_AUTH_SOCK';

/**
 * Three arms, and the middle one is the whole point.
 *
 * `declared-unmounted` is the state a user cannot diagnose on their own: the
 * environment variable is set, so `env | grep SSH` agrees with every tutorial
 * they will find, and the socket it names does not exist. Telling that apart
 * from `absent` is the entire value of this module — `absent` is an ordinary
 * and usually correct configuration, and must never be reported as a fault.
 */
export type SshAgentState =
  | { readonly kind: 'forwarded'; readonly socket: string }
  | { readonly kind: 'declared-unmounted'; readonly socket: string }
  | { readonly kind: 'absent' };

/**
 * Read one variable out of Docker's `Config.Env`, a flat list of `KEY=VALUE`.
 *
 * LAST occurrence wins. Docker composes `Config.Env` by appending the
 * container's own environment after the image's, so a key appearing twice
 * means the later entry overrode the earlier — taking the first would report
 * the image's default for a container that was explicitly given something else.
 *
 * A value may itself contain `=`, so the split is at the FIRST separator only.
 */
function readEnv(env: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  let found: string | undefined;
  for (const entry of env) {
    if (entry.startsWith(prefix)) found = entry.slice(prefix.length);
  }
  return found;
}

/** Container paths are POSIX whatever the host is, so one trailing-slash rule covers them all. */
function trimTrailingSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Does a mount at `destination` put something at `socket`?
 *
 * True for an exact match — Docker Desktop's magic socket
 * (`/run/host-services/ssh-auth.sock`) and the usual hand-rolled compose bind
 * (`/ssh-agent`) are both mounted at the socket path itself — and also when
 * the mount is a DIRECTORY containing it, which is how a setup that shares the
 * agent socket's parent (`/tmp/ssh-XXXX/agent.1234`) arrives.
 *
 * The bias is deliberate and one-directional. A missed ancestor would report
 * `declared-unmounted` for a container that is in fact fine, and a warning that
 * cries wolf is worse than no warning: erring towards `forwarded` costs one
 * warning we did not raise, erring the other way costs the credibility of
 * every warning we do.
 *
 * `/` is refused as an ancestor for that same reason inverted — a mount at the
 * root would otherwise vouch for every socket path there is.
 */
function mountCovers(destination: string, socket: string): boolean {
  const dest = trimTrailingSlashes(destination.trim());
  if (dest === '' || dest === '/') return false;
  return socket === dest || socket.startsWith(`${dest}/`);
}

/**
 * `Config.Env` + mount destinations -> agent state.
 *
 * Takes the two lists rather than an inspect response so that it imports
 * nothing and stays in the model layer. The caller in
 * `src/main/docker/mapping.ts` owns the security rule that goes with it: pull
 * `SSH_AUTH_SOCK` out here and let the rest of the environment block go out of
 * scope. Container environments hold tokens, database passwords and API keys,
 * and none of that has any business crossing IPC, reaching a log line, or
 * being kept in a snapshot.
 */
export function sshAgentState(
  env: readonly string[] | undefined,
  mountDestinations: readonly string[],
): SshAgentState {
  const raw = readEnv(env ?? [], SSH_AUTH_SOCK);

  // Set-but-empty is how a shell profile clears the variable. It names no
  // socket, so there is nothing to be wrong about: that is `absent`, not a
  // declaration we failed to satisfy.
  if (raw === undefined || raw.trim() === '') return { kind: 'absent' };

  const socket = trimTrailingSlashes(raw.trim());
  const mounted = mountDestinations.some((destination) => mountCovers(destination, socket));
  return mounted ? { kind: 'forwarded', socket } : { kind: 'declared-unmounted', socket };
}

/** The containers a user needs telling about, in list order. */
export function containersMissingAgentSocket<T extends { readonly sshAgent: SshAgentState }>(
  containers: readonly T[],
): readonly T[] {
  return containers.filter((container) => container.sshAgent.kind === 'declared-unmounted');
}
