import type { InstallKind, Release, UpdateStatus } from '../../models/index.js';
import { RELEASE_URL_PREFIX, foldUpdateStatus, parseVersion } from '../../models/index.js';
import type { UpdatesContext } from './check.js';

/**
 * An update that is not there, so the banner can be looked at.
 *
 * The same bargain as `FakeDockerBackend`: the interesting part of this
 * feature only happens on a machine where a NEWER release exists, and waiting
 * for one to be published is not a way to develop the screen that announces
 * it. So this serves a fabricated release through the REAL `foldUpdateStatus`
 * — which means the version comparison, the per-platform asset match and the
 * install instructions are the production ones, exercised against the
 * artefact names electron-builder actually emits.
 *
 * It never touches the network, and like the fake Docker backend it announces
 * itself loudly on the console. A fabricated update the user believes is real
 * would send them looking for a release that does not exist — and the link in
 * the banner points at a tag GitHub will 404.
 */
export function fakeUpdatesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly currentVersion: string;
    readonly installKind: InstallKind;
    readonly arch: string;
  },
): UpdatesContext | undefined {
  if (env['BOXWARDEN_FAKE_UPDATE'] !== '1') return undefined;

  console.warn('[boxwarden] BOXWARDEN_FAKE_UPDATE=1 — announcing a release that does not exist.');
  return new FakeUpdateChecker(options);
}

/** One minor version above whatever this build is, so there is always something newer. */
function nextVersion(currentVersion: string): string {
  const parsed = parseVersion(currentVersion);
  if (parsed === undefined) return '1.0.0';
  return `${String(parsed.major)}.${String(parsed.minor + 1)}.0`;
}

/**
 * Every INSTALLER `.github/workflows/release.yml` attaches, named as
 * electron-builder names them.
 *
 * The signature and checksum assets the workflow also attaches are deliberately
 * not here: nothing in the app reads them any more (see the note at the top of
 * src/models/update.ts), and a fixture carrying files no code path touches is a
 * fixture that quietly stops matching what it is standing in for.
 *
 * The NSIS artefact is spelled the way `electron-builder.yml` names it —
 * hyphens, explicit arch — because these strings are the interface `pickAsset`
 * matches against. A fixture using the old spaced default would exercise a
 * miss that no real release can produce.
 */
function fakeRelease(version: string): Release {
  const asset = (name: string, size = 95_000_000) => ({
    name,
    url: `${RELEASE_URL_PREFIX}download/v${version}/${name}`,
    size,
  });

  const installers = [
    `boxwarden-${version}.dmg`,
    `boxwarden-${version}-arm64.dmg`,
    `boxwarden-${version}.AppImage`,
    `boxwarden-${version}-arm64.AppImage`,
    `boxwarden_${version}_amd64.deb`,
    `boxwarden_${version}_arm64.deb`,
    `boxwarden-setup-${version}-x64.exe`,
    `boxwarden-setup-${version}-arm64.exe`,
  ];

  return {
    version,
    tag: `v${version}`,
    url: `${RELEASE_URL_PREFIX}tag/v${version}`,
    publishedAt: new Date(),
    assets: installers.map((name) => asset(name)),
  };
}

class FakeUpdateChecker implements UpdatesContext {
  readonly currentVersion: string;
  readonly #release: Release;
  readonly #installKind: InstallKind;
  readonly #arch: string;
  /** In memory only: a fixture has no business writing to preferences.json. */
  #enabled = true;
  #dismissed: string | undefined;

  constructor(options: {
    readonly currentVersion: string;
    readonly installKind: InstallKind;
    readonly arch: string;
  }) {
    this.currentVersion = options.currentVersion;
    this.#installKind = options.installKind;
    this.#arch = options.arch;
    this.#release = fakeRelease(nextVersion(options.currentVersion));
  }

  status(): Promise<UpdateStatus> {
    if (!this.#enabled) {
      return Promise.resolve({
        currentVersion: this.currentVersion,
        outcome: { kind: 'disabled' },
      });
    }
    return Promise.resolve(
      foldUpdateStatus(
        {
          currentVersion: this.currentVersion,
          installKind: this.#installKind,
          arch: this.#arch,
          release: this.#release,
          ...(this.#dismissed === undefined ? {} : { dismissedVersion: this.#dismissed }),
        },
        new Date(),
      ),
    );
  }

  dismiss(): Promise<UpdateStatus> {
    this.#dismissed = this.#release.version;
    return this.status();
  }

  setEnabled(enabled: boolean): Promise<UpdateStatus> {
    this.#enabled = enabled;
    return this.status();
  }
}
