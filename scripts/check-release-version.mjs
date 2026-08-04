#!/usr/bin/env node
/**
 * The preflight for a release: does the tag that triggered this run actually
 * describe the thing that is about to be built?
 *
 * electron-builder takes the version from package.json and nothing else. The
 * git tag is what the release is named after, and what people will `git
 * checkout` to reproduce a build. Nothing keeps the two in step, and the
 * failure is silent in the worst direction: tag v0.2.0, ship
 * `boxwarden-0.1.0.dmg`, and every later bug report cites a version that does
 * not match the code. A tag cannot be moved once it is public, so this has to
 * fail BEFORE three platforms spend ten minutes each building the wrong
 * number.
 *
 * The second check is `0.0.0`, the placeholder this repo carried through its
 * whole MVP. It is a valid semver string, so a tag-match check alone would
 * wave through `v0.0.0` — and `boxwarden-0.0.0.AppImage` is indistinguishable
 * from every unpublished local build already sitting in someone's release/.
 *
 * Usage:
 *   node scripts/check-release-version.mjs v0.1.0   # tag push: both checks
 *   node scripts/check-release-version.mjs          # dry run: version only
 *
 * With no argument it falls back to GITHUB_REF_NAME when that names a tag, so
 * the workflow does not have to plumb the tag through twice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Semver, deliberately strict. electron-builder rejects anything it cannot
 * parse, and a tag like `v1.0` would otherwise reach it as a build failure
 * halfway through the matrix instead of a sentence here.
 */
const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The pure core. `tag` is undefined for a dry run, where there is no tag to
 * agree with and only the version itself can be judged.
 *
 * @param {{ version: unknown, tag?: string | undefined }} input
 * @returns {{ ok: boolean, checks: { label: string, ok: boolean, detail?: string }[] }}
 */
export function checkReleaseVersion({ version, tag }) {
  const checks = [];
  const check = (label, ok, detail) => {
    checks.push(detail === undefined ? { label, ok } : { label, ok, detail });
  };

  const parsed = typeof version === 'string' ? SEMVER.exec(version) : null;
  check(
    'package.json version is valid semver',
    Boolean(parsed),
    typeof version === 'string' ? `got ${version || '(empty)'}` : `got ${typeof version}`,
  );

  check(
    'package.json version is not the 0.0.0 placeholder',
    version !== '0.0.0',
    'bump it before tagging — 0.0.0 is what every local build is already called',
  );

  if (tag !== undefined) {
    check(
      `tag matches package.json (expected v${String(version)})`,
      tag === `v${String(version)}`,
      `got ${tag}`,
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * A prerelease version (`1.0.0-rc.1`) is what marks a GitHub release as a
 * prerelease. Exported so the workflow reads the same rule the check does,
 * rather than re-implementing "does it contain a hyphen" in YAML.
 *
 * @param {string} version
 */
export function isPrerelease(version) {
  return SEMVER.exec(version)?.groups?.prerelease !== undefined;
}

/**
 * The tag this run is for, or undefined when there is not one. A
 * `workflow_dispatch` run on a branch sets GITHUB_REF_NAME to the branch, so
 * GITHUB_REF_TYPE is what distinguishes the two.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function tagFrom(argv, env) {
  const explicit = argv.find((arg) => !arg.startsWith('-'));
  if (explicit !== undefined) return explicit;
  if (env['GITHUB_REF_TYPE'] === 'tag') return env['GITHUB_REF_NAME'];
  return undefined;
}

// The shell. Skipped when this file is imported by its test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  const tag = tagFrom(process.argv.slice(2), process.env);

  const { ok, checks } = checkReleaseVersion({ version, tag });
  for (const c of checks) {
    console.log(
      `${c.ok ? 'ok  ' : 'FAIL'}  ${c.label}${!c.ok && c.detail ? `  (${c.detail})` : ''}`,
    );
  }

  if (!ok) {
    console.error(
      '\nRefusing to release. See docs/releasing.md — the version in package.json is the' +
        ' one electron-builder stamps on every artefact, and the tag is the only thing' +
        ' pointing at the commit that produced them.',
    );
    process.exit(1);
  }
  console.log(`\nReleasing ${String(version)}${isPrerelease(version) ? ' (prerelease)' : ''}.`);
}
