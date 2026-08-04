/**
 * Covers scripts/check-release-version.mjs, the gate between a tag and three
 * platform builds.
 *
 * Worth a test even though the script is twenty lines of logic: it is the one
 * piece of the release that runs when nobody is watching, its failure mode is
 * a published artefact carrying the wrong number, and a published tag cannot
 * be taken back. The pure core takes the version and the tag as arguments for
 * exactly this reason — no filesystem, no environment.
 */
import { describe, expect, it } from 'vitest';
import { checkReleaseVersion, isPrerelease, tagFrom } from './check-release-version.mjs';

/** The labels of the checks that failed, which is what the script prints. */
const failures = (result) => result.checks.filter((c) => !c.ok).map((c) => c.label);

describe('checkReleaseVersion', () => {
  it('passes when the tag is the version with a v', () => {
    expect(checkReleaseVersion({ version: '0.1.0', tag: 'v0.1.0' }).ok).toBe(true);
  });

  it('passes a prerelease tag', () => {
    expect(checkReleaseVersion({ version: '1.0.0-rc.1', tag: 'v1.0.0-rc.1' }).ok).toBe(true);
  });

  it('fails when the tag names a different version', () => {
    const result = checkReleaseVersion({ version: '0.1.0', tag: 'v0.2.0' });
    expect(result.ok).toBe(false);
    expect(failures(result)).toEqual(['tag matches package.json (expected v0.1.0)']);
  });

  // The near-miss the check exists for: a tag that looks right at a glance.
  it('fails a tag without the v prefix', () => {
    expect(checkReleaseVersion({ version: '0.1.0', tag: '0.1.0' }).ok).toBe(false);
  });

  it('fails the 0.0.0 placeholder even when the tag agrees with it', () => {
    const result = checkReleaseVersion({ version: '0.0.0', tag: 'v0.0.0' });
    expect(result.ok).toBe(false);
    expect(failures(result)).toEqual(['package.json version is not the 0.0.0 placeholder']);
  });

  it.each(['1.0', 'v1.0.0', '', '1.0.0.0', 'latest'])('rejects %o as a version', (version) => {
    expect(checkReleaseVersion({ version }).ok).toBe(false);
  });

  it('rejects a missing version rather than stringifying undefined', () => {
    const result = checkReleaseVersion({ version: undefined });
    expect(result.ok).toBe(false);
    expect(failures(result)).toContain('package.json version is valid semver');
  });

  // A dry run has no tag to agree with. It must still catch the placeholder,
  // which is the whole point of exercising the pipeline before a real tag.
  it('checks the version but not the tag when there is no tag', () => {
    expect(checkReleaseVersion({ version: '0.1.0' }).ok).toBe(true);
    expect(checkReleaseVersion({ version: '0.1.0' }).checks).toHaveLength(2);
    expect(checkReleaseVersion({ version: '0.0.0' }).ok).toBe(false);
  });
});

describe('isPrerelease', () => {
  it.each(['1.0.0-rc.1', '0.2.0-beta', '1.0.0-0'])('%s is a prerelease', (version) => {
    expect(isPrerelease(version)).toBe(true);
  });

  it.each(['1.0.0', '0.1.0', '1.0.0+build.5'])('%s is not', (version) => {
    expect(isPrerelease(version)).toBe(false);
  });
});

describe('tagFrom', () => {
  it('prefers an explicit argument', () => {
    expect(tagFrom(['v0.1.0'], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' })).toBe(
      'v0.1.0',
    );
  });

  it('falls back to GITHUB_REF_NAME on a tag push', () => {
    expect(tagFrom([], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.0' })).toBe('v0.1.0');
  });

  // The dry-run case. A workflow_dispatch on a branch sets GITHUB_REF_NAME to
  // the branch name; reading it blindly would compare the version against
  // "main" and fail every dry run.
  it('is undefined when the ref is a branch', () => {
    expect(tagFrom([], { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' })).toBeUndefined();
  });

  it('is undefined outside CI', () => {
    expect(tagFrom([], {})).toBeUndefined();
  });

  it('ignores flags when looking for the tag', () => {
    expect(tagFrom(['--verbose', 'v0.1.0'], {})).toBe('v0.1.0');
  });
});
