import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type { EditorDiscovery, EditorTarget, ResolvedEditor } from '../../domain/index.js';

const execFileAsync = promisify(execFile);

const LOOKUP_TIMEOUT_MS = 2_000;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `which` on POSIX, `where` on Windows. Both are exec'd with an argv array and
 * no shell, so a command name containing shell metacharacters is inert rather
 * than interesting.
 */
async function pathLookup(command: string, os: NodeJS.Platform): Promise<string | undefined> {
  const finder = os === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(finder, [command], { timeout: LOOKUP_TIMEOUT_MS });
    // `where` can return several lines; the first is the one that would run.
    const first = stdout.split(/\r?\n/).find((line) => line.trim() !== '');
    return first?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Locate a macOS app bundle by identifier and return the CLI inside it.
 *
 * mdfind rather than a hardcoded /Applications path because plenty of people
 * keep editors in ~/Applications or a managed directory. It depends on
 * Spotlight being enabled, which is why this is one strategy among several
 * rather than the only one.
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
      if (await isExecutable(cli)) return cli;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function tryStrategy(
  strategy: EditorDiscovery,
  os: NodeJS.Platform,
): Promise<string | undefined> {
  switch (strategy.kind) {
    case 'explicit-path':
      return (await isExecutable(strategy.binaryPath)) ? strategy.binaryPath : undefined;

    case 'path-lookup': {
      const found = await pathLookup(strategy.command, os);
      return found !== undefined && (await isExecutable(found)) ? found : undefined;
    }

    case 'macos-bundle':
      // Skipped rather than attempted off-macOS: mdfind does not exist there,
      // and spawning it to fail costs a process per editor per probe.
      if (os !== 'darwin') return undefined;
      return macosBundle(strategy.bundleId, strategy.cliRelativePath);

    case 'well-known-dir':
      for (const path of strategy.paths) {
        if (await isExecutable(path)) return path;
      }
      return undefined;
  }
}

/** First strategy that hits wins; the winning strategy is reported for diagnostics. */
export async function resolveEditor(
  target: EditorTarget,
  os: NodeJS.Platform = platform(),
): Promise<ResolvedEditor> {
  for (const strategy of target.discovery) {
    const binaryPath = await tryStrategy(strategy, os);
    if (binaryPath !== undefined) {
      return { ok: true, target, binaryPath, via: strategy.kind };
    }
  }
  return { ok: false, target, code: 'not-found' };
}
