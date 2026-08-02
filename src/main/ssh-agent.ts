import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SshAgentHostProbe, WindowsAgentService } from '../models/index.js';

const execFileAsync = promisify(execFile);

/**
 * Looking for an SSH agent on THIS machine — the impure shell around
 * `adviseSshAgent` in src/models/advice.ts.
 *
 * Same split as everywhere else in this app: this module decides nothing, it
 * only reports what it saw. Which state of disrepair a machine is in is not
 * something a test suite can arrange (nobody can produce "Windows with the
 * ssh-agent service disabled" on demand), but constructing the record that
 * describes it is trivial — so every judgement lives on the pure side.
 */

/** Long enough for a cold PowerShell start, short enough not to stall a scan. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Discovery polls every 5 seconds and this probe spawns PowerShell on Windows.
 * Spawning a shell six times a minute forever to re-answer a question that
 * changes when somebody runs a service command is not a reasonable thing for a
 * background poll to do, so the answer is cached.
 *
 * 30 seconds is chosen from the other side: a user who has just followed the
 * advisory's instructions should watch it disappear on its own, not wonder
 * whether the app noticed. Long enough to stop the spawning, short enough to
 * feel like it is paying attention.
 */
const CACHE_TTL_MS = 30_000;

let cached: { readonly at: number; readonly value: SshAgentHostProbe } | undefined;

/**
 * Is boxwarden itself running inside a container?
 *
 * `bun run devcontainer:open` runs it with docker-outside-of-docker, so it
 * talks to the HOST's daemon and lists the developer's real containers while
 * `process.env` and every path it can stat belong to the container. Advice
 * derived from those would be describing the wrong machine, which is worse
 * than no advice — it would be confidently wrong about something the user
 * cannot easily check.
 *
 * Checked by file rather than by environment variable alone because the
 * variables are set by whoever launched the shell and are routinely absent
 * when an app is started some other way; `/.dockerenv` and `/run/.containerenv`
 * are written by the runtime itself.
 */
async function runningInContainer(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env['REMOTE_CONTAINERS'] !== undefined || env['CODESPACES'] !== undefined) return true;
  for (const marker of ['/.dockerenv', '/run/.containerenv']) {
    if (await exists(marker)) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The OpenSSH `ssh-agent` service, via PowerShell.
 *
 * `execFile` with an argv array and never `shell: true` — the same rule as
 * `editor/launch.ts`. Nothing here is attacker-influenced today, but a spawn
 * that goes through a shell is a spawn somebody will later pass a variable to.
 *
 * `-NoProfile` because a user profile can print banners, change the working
 * directory, or take seconds to load, and this parses stdout.
 */
async function probeWindowsService(): Promise<WindowsAgentService> {
  const script =
    '$s = Get-Service ssh-agent -ErrorAction SilentlyContinue; ' +
    'if ($null -eq $s) { \'missing\' } else { "$($s.Status)|$($s.StartType)" }';

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    );
    return parseServiceState(stdout);
  } catch {
    // No PowerShell, a policy that blocks it, a timeout — all the same answer.
    // "We could not tell" produces no advisory, which is the right outcome:
    // guessing here would put a warning on a machine that is fine.
    return 'unknown';
  }
}

/** `"Running|Automatic"` -> the state that names the fix. Exported for its test. */
export function parseServiceState(stdout: string): WindowsAgentService {
  const [status = '', startType = ''] = stdout.trim().toLowerCase().split('|');

  // Running wins over a Disabled start type. Both can be true at once — a
  // service someone started by hand without changing how it boots — and in
  // that moment nothing is broken. The reboot problem is real, but it is not
  // what the user is looking at.
  if (status === 'running') return 'running';
  if (startType === 'disabled') return 'disabled';
  if (status === 'stopped' || status === 'stopping' || status === 'paused') return 'stopped';
  return 'unknown';
}

async function probe(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<SshAgentHostProbe> {
  const inContainer = await runningInContainer(env);

  if (platform === 'win32') {
    // SSH_AUTH_SOCK is a POSIX convention; Windows OpenSSH uses a named pipe
    // and the service is the only thing worth asking about.
    return { service: await probeWindowsService(), inContainer };
  }

  const authSock = env['SSH_AUTH_SOCK'];
  if (authSock === undefined || authSock === '') return { inContainer };
  return { authSock, authSockExists: await exists(authSock), inContainer };
}

/**
 * The cached probe. Every caller gets this one rather than `probe` directly.
 *
 * `platform` and `env` are parameters rather than reads of the globals, the
 * same way `candidateEndpoints` takes them — a function that reaches for
 * `process.platform` inside cannot be asked about any machine but this one.
 * The cache is keyed on time ALONE and ignores both, which is correct for the
 * single production caller and worth knowing before writing a test that varies
 * them: pass a `now` past the TTL to force a fresh read.
 */
export async function probeSshAgent(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<SshAgentHostProbe> {
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await probe(platform, env);
  cached = { at: now, value };
  return value;
}
