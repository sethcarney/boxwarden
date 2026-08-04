import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type { BinaryDiscovery, ResolvedBinary } from '../../models/index.js';

/**
 * Find a program on this machine, given an ordered list of strategies.
 *
 * The impure edge (fs, execFile) around a data table. Editors and terminal
 * emulators both need it and neither wants to know how the other looks things
 * up, so it lives here rather than inside `editor/`.
 */

const execFileAsync = promisify(execFile);

const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * The only extensions Windows can execute WITHOUT a shell.
 *
 * `.cmd` and `.bat` are conspicuously absent, and their absence is the whole
 * point. Node refuses to spawn them unless `shell: true` (a deliberate fix for
 * CVE-2024-27980, where a batch file's arguments could break out into cmd.exe),
 * and `shell: true` is exactly what the launchers must never do — the editor
 * URI carries a hex-encoded path originating from a container label, and the
 * terminal command carries a user-authored startup command. Treating a `.cmd`
 * as a valid resolution just moves the failure to the launch, where it surfaces
 * as a bare "spawn EINVAL".
 */
const WINDOWS_SPAWNABLE_EXTENSIONS = ['.exe', '.com'];

export function isSpawnableOnWindows(path: string): boolean {
  const lower = path.toLowerCase();
  return WINDOWS_SPAWNABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * On POSIX the executable bit means something. On Windows it does not:
 * `access(X_OK)` succeeds for ANY file that exists, including a text file, so
 * the extension is the only signal available.
 *
 * Without this, `\...\Microsoft VS Code\bin\code` — the extensionless bash
 * script shipped for Git Bash users — passes as executable and then fails at
 * spawn with ENOENT, a message that sends the user looking for a missing file
 * that is right there.
 */
async function isExecutable(path: string, os: NodeJS.Platform): Promise<boolean> {
  if (os === 'win32' && !isSpawnableOnWindows(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand `%VAR%` references in a Windows path. A path referring to a variable
 * that is not set yields undefined rather than a half-expanded string, which
 * would otherwise be probed as a literal filename.
 */
export function expandWindowsPath(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  // split() on a capturing pattern interleaves literals and variable names:
  // even indices are literal text, odd indices are the captured names. Building
  // the result this way rather than with a replace callback keeps the
  // "something was missing" answer a return value instead of a mutable flag the
  // callback has to reach out and set.
  const parts = path.split(/%([^%]+)%/);
  const out: string[] = [];

  for (const [index, part] of parts.entries()) {
    if (index % 2 === 0) {
      out.push(part);
      continue;
    }
    const value = env[part];
    if (value === undefined || value === '') return undefined;
    out.push(value);
  }

  return out.join('');
}

/**
 * `which` on POSIX, `where` on Windows. Both are exec'd with an argv array and
 * no shell, so a command name containing shell metacharacters is inert rather
 * than interesting.
 *
 * `where` returns EVERY match, and on Windows the first is routinely the wrong
 * one: VS Code ships `bin\code` (a bash script) ahead of `bin\code.cmd`, and
 * neither can be spawned directly. Filtering to what Windows can actually
 * execute usually leaves nothing, which is correct — resolution then falls
 * through to the well-known `.exe` locations in the target table.
 */
async function pathLookup(command: string, os: NodeJS.Platform): Promise<string | undefined> {
  const finder = os === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(finder, [command], { timeout: LOOKUP_TIMEOUT_MS });
    const matches = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return os === 'win32' ? matches.find(isSpawnableOnWindows) : matches[0];
  } catch {
    return undefined;
  }
}

/**
 * Locate a macOS app bundle by identifier and return the executable inside it.
 *
 * mdfind rather than a hardcoded /Applications path because plenty of people
 * keep apps in ~/Applications or a managed directory. It depends on Spotlight
 * being enabled, which is why this is one strategy among several rather than
 * the only one.
 */
async function macosBundle(bundleId: string, cliRelativePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: LOOKUP_TIMEOUT_MS },
    );
    for (const line of stdout.split('\n')) {
      const bundlePath = line.trim();
      if (bundlePath === '') continue;
      const cli = join(bundlePath, cliRelativePath);
      // 'darwin' literally: tryStrategy only reaches this branch on macOS.
      if (await isExecutable(cli, 'darwin')) return cli;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function tryStrategy(
  strategy: BinaryDiscovery,
  os: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  switch (strategy.kind) {
    case 'explicit-path':
      return (await isExecutable(strategy.binaryPath, os)) ? strategy.binaryPath : undefined;

    case 'path-lookup': {
      const found = await pathLookup(strategy.command, os);
      return found !== undefined && (await isExecutable(found, os)) ? found : undefined;
    }

    case 'macos-bundle':
      // Skipped rather than attempted off-macOS: mdfind does not exist there,
      // and spawning it to fail costs a process per target per probe.
      if (os !== 'darwin') return undefined;
      return macosBundle(strategy.bundleId, strategy.cliRelativePath);

    case 'well-known-dir':
      for (const candidate of strategy.paths) {
        // Windows entries carry %LOCALAPPDATA% / %ProgramFiles% references;
        // POSIX ones have no % in them and pass through untouched.
        const path = candidate.includes('%') ? expandWindowsPath(candidate, env) : candidate;
        if (path !== undefined && (await isExecutable(path, os))) return path;
      }
      return undefined;
  }
}

/** First strategy that hits wins; the winning strategy is reported for diagnostics. */
export async function resolveBinary(
  discovery: readonly BinaryDiscovery[],
  os: NodeJS.Platform = platform(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedBinary> {
  for (const strategy of discovery) {
    const binaryPath = await tryStrategy(strategy, os, env);
    if (binaryPath !== undefined) {
      return { ok: true, binaryPath, via: strategy.kind };
    }
  }
  return { ok: false, code: 'not-found' };
}
