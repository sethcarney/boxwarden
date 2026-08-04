import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { ContainerRuntimeKind, WslDistroReport, WslStatus } from '../../models/index.js';
import { isRelayCandidate, parseWslDistroList, type WslSocket } from './endpoint.js';

/**
 * Reaching a container engine that lives inside a WSL2 distribution.
 *
 * THE PROBLEM
 *
 * On Windows, `podman` and rootless `docker` inside a WSL distro serve their
 * API on an ordinary unix socket — `/run/user/1000/podman/podman.sock`. Windows
 * can see that file through `\\wsl.localhost\<distro>\...` and can never open
 * it: the 9P protocol WSL uses to project a distro's filesystem carries regular
 * files, not unix domain sockets. There is no named pipe either; `podman
 * machine` publishes one, but a distro you created yourself does not.
 *
 * So an engine running inside `dev` is, as far as every Windows-side Docker
 * client is concerned, invisible. Not refusing connections, not permission
 * denied — absent. That is why a machine can be running dev containers happily
 * while boxwarden reports an empty list.
 *
 * THE APPROACH
 *
 * Put the socket-opening end of the connection on the Linux side of the
 * boundary, where it is just a socket, and pipe bytes across via stdio:
 *
 *   wsl.exe -d <distro> -- socat STDIO UNIX-CONNECT:<socket>
 *
 * One relay process per HTTP connection, wired into a Node http.Agent through
 * `createConnection`. dockerode is unaware any of this is happening; from its
 * side it is talking to a socket like any other.
 *
 * WHY NOT A TCP PORT
 *
 * `podman system service tcp://0.0.0.0:2375` plus WSL's localhost forwarding is
 * the usual advice and is one line shorter. It is also an unauthenticated,
 * root-equivalent API bound to a port — anything on the machine that can open a
 * socket can create a privileged container. The stdio relay grants exactly the
 * access the user already has, to exactly this process, and leaves nothing
 * listening when boxwarden exits.
 */

/** How long any single wsl.exe helper invocation may take before it is abandoned. */
const WSL_COMMAND_TIMEOUT_MS = 8_000;

/** How long to wait for a freshly started `podman system service` to bind. */
const SERVICE_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Sockets already in place are preferred; this is only for distros that have no
 * API socket at all, which is the norm — podman is daemonless, and a distro
 * without systemd user sessions (WSL's default) has nothing to socket-activate
 * it. Its own name so an orphan from a previous run is recognised and reused
 * rather than duplicated.
 */
function managedSocketPath(uid: string): string {
  return `/tmp/boxwarden-${uid}-podman.sock`;
}

interface WslExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * wsl.exe could not be started at all — almost always ENOENT, meaning the
   * WSL optional component was never enabled on this machine.
   *
   * Distinct from `code: null` (which also covers a timeout) because the two
   * lead to completely different advice: "run wsl --install" versus "your
   * distro is wedged". Collapsing them is how a missing feature gets reported
   * as a hang.
   */
  readonly spawnFailed: boolean;
}

/**
 * `encoding` matters and is easy to get wrong. wsl.exe's OWN output (`--list`)
 * is UTF-16LE; the output of a program it runs INSIDE a distro is whatever that
 * program wrote, i.e. UTF-8. Decoding the first as UTF-8 yields text with a NUL
 * between every character, which greps as "no distros found".
 */
function runWsl(
  args: readonly string[],
  encoding: 'utf16le' | 'utf8',
  timeoutMs = WSL_COMMAND_TIMEOUT_MS,
): Promise<WslExecResult> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', [...args], { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const finish = (code: number | null, spawnFailed = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString(encoding),
        stderr: Buffer.concat(err).toString(encoding),
        spawnFailed,
      });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', () => finish(null, true));
    child.on('close', (code) => finish(code));
  });
}

/** Running distros only — starting a stopped one to look for an engine would be rude and slow. */
async function listRunningDistros(): Promise<readonly string[]> {
  const { code, stdout } = await runWsl(['--list', '--quiet', '--running'], 'utf16le');
  if (code !== 0) return [];
  return parseWslDistroList(stdout);
}

/** Every distro installed, running or not. Empty is a real answer here, not a failure. */
async function listInstalledDistros(): Promise<readonly string[]> {
  const { code, stdout } = await runWsl(['--list', '--quiet'], 'utf16le');
  // A nonzero exit here means "no distributions installed" as often as it means
  // an error — wsl.exe returns -1 for both — so an empty list is the honest
  // reading either way.
  if (code !== 0) return [];
  return parseWslDistroList(stdout);
}

/**
 * Whether WSL is usable at all.
 *
 * `wsl.exe --status` rather than `--list`, because the two failures need
 * separating: Windows 10/11 ship a wsl.exe STUB even when the optional
 * component is off, so the binary existing proves nothing. The stub exits
 * nonzero from --status; a real installation exits 0 whether or not any distro
 * exists. That is the cleanest signal available without reading the registry.
 */
async function wslIsInstalled(): Promise<boolean> {
  const { code, spawnFailed } = await runWsl(['--status'], 'utf16le');
  return !spawnFailed && code === 0;
}

/**
 * Run a shell script inside a distro, delivered on STDIN.
 *
 * NOT `sh -c <script>`, which is the obvious spelling and silently produces
 * garbage. An argument containing quotes has to survive Node's Windows
 * command-line quoting and then wsl.exe's own re-parse of that command line
 * before a Linux shell ever sees it, and it does not: the script arrives with
 * its quoting mangled, so every `"$var"` expands to empty. The failure has no
 * error attached — the shell exits 0 having done nothing — which is what makes
 * it worth this comment.
 *
 * STDIN has no such layer. `sh -s` reads the script as bytes.
 */
function runWslScript(
  distro: string,
  script: string,
  timeoutMs = WSL_COMMAND_TIMEOUT_MS,
): Promise<WslExecResult> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', distro, '--', 'sh', '-s'], { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const finish = (code: number | null, spawnFailed = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        spawnFailed,
      });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', () => finish(null, true));
    child.on('close', (code) => finish(code));
    child.stdin.end(script, 'utf8');
  });
}

/**
 * One round trip per distro that answers four questions at once: the uid (the
 * rootless socket paths embed it), which known socket already exists, whether
 * podman is available to start one if none does, and whether socat is there to
 * relay it.
 */
const INSPECT_SCRIPT = [
  'uid=$(id -u)',
  'podman=no',
  'command -v podman >/dev/null 2>&1 && podman=yes',
  'socat=no',
  'command -v socat >/dev/null 2>&1 && socat=yes',
  'sock=""',
  'if [ "$socat" = yes ]; then',
  '  for p in /var/run/docker.sock /run/docker.sock "/run/user/$uid/docker.sock" "/run/user/$uid/podman/podman.sock" "/tmp/boxwarden-$uid-podman.sock"; do',
  '    [ -S "$p" ] || continue',
  // `-S` is a file-TYPE test and nothing more. A `podman system service` that
  // was killed leaves its socket file behind, so `-S` keeps passing on a socket
  // with nothing behind it — discovery reports a healthy engine and every
  // request then fails with ECONNREFUSED. Actually connecting is the only way
  // to tell the two apart. -T1 bounds it; </dev/null makes socat hang up
  // immediately once connected, so a live socket costs a few milliseconds.
  '    if socat -T1 - "UNIX-CONNECT:$p" </dev/null >/dev/null 2>&1; then sock="$p"; break; fi',
  '  done',
  'fi',
  'printf \'%s\\n%s\\n%s\\n%s\\n\' "$uid" "$sock" "$podman" "$socat"',
].join('\n');

interface DistroInspection {
  readonly uid: string;
  readonly socketPath: string | undefined;
  readonly hasPodman: boolean;
  readonly hasSocat: boolean;
}

async function inspectDistro(distro: string): Promise<DistroInspection | undefined> {
  const { code, stdout } = await runWslScript(distro, INSPECT_SCRIPT);
  if (code !== 0) return undefined;

  const [uid, sock, podman, socat] = stdout.split('\n').map((line) => line.trim());
  if (uid === undefined || uid === '') return undefined;

  return {
    uid,
    socketPath: sock === undefined || sock === '' ? undefined : sock,
    hasPodman: podman === 'yes',
    hasSocat: socat === 'yes',
  };
}

/**
 * Long-lived `podman system service` processes started by this process, so they
 * can be shut down on quit rather than left holding the distro awake.
 *
 * `--time=0` (never idle-exit) is deliberate. An idle timeout would let the
 * service vanish between refreshes and turn a routine refresh into a visible
 * failure before the retry path kicks in. The cost is an orphan if boxwarden is
 * hard-killed, and that is bounded: the socket path is deterministic, so the
 * next run finds the orphan in INSPECT_SCRIPT and reuses it instead of starting
 * a second one.
 */
const managedServices = new Map<string, ChildProcess>();

/**
 * Whether the socket is not merely present but actually accepting connections.
 * See the note in INSPECT_SCRIPT for why presence is not enough.
 */
async function socketIsLive(distro: string, socketPath: string): Promise<boolean> {
  const { code } = await runWslScript(
    distro,
    `socat -T1 - "UNIX-CONNECT:${socketPath}" </dev/null >/dev/null 2>&1`,
    4_000,
  );
  return code === 0;
}

async function startPodmanService(distro: string, uid: string): Promise<string | undefined> {
  const socketPath = managedSocketPath(uid);

  const existing = managedServices.get(distro);
  if (existing?.exitCode === null && !existing.killed) {
    return (await socketIsLive(distro, socketPath)) ? socketPath : undefined;
  }

  // Clear any corpse first. podman refuses to bind over an existing file
  // ("address already in use"), so a socket left by a previous run does not
  // just fail to serve — it blocks its own replacement from starting. Safe to
  // remove unconditionally: the path is boxwarden's own, and we only reach here
  // because INSPECT_SCRIPT already established nothing is listening on it.
  await runWslScript(distro, `rm -f "${socketPath}"`, 4_000);

  const child = spawn(
    'wsl.exe',
    ['-d', distro, '--', 'podman', 'system', 'service', '--time=0', `unix://${socketPath}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  child.on('error', () => managedServices.delete(distro));
  child.on('exit', () => managedServices.delete(distro));
  // Drained so the pipes cannot fill and wedge the service.
  child.stdout.resume();
  child.stderr.resume();
  managedServices.set(distro, child);

  const deadline = Date.now() + SERVICE_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await socketIsLive(distro, socketPath)) return socketPath;
    if (child.exitCode !== null) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill();
  managedServices.delete(distro);
  return undefined;
}

function runtimeFromSocketPath(socketPath: string): ContainerRuntimeKind {
  return socketPath.includes('podman') ? 'podman' : 'docker-engine';
}

/** What discovery learned about WSL: the sockets it can use, and why it has no more. */
export interface WslDiscovery {
  readonly status: WslStatus;
  readonly sockets: readonly WslSocket[];
}

const NOT_APPLICABLE: WslDiscovery = { status: { kind: 'not-applicable' }, sockets: [] };

/**
 * How long a WSL reading is good for.
 *
 * The same bargain, and the same number, as `probeSshAgent` — and for a
 * sharper version of the same reason. Discovery calls `probe()` every five
 * seconds, and on Windows an uncached pass through this function spawns
 * `wsl.exe` at least three times before it has even looked at a distro:
 * `wslIsInstalled`, `listInstalledDistros`, `listRunningDistros`, then one
 * `inspectDistro` per candidate. That is upwards of a thousand process spawns
 * an hour to re-answer a question that changes when somebody starts a distro.
 *
 * 30 seconds is chosen from the user's side rather than the machine's: someone
 * who has just started a distro, or installed socat because an advisory told
 * them to, should see the app notice on its own rather than wonder whether it
 * is going to. Long enough to stop the spawning, short enough to feel awake.
 */
const CACHE_TTL_MS = 30_000;

let cached: { readonly at: number; readonly value: WslDiscovery } | undefined;

/**
 * Every running WSL distro that has, or can be given, a reachable engine socket
 * — plus enough about the ones that do not for the UI to explain itself.
 *
 * The status half is not a by-product. On Windows, "no container engine found"
 * and "WSL is not installed" are the same finding, and only this function is in
 * a position to tell them apart; returning only the sockets is what forced the
 * UI to say "couldn't connect" and stop there.
 *
 * Distros are inspected concurrently: a machine with three distros should not
 * pay three round trips in series for it.
 *
 * **Cached**, because this is the most expensive thing the five-second poll can
 * reach — see `CACHE_TTL_MS`. `now` is a parameter for the reason the clock is
 * one everywhere else in this codebase: a test asks for a fresh read by passing
 * a time past the TTL rather than by reaching for a global.
 */
export async function discoverWsl(now: number = Date.now()): Promise<WslDiscovery> {
  if (process.platform !== 'win32') return NOT_APPLICABLE;
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await discover();
  cached = { at: now, value };
  return value;
}

/**
 * Drop the cached reading.
 *
 * For the one case where waiting out the TTL is wrong: the user pressed
 * something. A forced check is the user asking a question, and answering it
 * with a reading from twenty seconds ago is how an app looks broken to the
 * person who just fixed the thing it was complaining about.
 */
export function invalidateWslCache(): void {
  cached = undefined;
}

async function discover(): Promise<WslDiscovery> {
  if (!(await wslIsInstalled())) {
    return { status: { kind: 'not-installed' }, sockets: [] };
  }

  const installed = await listInstalledDistros();
  if (installed.length === 0) {
    return { status: { kind: 'no-distros' }, sockets: [] };
  }

  const running = await listRunningDistros();
  if (running.length === 0) {
    return { status: { kind: 'none-running', installed }, sockets: [] };
  }

  // Only distros worth relaying into are inspected — docker-desktop and
  // podman-machine-* already answer on a named pipe. They stay out of the
  // report too: listing them as "missing socat" would send the user installing
  // a package into a distro whose containers are already in the list.
  const candidates = running.filter(isRelayCandidate);

  const reports = await Promise.all(
    candidates.map(async (distro): Promise<WslDistroReport> => {
      const inspection = await inspectDistro(distro);
      if (inspection === undefined) {
        return { distro, hasSocat: false, hasPodman: false };
      }

      const base = { distro, hasSocat: inspection.hasSocat, hasPodman: inspection.hasPodman };

      // socat is the relay. Without it the socket is reachable in principle and
      // not in practice — but it is still reported, because "there is an engine
      // in here that I cannot reach" is the single most useful thing boxwarden
      // can say on a Windows machine, and it used to go only to the console.
      if (!inspection.hasSocat) return base;

      if (inspection.socketPath !== undefined) {
        return { ...base, socketPath: inspection.socketPath };
      }

      if (!inspection.hasPodman) return base;

      const started = await startPodmanService(distro, inspection.uid);
      return started === undefined ? base : { ...base, socketPath: started };
    }),
  );

  const sockets = reports.flatMap((report): WslSocket[] =>
    report.socketPath === undefined
      ? []
      : [
          {
            distro: report.distro,
            socketPath: report.socketPath,
            runtime: runtimeFromSocketPath(report.socketPath),
          },
        ],
  );

  return { status: { kind: 'ready', distros: reports }, sockets };
}

/**
 * A byte stream to a socket inside a distro, shaped like a net.Socket enough for
 * http.Agent to use it.
 *
 * One relay per connection is not a design flourish — socat connects a single
 * unix socket to a single stdio pair, so multiplexing would mean writing a
 * framing protocol. HTTP connections here are short and few (a version call and
 * a list per refresh), so a process per connection is affordable.
 */
export function createWslConnection(distro: string, socketPath: string): Duplex {
  const child = spawn(
    'wsl.exe',
    ['-d', distro, '--', 'socat', 'STDIO', `UNIX-CONNECT:${socketPath}`],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );

  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    relay.push(null);
  };

  const relay = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      child.stdin.write(chunk, (error) => {
        callback(error ?? null);
      });
    },
    final(callback) {
      child.stdin.end(() => {
        callback();
      });
    },
    destroy(error, callback) {
      if (child.exitCode === null && !child.killed) child.kill();
      callback(error);
    },
  });

  child.stdout.on('data', (chunk: Buffer) => {
    if (!relay.push(chunk)) child.stdout.pause();
  });
  child.stdout.on('end', end);
  child.on('close', end);
  child.on('error', (error) => relay.destroy(error));

  // socat writes its diagnostics here — "No such file or directory" when the
  // socket is gone, for instance. Surfaced rather than dropped, because the
  // alternative symptom is an unexplained "socket hang up" from the HTTP layer.
  child.stderr.on('data', (chunk: Buffer) => {
    console.warn(`[boxwarden] socat (${distro}): ${chunk.toString('utf8').trim()}`);
  });

  // http.Agent calls net.Socket methods on whatever createConnection returns. A
  // plain Duplex has none of them, and their absence surfaces as a TypeError
  // mid-request rather than a clean failure. They are no-ops here because the
  // relay child is what holds the connection open — killing it is the only
  // thing that actually closes this.
  return Object.assign(relay, {
    setKeepAlive: () => relay,
    setNoDelay: () => relay,
    setTimeout: () => relay,
    unref: () => relay,
    ref: () => relay,
  });
}

/** Stop every service this process started. Called on app quit. */
export function shutdownWslServices(): void {
  for (const [distro, child] of managedServices) {
    if (child.exitCode === null && !child.killed) child.kill();
    managedServices.delete(distro);
  }
}
