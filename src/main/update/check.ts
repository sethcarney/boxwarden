import type {
  DownloadPlan,
  InstallKind,
  Release,
  UpdateDownload,
  UpdatePreferences,
  UpdateStatus,
} from '../../models/index.js';
import { foldUpdateStatus, isCheckDue, isRefusal, planDownload } from '../../models/index.js';

/**
 * When to ask GitHub, and what to do with the answer.
 *
 * Every DECISION about a release is in the pure `src/models/update.ts` — is
 * this newer, which file does this machine need, what should the user type.
 * What is left here is the two things a shell is for, a clock and a cache, and
 * they turned out to have edges of their own: a dismissal that a stale cache
 * swallows looks exactly like a broken button, and a failed check that gets
 * written down as "checked" goes quiet for a day.
 *
 * So this module imports no Electron either — the fetch arrives as a function
 * (`update/github.ts` is the one module that reaches the network) — and it has
 * tests.
 */

export interface UpdateCheckerOptions {
  /** `app.getVersion()` — the version in package.json that was packaged. */
  readonly currentVersion: string;
  readonly installKind: InstallKind;
  /** `process.arch`. */
  readonly arch: string;
  /**
   * False for a run that cannot meaningfully be updated — a development
   * build, where `app.getVersion()` is the `0.0.0` placeholder and the "install
   * it over the top" advice is nonsense. It reports `unsupported` and never
   * touches the network, which is also what keeps `bun run dev` and the CI
   * suite from talking to GitHub.
   */
  readonly supported: boolean;
  /**
   * Ask GitHub. Resolving `undefined` means "no release published"; rejecting
   * means the check could not be completed, which is a different answer.
   *
   * A parameter rather than a call to `update/github.ts` inside, so that the
   * daily gate, the cache and the dismissal can be tested without a network or
   * an Electron runtime.
   */
  fetchRelease(): Promise<Release | undefined>;
  /** The clock, as a parameter — the same convention as `relativeTime(now)`. */
  now(): Date;
  preferences(): UpdatePreferences;
  persist(next: UpdatePreferences): void;
  /**
   * The bytes half. Absent in tests and in `fake.ts`, where there is no
   * filesystem to write to and no Sigstore to ask — a checker with no
   * downloader reports `idle` forever and refuses to install, which is exactly
   * how a build that cannot download should behave.
   */
  readonly downloads?: DownloadController;
}

/**
 * The downloader, as this module needs it.
 *
 * An interface for the same reason `fetchRelease` is a function: `check.ts`
 * imports no Electron, which is what makes the daily gate, the cache and the
 * dismissal testable without a runtime. `UpdateDownloader` in `download.ts`
 * satisfies this structurally and is the only production implementation.
 */
export interface DownloadController {
  readonly state: UpdateDownload;
  start(plan: DownloadPlan): void;
  cancel(): void;
  install(): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * Record that a download was refused before it began.
   *
   * Here rather than as a return value so that ALL download state lives in one
   * object. A refusal the checker held itself would be a second source of
   * truth for the same field, and the two would disagree the first time a
   * refusal was followed by a successful download of something else.
   */
  refuse(version: string, message: string): void;
}

/**
 * What the IPC layer sees.
 *
 * An interface rather than the class, so `ipc.ts` depends on three verbs and
 * not on how they are answered — the same seam the folder picker reaches
 * `dialog` through. It is also what lets `update/fake.ts` stand in wholesale.
 */
export interface UpdatesContext {
  /**
   * The running version, readable without a check.
   *
   * The IPC layer needs it to answer at all when something goes wrong: a
   * status has to name a version, and `''` would render as "boxwarden " in the
   * footer, which looks like a bug in the app rather than in the check.
   */
  readonly currentVersion: string;
  /** `force` skips the daily gate; it never skips the "checks are off" one. */
  status(force: boolean): Promise<UpdateStatus>;
  dismiss(): Promise<UpdateStatus>;
  setEnabled(enabled: boolean): Promise<UpdateStatus>;
  /**
   * Fetch and verify the artefact for the version currently on offer.
   *
   * Takes no argument — the same rule as `dismiss`. WHICH file is downloaded
   * is derived here from this process's own last status, so a renderer cannot
   * name a URL, a filename, or a version. That is the whole reason the plan is
   * built on this side: `planDownload` decides what to fetch, and everything
   * it decides from came out of a response that was already checked against
   * `RELEASE_URL_PREFIX`.
   */
  download(): Promise<UpdateStatus>;
  cancelDownload(): Promise<UpdateStatus>;
  /** Hand the verified file to the OS. May quit the app; see `download.ts`. */
  install(): Promise<{ ok: true } | { ok: false; message: string }>;
}

export class UpdateChecker implements UpdatesContext {
  readonly #options: UpdateCheckerOptions;

  /**
   * The last status this process produced, kept for ONE arm of it: `failed`.
   *
   * A failed check is deliberately not written to disk (see `#fetchAndFold`),
   * so this is the only record that it happened — and forgetting it would mean
   * reporting "up to date" for a check that could not be completed, which is
   * the one confusion this whole feature exists to avoid.
   *
   * Everything else is re-folded from preferences rather than replayed from
   * here, and that is not an optimisation: a dismissal writes to preferences
   * and then asks for the status again, so a cached `available` that outranked
   * the file would make "Not now" look like it did nothing.
   */
  #last: UpdateStatus | undefined;

  /** One request at a time. The renderer polls, and a slow link would stack them up. */
  #inFlight: Promise<UpdateStatus> | undefined;

  constructor(options: UpdateCheckerOptions) {
    this.#options = options;
  }

  get currentVersion(): string {
    return this.#options.currentVersion;
  }

  async status(force = false): Promise<UpdateStatus> {
    if (!this.#options.supported) {
      return {
        currentVersion: this.#options.currentVersion,
        download: { kind: 'idle' },
        outcome: {
          kind: 'unsupported',
          reason:
            'This is a development build, so there is no released version to compare it against.',
        },
      };
    }

    const preferences = this.#options.preferences();
    if (!preferences.enabled) {
      return {
        currentVersion: this.#options.currentVersion,
        ...(preferences.lastCheckedAt === undefined
          ? {}
          : { checkedAt: preferences.lastCheckedAt }),
        // Not `this.#downloads()`: a download already fetched and verified
        // stays installable even after the user turns checks off. Turning off
        // the daily question is not the same as abandoning an answer already
        // given, and deleting the file they waited for would be the app
        // punishing them for changing a setting.
        download: this.#downloads(),
        outcome: { kind: 'disabled' },
      };
    }

    if (this.#inFlight !== undefined) return await this.#inFlight;
    if (force || isCheckDue(preferences.lastCheckedAt, this.#options.now())) {
      return await this.#check(preferences);
    }
    return this.#remembered(preferences);
  }

  /**
   * "Not now", about the version currently on offer.
   *
   * Takes no argument on purpose — the same rule as `addProjectRoot`. The
   * renderer says *that* the user dismissed something; WHICH version that was
   * is read from this process's own last status, so a renderer cannot file a
   * dismissal against a version nobody was ever shown.
   */
  async dismiss(): Promise<UpdateStatus> {
    const current = await this.status();
    if (current.outcome.kind !== 'available') return current;

    const preferences = this.#options.preferences();
    this.#options.persist({ ...preferences, dismissedVersion: current.outcome.release.version });
    return await this.status();
  }

  async setEnabled(enabled: boolean): Promise<UpdateStatus> {
    this.#options.persist({ ...this.#options.preferences(), enabled });
    // Turning checks back ON checks immediately: the user just asked a
    // question, and answering it tomorrow is not answering it.
    return await this.status(enabled);
  }

  /**
   * Start fetching the offered artefact, after deciding it can be fetched.
   *
   * The refusals are as important as the success and are reported into the
   * download state rather than thrown: `planDownload` says no to a release
   * with no signature, no checksum manifest, an ambiguous artefact or a
   * filename that will not be written to disk, and each of those is something
   * the user can act on by opening the release page. A thrown error would
   * reach them as a failed IPC call.
   */
  async download(): Promise<UpdateStatus> {
    const downloads = this.#options.downloads;
    const current = await this.status();
    if (downloads === undefined || current.outcome.kind !== 'available') return current;

    const { release, asset } = current.outcome;
    const plan = planDownload(release, asset);
    if (isRefusal(plan)) {
      downloads.refuse(release.version, plan.reason);
    } else {
      downloads.start(plan);
    }
    return await this.status();
  }

  async cancelDownload(): Promise<UpdateStatus> {
    this.#options.downloads?.cancel();
    return await this.status();
  }

  async install(): Promise<{ ok: true } | { ok: false; message: string }> {
    const downloads = this.#options.downloads;
    if (downloads === undefined) {
      return { ok: false, message: 'This build cannot install downloads.' };
    }
    return await downloads.install();
  }

  /** `idle` when there is no downloader at all — see `DownloadController`. */
  #downloads(): UpdateDownload {
    return this.#options.downloads?.state ?? { kind: 'idle' };
  }

  /** What is known without asking again — from the file, except for a failure. */
  #remembered(preferences: UpdatePreferences): UpdateStatus {
    if (this.#last?.outcome.kind === 'failed') return this.#last;
    // Defensive rather than reachable: a missing timestamp is always due, so
    // `status` would have checked instead of arriving here. It is written out
    // anyway because the alternative — folding with no `checkedAt` — would
    // have to invent one, and an invented timestamp is how "never checked"
    // starts reading as "checked, and you are up to date".
    if (preferences.lastCheckedAt === undefined) {
      return {
        currentVersion: this.#options.currentVersion,
        download: this.#downloads(),
        outcome: { kind: 'unchecked' },
      };
    }
    return foldUpdateStatus(this.#facts(preferences), preferences.lastCheckedAt);
  }

  async #check(preferences: UpdatePreferences): Promise<UpdateStatus> {
    const request = this.#fetchAndFold(preferences);
    this.#inFlight = request;
    try {
      return await request;
    } finally {
      this.#inFlight = undefined;
    }
  }

  async #fetchAndFold(preferences: UpdatePreferences): Promise<UpdateStatus> {
    const checkedAt = this.#options.now();
    try {
      const release = await this.#options.fetchRelease();
      // Written down BEFORE folding, so tomorrow's launch — and a relaunch ten
      // minutes from now — start from what was actually found.
      this.#options.persist({
        ...preferences,
        lastCheckedAt: checkedAt,
        ...(release === undefined ? {} : { lastRelease: release }),
      });
      // `release` overrides the remembered one even when it is undefined: a
      // repository that has published nothing means there is nothing newer,
      // and re-reporting a release that has since been deleted would be
      // pointing at a page that 404s.
      const status = foldUpdateStatus({ ...this.#facts(preferences), release }, checkedAt);
      this.#last = status;
      return status;
    } catch (error) {
      // NOT persisted. A failed check must not consume the day's slot: an
      // offline laptop that gets its network back at noon should find out
      // then, not tomorrow. The cost is one retry per poll while it keeps
      // failing, which is an hour apart.
      const status: UpdateStatus = {
        currentVersion: this.#options.currentVersion,
        ...(preferences.lastCheckedAt === undefined
          ? {}
          : { checkedAt: preferences.lastCheckedAt }),
        // A check that could not be completed says nothing about a download
        // that already finished — the file is verified and still on disk.
        download: this.#downloads(),
        outcome: {
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
      this.#last = status;
      return status;
    }
  }

  #facts(preferences: UpdatePreferences) {
    return {
      currentVersion: this.#options.currentVersion,
      installKind: this.#options.installKind,
      arch: this.#options.arch,
      release: preferences.lastRelease,
      download: this.#downloads(),
      ...(preferences.dismissedVersion === undefined
        ? {}
        : { dismissedVersion: preferences.dismissedVersion }),
    };
  }
}
