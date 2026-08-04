import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickAsset, safeAssetFileName } from '../../models/index.js';
import type { ReleaseAsset } from '../../models/index.js';

/**
 * The artefact filenames are an interface, and this is the only thing that
 * checks it.
 *
 * `electron-builder.yml` decides what the installers are called;
 * `pickAsset` in src/models/update.ts decides which one this machine needs, and
 * `safeAssetFileName` in src/models/download.ts decides whether it can be
 * written to disk at all. Those three live in different files, in different
 * languages, and nothing links them — so a rename in the build config is a
 * change that compiles, passes every other test, and then produces a release
 * whose update the app silently refuses.
 *
 * Deliberately impure: it reads `electron-builder.yml` off disk. The rule in
 * CLAUDE.md is "no daemon and no display", not "no filesystem" — the same
 * licence `projects/scan.test.ts` takes — and a cross-file interface that no
 * single file can see is exactly the case that earns it.
 *
 * The macro expansion below is the same one electron-builder does. It only has
 * to be right about the four macros this repo actually uses.
 */

const CONFIG = fileURLToPath(new URL('../../../electron-builder.yml', import.meta.url));

/**
 * The `artifactName` under a top-level target block.
 *
 * A scan rather than a YAML parse, so this test adds no dependency to check a
 * dependency-free config. It finds the block by its unindented key and takes
 * the first indented `artifactName` before the next unindented one.
 */
function artifactNameFor(target: string): string | undefined {
  const lines = readFileSync(CONFIG, 'utf8').split('\n');
  let inside = false;

  for (const line of lines) {
    if (/^\S/.test(line)) inside = line.startsWith(`${target}:`);
    else if (inside) {
      const match = /^\s+artifactName:\s*(\S.*?)\s*$/.exec(line);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  return undefined;
}

function expand(template: string, arch: string): string {
  return template
    .replaceAll('${productName}', 'boxwarden')
    .replaceAll('${version}', '1.2.0')
    .replaceAll('${arch}', arch)
    .replaceAll('${ext}', 'exe');
}

function asset(name: string): ReleaseAsset {
  return { name, url: `https://github.com/sethcarney/boxwarden/releases/download/v1.2.0/${name}` };
}

describe('the NSIS artefact name', () => {
  const template = artifactNameFor('nsis');

  /**
   * electron-builder's default is `${productName} Setup ${version}.${ext}`,
   * which has spaces in it. `safeAssetFileName` refuses spaces, so leaving the
   * default in place would mean Windows could never use the verified download —
   * and the symptom would be a missing button, not an error.
   */
  it('is set explicitly, rather than left as the spaced default', () => {
    expect(template).toBeDefined();
    expect(template).not.toContain(' ');
  });

  it('produces a name the downloader will write to disk', () => {
    for (const arch of ['x64', 'arm64']) {
      const name = expand(template ?? '', arch);
      expect(safeAssetFileName(name), name).toBe(name);
    }
  });

  /**
   * The match has to be unambiguous in BOTH directions: each architecture picks
   * its own file, and neither name accidentally contains the other's token.
   * `arm64` containing `64` is the near-miss this guards — an x64 token list
   * that included a bare `64` would match both and `pickAsset` would correctly
   * refuse to guess, leaving Windows with no download at all.
   */
  it('lets pickAsset choose exactly one installer per architecture', () => {
    const assets = ['x64', 'arm64'].map((arch) => asset(expand(template ?? '', arch)));

    expect(pickAsset(assets, 'nsis', 'x64')?.name).toBe(expand(template ?? '', 'x64'));
    expect(pickAsset(assets, 'nsis', 'arm64')?.name).toBe(expand(template ?? '', 'arm64'));
  });
});
