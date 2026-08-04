import { describe, expect, it, vi } from 'vitest';
import type {
  DownloadPlan,
  Release,
  UpdateDownload,
  UpdatePreferences,
} from '../../models/index.js';
import {
  CHECKSUMS_ASSET_NAME,
  RELEASE_URL_PREFIX,
  signatureAssetName,
} from '../../models/index.js';
import type { DownloadController } from './check.js';
import { UpdateChecker } from './check.js';

/**
 * The shell has tests because its two jobs — a clock and a cache — are exactly
 * where this feature can go quietly wrong:
 *
 *   - a cache that outranks a freshly written preference makes "Not now" look
 *     like a dead button;
 *   - a failed check written down as "checked" goes silent for a day;
 *   - a daily gate that forgets across launches turns "daily" into "every time
 *     you open the app".
 *
 * None of those show up in the pure layer, and none of them need a network:
 * the fetch is a parameter, so this file drives the whole state machine with a
 * `vi.fn` and a fixed clock.
 */

const RELEASE: Release = {
  version: '1.2.0',
  tag: 'v1.2.0',
  url: `${RELEASE_URL_PREFIX}tag/v1.2.0`,
  assets: [{ name: 'boxwarden_1.2.0_amd64.deb', url: `${RELEASE_URL_PREFIX}download/x.deb` }],
};

const NOON = new Date('2026-08-03T12:00:00Z');

/**
 * A release carrying everything a verified download needs — the artefact, the
 * Sigstore bundle beside it and the checksum manifest — which is what
 * `.github/workflows/release.yml` actually leaves behind.
 */
const SIGNED_RELEASE: Release = {
  ...RELEASE,
  assets: [
    { name: 'boxwarden_1.2.0_amd64.deb', url: `${RELEASE_URL_PREFIX}download/x.deb` },
    {
      name: signatureAssetName('boxwarden_1.2.0_amd64.deb'),
      url: `${RELEASE_URL_PREFIX}download/x.deb.sigstore.json`,
    },
    { name: CHECKSUMS_ASSET_NAME, url: `${RELEASE_URL_PREFIX}download/sha256sums.txt` },
  ],
};

/**
 * The downloader as `check.ts` sees it: three verbs and a piece of state.
 *
 * A spy rather than the real `UpdateDownloader`, which imports Electron and
 * would drag a runtime into a suite whose whole point is not needing one. What
 * is under test here is the ORCHESTRATION — that a plan is built in the main
 * process, that a refusal is recorded rather than thrown, that the state rides
 * back on the status — not the bytes.
 */
function fakeDownloads(): DownloadController & {
  readonly started: DownloadPlan[];
  readonly refusals: string[];
} {
  const started: DownloadPlan[] = [];
  const refusals: string[] = [];
  let state: UpdateDownload = { kind: 'idle' };

  return {
    started,
    refusals,
    get state() {
      return state;
    },
    start(plan) {
      started.push(plan);
      state = { kind: 'fetching', version: plan.version, progress: { receivedBytes: 0 } };
    },
    cancel() {
      state = { kind: 'idle' };
    },
    refuse(version, message) {
      refusals.push(message);
      state = { kind: 'failed', version, message };
    },
    install: () => Promise.resolve({ ok: true as const }),
  };
}

function checker(
  options: {
    readonly preferences?: UpdatePreferences;
    readonly supported?: boolean;
    readonly release?: Release | undefined;
    readonly fetchRelease?: () => Promise<Release | undefined>;
    readonly now?: Date;
    readonly downloads?: DownloadController;
  } = {},
) {
  let preferences: UpdatePreferences = options.preferences ?? { enabled: true };
  const persist = vi.fn((next: UpdatePreferences) => {
    preferences = next;
  });
  const fetchRelease = vi.fn(
    options.fetchRelease ??
      (() => Promise.resolve('release' in options ? options.release : RELEASE)),
  );

  const subject = new UpdateChecker({
    currentVersion: '1.1.0',
    installKind: 'deb',
    arch: 'x64',
    supported: options.supported ?? true,
    fetchRelease,
    now: () => options.now ?? NOON,
    preferences: () => preferences,
    persist,
    ...(options.downloads === undefined ? {} : { downloads: options.downloads }),
  });

  return { subject, fetchRelease, persist, saved: () => preferences };
}

describe('UpdateChecker', () => {
  it('checks, reports what it found, and writes the release down', async () => {
    const { subject, fetchRelease, saved } = checker();

    const status = await subject.status(false);

    expect(fetchRelease).toHaveBeenCalledTimes(1);
    expect(status.outcome).toMatchObject({ kind: 'available', dismissed: false });
    expect(saved().lastCheckedAt).toEqual(NOON);
    expect(saved().lastRelease).toEqual(RELEASE);
  });

  it('never contacts GitHub in a development build', async () => {
    const { subject, fetchRelease } = checker({ supported: false });

    const status = await subject.status(true);

    expect(fetchRelease).not.toHaveBeenCalled();
    expect(status.outcome.kind).toBe('unsupported');
  });

  describe('the daily gate', () => {
    it('does not ask again inside the day', async () => {
      const { subject, fetchRelease } = checker();
      await subject.status(false);
      await subject.status(false);
      await subject.status(false);

      expect(fetchRelease).toHaveBeenCalledTimes(1);
    });

    /** The relaunch case: the answer has to survive the process that found it. */
    it('answers from the remembered release after a restart, without asking', async () => {
      const { subject, fetchRelease } = checker({
        preferences: {
          enabled: true,
          lastCheckedAt: new Date('2026-08-03T09:00:00Z'),
          lastRelease: RELEASE,
        },
      });

      const status = await subject.status(false);

      // Without this, quitting five minutes after the banner appeared would
      // hide it until tomorrow — which looks exactly like a broken check.
      expect(fetchRelease).not.toHaveBeenCalled();
      expect(status.outcome).toMatchObject({ kind: 'available' });
      expect(status.checkedAt).toEqual(new Date('2026-08-03T09:00:00Z'));
    });

    it('asks again once a day has passed', async () => {
      const { subject, fetchRelease } = checker({
        preferences: { enabled: true, lastCheckedAt: new Date('2026-08-02T09:00:00Z') },
      });

      await subject.status(false);
      expect(fetchRelease).toHaveBeenCalledTimes(1);
    });

    it('asks now when forced', async () => {
      const { subject, fetchRelease } = checker({
        preferences: { enabled: true, lastCheckedAt: NOON, lastRelease: RELEASE },
      });

      await subject.status(true);
      expect(fetchRelease).toHaveBeenCalledTimes(1);
    });

    it('does not stack overlapping requests', async () => {
      let release: (value: Release) => void = () => undefined;
      const { subject, fetchRelease } = checker({
        fetchRelease: () =>
          new Promise<Release>((resolve) => {
            release = resolve;
          }),
      });

      const first = subject.status(false);
      const second = subject.status(true);
      release(RELEASE);

      expect(await first).toEqual(await second);
      expect(fetchRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('a failed check', () => {
    it('is reported as a failure, never as up to date', async () => {
      const { subject } = checker({
        fetchRelease: () => Promise.reject(new Error('GitHub answered HTTP 500.')),
      });

      const status = await subject.status(false);
      expect(status.outcome).toEqual({ kind: 'failed', message: 'GitHub answered HTTP 500.' });
    });

    it('does not consume the day, so a laptop that comes back online finds out then', async () => {
      const { subject, persist, saved } = checker({
        fetchRelease: () => Promise.reject(new Error('offline')),
      });

      await subject.status(false);

      expect(persist).not.toHaveBeenCalled();
      expect(saved().lastCheckedAt).toBeUndefined();
    });

    it('survives a later poll rather than being replaced by a stale "current"', async () => {
      const { subject } = checker({
        preferences: { enabled: true, lastCheckedAt: NOON },
        fetchRelease: () => Promise.reject(new Error('offline')),
      });

      await subject.status(true);
      // The gate now says "not due", so this answers from memory — and what is
      // in memory is a check that did not complete.
      expect((await subject.status(false)).outcome.kind).toBe('failed');
    });
  });

  describe('dismissing', () => {
    it('takes effect immediately, rather than being swallowed by the cache', async () => {
      const { subject, saved } = checker();
      await subject.status(false);

      const status = await subject.dismiss();

      expect(saved().dismissedVersion).toBe('1.2.0');
      expect(status.outcome).toMatchObject({ kind: 'available', dismissed: true });
    });

    it('dismisses the version it last offered, not one it was handed', async () => {
      const { subject, saved } = checker();
      await subject.status(false);
      await subject.dismiss();

      expect(saved().dismissedVersion).toBe(RELEASE.version);
    });

    it('does nothing when there is no update to dismiss', async () => {
      const { subject, persist } = checker({ release: undefined });
      await subject.status(false);
      persist.mockClear();

      const status = await subject.dismiss();

      expect(status.outcome.kind).toBe('current');
      expect(persist).not.toHaveBeenCalled();
    });
  });

  describe('turning checks off', () => {
    it('stops asking, and says so', async () => {
      const { subject, fetchRelease, saved } = checker();
      await subject.status(false);
      fetchRelease.mockClear();

      const status = await subject.setEnabled(false);

      expect(status.outcome).toEqual({ kind: 'disabled' });
      expect(saved().enabled).toBe(false);
      // Including when the renderer forces one: `force` skips the daily gate,
      // not the user's decision.
      await subject.status(true);
      expect(fetchRelease).not.toHaveBeenCalled();
    });

    it('looks straight away when turned back on', async () => {
      const { subject, fetchRelease } = checker({
        preferences: { enabled: false, lastCheckedAt: NOON },
      });

      const status = await subject.setEnabled(true);

      // Answering "is there an update?" tomorrow is not answering it.
      expect(fetchRelease).toHaveBeenCalledTimes(1);
      expect(status.outcome).toMatchObject({ kind: 'available' });
    });
  });
});

describe('downloading', () => {
  it('plans the download in the main process, from its own last status', async () => {
    const downloads = fakeDownloads();
    const { subject } = checker({ release: SIGNED_RELEASE, downloads });

    await subject.download();

    expect(downloads.started).toHaveLength(1);
    expect(downloads.started[0]?.fileName).toBe('boxwarden_1.2.0_amd64.deb');
    // The identity is derived from the tag that was actually fetched, so a
    // renderer cannot influence which signature would satisfy the check.
    expect(downloads.started[0]?.identity.subjectAlternativeName).toContain('refs/tags/v1.2.0');
  });

  /**
   * The refusal reaches the user as a state they can read, not as a thrown IPC
   * error. `RELEASE` has an artefact and no signature beside it, which is
   * exactly the shape `planDownload` exists to refuse.
   */
  it('records a refusal rather than throwing, when the release cannot be verified', async () => {
    const downloads = fakeDownloads();
    const { subject } = checker({ release: RELEASE, downloads });

    const status = await subject.download();

    expect(downloads.started).toHaveLength(0);
    expect(downloads.refusals[0]).toContain('no signature');
    expect(status.download.kind).toBe('failed');
  });

  it('does nothing at all when there is no update on offer', async () => {
    const downloads = fakeDownloads();
    const { subject } = checker({ release: undefined, downloads });

    const status = await subject.download();

    expect(downloads.started).toHaveLength(0);
    expect(downloads.refusals).toHaveLength(0);
    expect(status.outcome.kind).toBe('current');
  });

  it('carries the download state back on the status, so one poll answers both', async () => {
    const downloads = fakeDownloads();
    const { subject } = checker({ release: SIGNED_RELEASE, downloads });

    await subject.download();
    const status = await subject.status(false);

    expect(status.download).toEqual({
      kind: 'fetching',
      version: '1.2.0',
      progress: { receivedBytes: 0 },
    });
  });

  /**
   * Turning the daily check off is not abandoning a file the user already
   * waited for. Deleting it, or hiding it, would be the app punishing somebody
   * for changing a setting.
   */
  it('keeps offering a finished download after checks are turned off', async () => {
    const downloads = fakeDownloads();
    const { subject } = checker({ release: SIGNED_RELEASE, downloads });

    await subject.download();
    const status = await subject.setEnabled(false);

    expect(status.outcome.kind).toBe('disabled');
    expect(status.download.kind).toBe('fetching');
  });

  /**
   * A build with no downloader — the fixture, and any test — reports `idle`
   * forever and refuses to install. It must not claim it could.
   */
  it('reports idle and refuses to install when there is no downloader', async () => {
    const { subject } = checker({ release: SIGNED_RELEASE });

    const status = await subject.download();
    expect(status.download).toEqual({ kind: 'idle' });

    const result = await subject.install();
    expect(result).toEqual({ ok: false, message: 'This build cannot install downloads.' });
  });
});
