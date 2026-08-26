import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BinaryDiscovery, DockerCliProbe } from '../../models/index.js';
import { resolveBinary } from '../discovery/resolve.js';

/**
 * Where the `devcontainer` binary (@devcontainers/cli) lives on this machine.
 *
 * The same question editors and terminal emulators ask, answered by the same
 * machinery — a strategy table into `resolveBinary`. PATH first, because an
 * npm/bun global install puts it there and is unambiguous when it does; the
 * well-known directories cover the shells that skip profile files (the GUI
 * app on macOS is launched by launchd, whose PATH has never heard of
 * `~/.bun/bin`).
 *
 * On Windows the npm shim is `devcontainer.cmd`, which Node refuses to spawn
 * without a shell — the same CVE-2024-27980 rule that keeps `code.cmd` out of
 * editor resolution. So resolution honestly fails there today, the buttons it
 * gates say so, and the Copy button stays the Windows path. See
 * `WINDOWS_SPAWNABLE_EXTENSIONS` in discovery/resolve.ts before "fixing" it.
 */
const DEVCONTAINER_DISCOVERY: readonly BinaryDiscovery[] = [
  { kind: 'path-lookup', command: 'devcontainer' },
  {
    kind: 'well-known-dir',
    paths: [
      '/usr/local/bin/devcontainer',
      '/opt/homebrew/bin/devcontainer',
      '/usr/bin/devcontainer',
    ],
  },
];

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 5_000;

/** `devcontainer --version` prints a bare semver line, e.g. `0.88.0`. */
export function parseDevcontainerVersion(stdout: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return /^\d+\.\d+\.\d+/.test(line) ? line : undefined;
}

/**
 * How long a probe result is trusted before asking again.
 *
 * Discovery polls every five seconds, and `devcontainer --version` boots a
 * Node process — spinning one up twelve times a minute to learn a fact that
 * changes when somebody runs an installer is the poll paying for nothing.
 * Sixty seconds keeps a fresh install noticed within a minute, which is the
 * cadence the ssh-agent probe already set for this kind of fact.
 */
const CACHE_TTL_MS = 60_000;

let cache: { readonly at: number; readonly probe: DockerCliProbe } | undefined;

export async function probeDevcontainerCli(now: number = Date.now()): Promise<DockerCliProbe> {
  if (cache !== undefined && now - cache.at < CACHE_TTL_MS) return cache.probe;
  const probe = await probeUncached();
  cache = { at: now, probe };
  return probe;
}

/** Tests only: the cache is module state, and a suite must not order-depend. */
export function resetDevcontainerCliCache(): void {
  cache = undefined;
}

async function probeUncached(): Promise<DockerCliProbe> {
  const found = await resolveBinary(DEVCONTAINER_DISCOVERY);
  if (!found.ok) {
    return { ok: false, code: found.code === 'not-executable' ? 'not-executable' : 'not-on-path' };
  }

  try {
    const { stdout } = await execFileAsync(found.binaryPath, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
    });
    const version = parseDevcontainerVersion(stdout);
    if (version === undefined) {
      return { ok: false, code: 'unparseable-version', detail: stdout.trim().slice(0, 200) };
    }
    return { ok: true, binaryPath: found.binaryPath, version };
  } catch (error) {
    return {
      ok: false,
      code: 'not-executable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
