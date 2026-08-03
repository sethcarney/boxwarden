import { describe, expect, it } from 'vitest';
import {
  RELEASE_URL_PREFIX,
  compareVersions,
  detectInstallKind,
  foldUpdateStatus,
  isCheckDue,
  isNewerVersion,
  normaliseVersion,
  parseRelease,
  parseStoredRelease,
  parseUpdatePreferences,
  parseVersion,
  pickAsset,
  updateInstructions,
  type Release,
  type ReleaseAsset,
} from './update.js';

/**
 * The two halves of this file are the two ways an update prompt goes wrong.
 *
 * Getting the COMPARISON wrong nags people who are already current, or —
 * worse — stays quiet for the person on the version with the bug. Getting the
 * ASSET wrong sends an arm64 Mac to an x64 dmg and a deb user to an AppImage.
 * Both are pure decisions, so both are unit tests rather than a release
 * somebody has to publish to find out.
 */

const RELEASE_PAGE = `${RELEASE_URL_PREFIX}tag/v1.2.0`;
const DOWNLOAD = `${RELEASE_URL_PREFIX}download/v1.2.0`;

function asset(name: string): ReleaseAsset {
  return { name, url: `${DOWNLOAD}/${name}` };
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    version: '1.2.0',
    tag: 'v1.2.0',
    url: RELEASE_PAGE,
    assets: [],
    ...overrides,
  };
}

describe('parseVersion', () => {
  it('accepts the tag spelling and the package.json spelling as the same version', () => {
    expect(parseVersion('v1.2.3')).toEqual(parseVersion('1.2.3'));
    expect(normaliseVersion('v1.2.3')).toBe('1.2.3');
  });

  it('keeps the prerelease identifiers', () => {
    expect(parseVersion('1.0.0-rc.2')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['rc', '2'],
    });
  });

  it('discards build metadata, which takes no part in precedence', () => {
    expect(parseVersion('1.0.0+sha.abc')).toEqual(parseVersion('1.0.0'));
  });

  it.each(['', 'latest', '1.2', 'v1.2.3.4', '1.2.3-', 'nightly-1.2.3'])(
    'refuses %o rather than inventing a number',
    (raw) => {
      expect(parseVersion(raw)).toBeUndefined();
    },
  );
});

describe('compareVersions', () => {
  const order = (a: string, b: string): number =>
    compareVersions(parseVersion(a) ?? never(a), parseVersion(b) ?? never(b));

  function never(raw: string): never {
    throw new Error(`fixture is not a version: ${raw}`);
  }

  it('orders by major, then minor, then patch', () => {
    expect(order('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(order('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(order('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(order('1.2.3', '1.2.3')).toBe(0);
  });

  it('sorts a prerelease BELOW the release it leads to', () => {
    // The one that matters: if this came out the other way, everybody on the
    // final 1.2.0 would be prompted to "update" to the candidate it replaced.
    expect(order('1.2.0-rc.1', '1.2.0')).toBeLessThan(0);
    expect(order('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0);
  });

  it('compares numeric prerelease identifiers as numbers, not as text', () => {
    expect(order('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0);
  });

  it('sorts a numeric identifier below an alphanumeric one, and a longer set above its prefix', () => {
    expect(order('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(order('1.0.0-alpha.1', '1.0.0-alpha')).toBeGreaterThan(0);
  });
});

describe('isNewerVersion', () => {
  it('is true only for a strictly higher version', () => {
    expect(isNewerVersion('1.2.1', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.1.9', '1.2.0')).toBe(false);
  });

  it('stays quiet when either side is not a version', () => {
    // 0.0.0 parses and is the placeholder every development build carries;
    // what must not happen is a comparison against something unparseable
    // producing a prompt nobody can act on.
    expect(isNewerVersion('1.2.0', 'dev')).toBe(false);
    expect(isNewerVersion('nightly', '1.2.0')).toBe(false);
  });
});

describe('parseRelease', () => {
  const payload = {
    tag_name: 'v1.2.0',
    html_url: RELEASE_PAGE,
    published_at: '2026-08-01T09:30:00Z',
    draft: false,
    prerelease: false,
    assets: [{ name: 'boxwarden-1.2.0.dmg', browser_download_url: `${DOWNLOAD}/x.dmg`, size: 91 }],
  };

  it('narrows the payload to the fields the app uses', () => {
    expect(parseRelease(payload)).toEqual({
      version: '1.2.0',
      tag: 'v1.2.0',
      url: RELEASE_PAGE,
      publishedAt: new Date('2026-08-01T09:30:00Z'),
      assets: [{ name: 'boxwarden-1.2.0.dmg', url: `${DOWNLOAD}/x.dmg`, size: 91 }],
    });
  });

  it('refuses a draft or a prerelease', () => {
    expect(parseRelease({ ...payload, draft: true })).toBeUndefined();
    expect(parseRelease({ ...payload, prerelease: true })).toBeUndefined();
  });

  it.each([
    'https://github.com/someone-else/malware/releases/tag/v9',
    'https://github.com.evil.test/sethcarney/boxwarden/releases/tag/v9',
    'https://github.com@evil.test/sethcarney/boxwarden/releases/tag/v9',
    'http://github.com/sethcarney/boxwarden/releases/tag/v9',
  ])('refuses a release page at %o', (html_url) => {
    // shell.openExternal only checks the ORIGIN, so github.com is not a
    // sufficient check on a URL that arrived over the network — this is.
    expect(parseRelease({ ...payload, html_url })).toBeUndefined();
  });

  it('drops an asset whose download URL is not ours, and keeps the rest', () => {
    const parsed = parseRelease({
      ...payload,
      assets: [
        { name: 'evil.dmg', browser_download_url: 'https://evil.test/evil.dmg' },
        { name: 'boxwarden-1.2.0.dmg', browser_download_url: `${DOWNLOAD}/x.dmg` },
        { name: '', browser_download_url: `${DOWNLOAD}/y.dmg` },
        'not an object',
      ],
    });

    expect(parsed?.assets.map((entry) => entry.name)).toEqual(['boxwarden-1.2.0.dmg']);
  });

  it.each([undefined, null, 'a string', [], { tag_name: 'latest', html_url: RELEASE_PAGE }])(
    'answers undefined for %o rather than a half-built release',
    (raw) => {
      expect(parseRelease(raw)).toBeUndefined();
    },
  );

  it('survives a release with no assets and no published date', () => {
    const parsed = parseRelease({ tag_name: 'v1.2.0', html_url: RELEASE_PAGE });
    expect(parsed).toEqual({ version: '1.2.0', tag: 'v1.2.0', url: RELEASE_PAGE, assets: [] });
  });
});

describe('parseStoredRelease', () => {
  it('round-trips a release through the shape JSON.stringify writes', () => {
    const original = release({
      publishedAt: new Date('2026-08-01T09:30:00Z'),
      assets: [{ ...asset('boxwarden_1.2.0_amd64.deb'), size: 91 }],
    });

    // Exactly what preferences.json holds after savePreferences.
    const stored: unknown = JSON.parse(JSON.stringify(original));

    expect(parseStoredRelease(stored)).toEqual(original);
  });

  it('holds a URL out of the preferences file to the same rule as one off the network', () => {
    // The file is on disk and anything on the machine can write it, so a link
    // out of it is no more trusted than a link out of an HTTP response.
    const forged = { tag: 'v9.9.9', url: 'https://evil.test/releases/tag/v9.9.9', assets: [] };
    expect(parseStoredRelease(forged)).toBeUndefined();
  });

  it('is undefined for the shapes an older preferences file has', () => {
    expect(parseStoredRelease(undefined)).toBeUndefined();
    expect(parseStoredRelease({ version: '1.2.0' })).toBeUndefined();
  });
});

describe('detectInstallKind', () => {
  it('reads the AppImage runtime marker rather than inferring from the platform', () => {
    expect(
      detectInstallKind(
        'linux',
        { APPIMAGE: '/home/dev/boxwarden.AppImage' },
        '/tmp/.mount/boxwarden',
      ),
    ).toBe('appimage');
  });

  it('reads a system prefix as the deb', () => {
    expect(detectInstallKind('linux', {}, '/opt/boxwarden/boxwarden')).toBe('deb');
    expect(detectInstallKind('linux', {}, '/usr/lib/boxwarden/boxwarden')).toBe('deb');
  });

  it('admits it does not know rather than guessing, for a Linux build run from anywhere else', () => {
    expect(
      detectInstallKind('linux', {}, '/home/dev/src/boxwarden/release/linux-unpacked/boxwarden'),
    ).toBe('linux-unknown');
    // An empty APPIMAGE is not a marker.
    expect(detectInstallKind('linux', { APPIMAGE: '' }, '/home/dev/x')).toBe('linux-unknown');
  });

  it('has one answer per desktop platform', () => {
    expect(detectInstallKind('darwin', {}, '/Applications/boxwarden.app/x')).toBe('dmg');
    expect(detectInstallKind('win32', {}, 'C:\\Users\\dev\\boxwarden.exe')).toBe('nsis');
    expect(detectInstallKind('freebsd', {}, '/usr/local/bin/boxwarden')).toBe('unknown');
  });
});

describe('pickAsset', () => {
  const MAC = [asset('boxwarden-1.2.0.dmg'), asset('boxwarden-1.2.0-arm64.dmg')];
  const LINUX = [
    asset('boxwarden-1.2.0.AppImage'),
    asset('boxwarden-1.2.0-arm64.AppImage'),
    asset('boxwarden_1.2.0_amd64.deb'),
    asset('boxwarden_1.2.0_arm64.deb'),
  ];

  it('names the architecture when the filename does', () => {
    expect(pickAsset(MAC, 'dmg', 'arm64')?.name).toBe('boxwarden-1.2.0-arm64.dmg');
  });

  it('reads an unmarked filename as the x64 build, which is what electron-builder means by it', () => {
    expect(pickAsset(MAC, 'dmg', 'x64')?.name).toBe('boxwarden-1.2.0.dmg');
  });

  it('matches the deb by its DEBIAN architecture, not by x64', () => {
    // The reason the token table exists: the x64 deb is `amd64` while the
    // AppImage beside it has no architecture in its name at all.
    expect(pickAsset(LINUX, 'deb', 'x64')?.name).toBe('boxwarden_1.2.0_amd64.deb');
    expect(pickAsset(LINUX, 'deb', 'arm64')?.name).toBe('boxwarden_1.2.0_arm64.deb');
    expect(pickAsset(LINUX, 'appimage', 'x64')?.name).toBe('boxwarden-1.2.0.AppImage');
  });

  it('takes the only candidate of the right kind without consulting the architecture', () => {
    expect(pickAsset([asset('boxwarden Setup 1.2.0.exe')], 'nsis', 'arm64')?.name).toBe(
      'boxwarden Setup 1.2.0.exe',
    );
  });

  it('answers undefined rather than guessing when nothing matches or too much does', () => {
    expect(pickAsset(MAC, 'dmg', 'ia32')).toBeUndefined();
    expect(pickAsset(MAC, 'deb', 'x64')).toBeUndefined();
    expect(pickAsset([], 'dmg', 'x64')).toBeUndefined();
    // Two unmarked candidates: which one is x64's is not knowable from here.
    expect(pickAsset([asset('a.dmg'), asset('b.dmg')], 'dmg', 'x64')).toBeUndefined();
  });

  it('has nothing to offer for an install kind it could not identify', () => {
    expect(pickAsset(LINUX, 'linux-unknown', 'x64')).toBeUndefined();
    expect(pickAsset(LINUX, 'unknown', 'x64')).toBeUndefined();
  });
});

describe('updateInstructions', () => {
  it('names the file in the command, so the user is not asked to fill in a blank', () => {
    expect(updateInstructions('deb', asset('boxwarden_1.2.0_amd64.deb')).commands).toEqual([
      'sudo apt install ./boxwarden_1.2.0_amd64.deb',
    ]);
    expect(updateInstructions('appimage', asset('boxwarden-1.2.0.AppImage')).commands).toEqual([
      'chmod +x boxwarden-1.2.0.AppImage',
    ]);
  });

  it('still gives a runnable shape when the asset could not be identified', () => {
    expect(updateInstructions('deb', undefined).commands[0]).toContain('sudo apt install');
  });

  it('warns about the gatekeeper each unsigned platform interposes with', () => {
    expect(updateInstructions('dmg', undefined).steps.join(' ')).toContain('Gatekeeper');
    expect(updateInstructions('nsis', undefined).steps.join(' ')).toContain('SmartScreen');
  });

  it('tells every install kind to quit first', () => {
    const kinds = ['dmg', 'nsis', 'appimage', 'deb', 'linux-unknown', 'unknown'] as const;
    for (const kind of kinds) {
      const instructions = updateInstructions(kind, undefined);
      expect(instructions.headline).not.toBe('');
      expect(instructions.steps[0]).toContain('Quit boxwarden');
    }
  });
});

describe('foldUpdateStatus', () => {
  const checkedAt = new Date('2026-08-03T12:00:00Z');
  const facts = {
    currentVersion: '1.1.0',
    installKind: 'deb',
    arch: 'x64',
    release: release({ assets: [asset('boxwarden_1.2.0_amd64.deb')] }),
  } as const;

  it('reports an available update with the file and the steps for this machine', () => {
    const status = foldUpdateStatus(facts, checkedAt);

    expect(status.currentVersion).toBe('1.1.0');
    expect(status.checkedAt).toBe(checkedAt);
    expect(status.outcome).toMatchObject({
      kind: 'available',
      asset: { name: 'boxwarden_1.2.0_amd64.deb' },
      dismissed: false,
    });
  });

  it('marks the version the user already said "not now" to, rather than hiding it', () => {
    const status = foldUpdateStatus({ ...facts, dismissedVersion: '1.2.0' }, checkedAt);
    expect(status.outcome).toMatchObject({ kind: 'available', dismissed: true });
  });

  it('does not carry a dismissal onto the NEXT release', () => {
    const status = foldUpdateStatus({ ...facts, dismissedVersion: '1.1.5' }, checkedAt);
    expect(status.outcome).toMatchObject({ kind: 'available', dismissed: false });
  });

  it('is `current` when the newest release is the one running, or older', () => {
    expect(foldUpdateStatus({ ...facts, currentVersion: '1.2.0' }, checkedAt).outcome).toEqual({
      kind: 'current',
    });
    expect(foldUpdateStatus({ ...facts, currentVersion: '2.0.0' }, checkedAt).outcome).toEqual({
      kind: 'current',
    });
  });

  it('is `current` — not a failure — for a repository that has published nothing', () => {
    expect(foldUpdateStatus({ ...facts, release: undefined }, checkedAt).outcome).toEqual({
      kind: 'current',
    });
  });

  it('leaves the asset absent when no single file matched, rather than naming a plausible one', () => {
    const status = foldUpdateStatus(
      {
        ...facts,
        arch: 'ia32',
        release: release({
          assets: [asset('boxwarden_1.2.0_amd64.deb'), asset('boxwarden_1.2.0_arm64.deb')],
        }),
      },
      checkedAt,
    );
    expect(status.outcome).toMatchObject({ kind: 'available' });
    expect(status.outcome.kind === 'available' && 'asset' in status.outcome).toBe(false);
  });
});

describe('isCheckDue', () => {
  const now = new Date('2026-08-03T12:00:00Z');

  it('is due when nothing has ever been checked', () => {
    expect(isCheckDue(undefined, now)).toBe(true);
  });

  it('is not due again within the day', () => {
    expect(isCheckDue(new Date('2026-08-03T00:30:00Z'), now)).toBe(false);
  });

  it('is due once a day has passed', () => {
    expect(isCheckDue(new Date('2026-08-02T11:59:00Z'), now)).toBe(true);
  });

  it('is due when the last check is in the future, rather than waiting for the date to catch up', () => {
    // A corrected clock would otherwise stop the daily check for as long as it
    // was wrong by.
    expect(isCheckDue(new Date('2027-01-01T00:00:00Z'), now)).toBe(true);
  });
});

describe('parseUpdatePreferences', () => {
  it('defaults to checking, for a file written before this feature existed', () => {
    expect(parseUpdatePreferences(undefined)).toEqual({ enabled: true });
    expect(parseUpdatePreferences({})).toEqual({ enabled: true });
    expect(parseUpdatePreferences('nonsense')).toEqual({ enabled: true });
  });

  it('turns checks off only on an explicit false', () => {
    expect(parseUpdatePreferences({ enabled: false }).enabled).toBe(false);
    expect(parseUpdatePreferences({ enabled: 'no' }).enabled).toBe(true);
  });

  it('round-trips the timestamp JSON.stringify wrote', () => {
    const preferences = parseUpdatePreferences({ lastCheckedAt: '2026-08-03T12:00:00.000Z' });
    expect(preferences.lastCheckedAt).toEqual(new Date('2026-08-03T12:00:00.000Z'));
  });

  it('reads an unusable timestamp as "never checked", not as an Invalid Date', () => {
    // An Invalid Date compares false against everything, which would silently
    // stop the daily check for good.
    expect(parseUpdatePreferences({ lastCheckedAt: 'yesterday' }).lastCheckedAt).toBeUndefined();
    expect(parseUpdatePreferences({ lastCheckedAt: 17 }).lastCheckedAt).toBeUndefined();
  });

  it('normalises the dismissed version and drops one that is not a version', () => {
    expect(parseUpdatePreferences({ dismissedVersion: 'v1.2.0' }).dismissedVersion).toBe('1.2.0');
    expect(parseUpdatePreferences({ dismissedVersion: 'all' }).dismissedVersion).toBeUndefined();
  });
});
