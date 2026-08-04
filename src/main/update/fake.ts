import type {
  DownloadPlan,
  InstallKind,
  Release,
  UpdateDownload,
  UpdateStatus,
} from '../../models/index.js';
import {
  CHECKSUMS_ASSET_NAME,
  RELEASE_URL_PREFIX,
  applyKindFor,
  foldUpdateStatus,
  isRefusal,
  parseVersion,
  planDownload,
  signatureAssetName,
} from '../../models/index.js';
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
 * would send them looking for a download that does not exist.
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
 * Every artefact `.github/workflows/release.yml` attaches, named as
 * electron-builder names them — and, since the release now also carries the
 * files a verified download needs, one `.sigstore.json` per installer plus the
 * checksum manifest.
 *
 * Those are not decoration. `planDownload` refuses a release whose artefact
 * has no signature beside it, so a fixture without them would exercise only
 * the refusal path and the download UI could never be looked at. The point of
 * the fixture is the opposite: the screen only appears on a machine where
 * something newer exists.
 *
 * The NSIS artefact is spelled the way `electron-builder.yml` now names it —
 * hyphens, explicit arch — because these strings are the interface `pickAsset`
 * and `safeAssetFileName` match against. A fixture using the old spaced default
 * would exercise a refusal that no real release can produce.
 */
function fakeRelease(version: string): Release {
  const download = (name: string, size = 95_000_000) => ({
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
    assets: [
      ...installers.map((name) => download(name)),
      ...installers.map((name) => download(signatureAssetName(name), 6_000)),
      download(CHECKSUMS_ASSET_NAME, 900),
    ],
  };
}

/** How long the fixture pretends a download takes, and in how many steps. */
const FAKE_DOWNLOAD_STEPS = 20;
const FAKE_STEP_MS = 150;

/**
 * A download that transfers nothing.
 *
 * It moves through the same four states the real one does — `fetching` with
 * advancing progress, `verifying`, then `ready` — so the banner, the progress
 * bar and the Install button can all be worked on without a release existing.
 * What it will NOT do is install: there is no file, and a fixture that opened
 * something would be a fixture that did something real.
 */
class FakeDownloads {
  #state: UpdateDownload = { kind: 'idle' };
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #installKind: InstallKind;

  constructor(installKind: InstallKind) {
    this.#installKind = installKind;
  }

  get state(): UpdateDownload {
    return this.#state;
  }

  start(plan: DownloadPlan): void {
    if (this.#state.kind === 'fetching' || this.#state.kind === 'verifying') return;

    const total = plan.artefact.size ?? 95_000_000;
    let step = 0;
    this.#state = { kind: 'fetching', version: plan.version, progress: { receivedBytes: 0 } };

    this.#timer = setInterval(() => {
      step += 1;
      if (step < FAKE_DOWNLOAD_STEPS) {
        this.#state = {
          kind: 'fetching',
          version: plan.version,
          progress: {
            receivedBytes: Math.round((total * step) / FAKE_DOWNLOAD_STEPS),
            totalBytes: total,
          },
        };
        return;
      }
      if (step === FAKE_DOWNLOAD_STEPS) {
        this.#state = { kind: 'verifying', version: plan.version };
        return;
      }
      this.#stop();
      this.#state = {
        kind: 'ready',
        version: plan.version,
        fileName: plan.fileName,
        apply: applyKindFor(this.#installKind),
      };
    }, FAKE_STEP_MS);
  }

  cancel(): void {
    this.#stop();
    if (this.#state.kind !== 'ready') this.#state = { kind: 'idle' };
  }

  refuse(version: string, message: string): void {
    this.#stop();
    this.#state = { kind: 'failed', version, message };
  }

  install(): Promise<{ ok: true } | { ok: false; message: string }> {
    return Promise.resolve({
      ok: false,
      message: 'BOXWARDEN_FAKE_UPDATE=1 — there is no real download to install.',
    });
  }

  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

class FakeUpdateChecker implements UpdatesContext {
  readonly currentVersion: string;
  readonly #release: Release;
  readonly #installKind: InstallKind;
  readonly #arch: string;
  /** In memory only: a fixture has no business writing to preferences.json. */
  #enabled = true;
  #dismissed: string | undefined;
  readonly #downloads: FakeDownloads;

  constructor(options: {
    readonly currentVersion: string;
    readonly installKind: InstallKind;
    readonly arch: string;
  }) {
    this.currentVersion = options.currentVersion;
    this.#installKind = options.installKind;
    this.#arch = options.arch;
    this.#release = fakeRelease(nextVersion(options.currentVersion));
    this.#downloads = new FakeDownloads(options.installKind);
  }

  status(): Promise<UpdateStatus> {
    if (!this.#enabled) {
      return Promise.resolve({
        currentVersion: this.currentVersion,
        download: this.#downloads.state,
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
          download: this.#downloads.state,
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

  /**
   * The plan is built by the REAL `planDownload`, from the fixture release.
   *
   * Which is the point: a Windows fixture run hits the genuine refusal over
   * every platform gets a plan that passed the same asset matching,
   * signature-present and filename checks a real release has to.
   */
  async download(): Promise<UpdateStatus> {
    const current = await this.status();
    if (current.outcome.kind !== 'available') return current;

    const plan = planDownload(current.outcome.release, current.outcome.asset);
    if (isRefusal(plan)) this.#downloads.refuse(current.outcome.release.version, plan.reason);
    else this.#downloads.start(plan);
    return await this.status();
  }

  cancelDownload(): Promise<UpdateStatus> {
    this.#downloads.cancel();
    return this.status();
  }

  install(): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.#downloads.install();
  }
}
