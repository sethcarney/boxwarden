import type { InstallKind, Release, UpdatePreferences, UpdateStatus } from '../../models/index.js';
import { foldUpdateStatus, isCheckDue } from '../../models/index.js';

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

  /** What is known without asking again — from the file, except for a failure. */
  #remembered(preferences: UpdatePreferences): UpdateStatus {
    if (this.#last?.outcome.kind === 'failed') return this.#last;
    // Defensive rather than reachable: a missing timestamp is always due, so
    // `status` would have checked instead of arriving here. It is written out
    // anyway because the alternative — folding with no `checkedAt` — would
    // have to invent one, and an invented timestamp is how "never checked"
    // starts reading as "checked, and you are up to date".
    if (preferences.lastCheckedAt === undefined) {
      return { currentVersion: this.#options.currentVersion, outcome: { kind: 'unchecked' } };
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
      ...(preferences.dismissedVersion === undefined
        ? {}
        : { dismissedVersion: preferences.dismissedVersion }),
    };
  }
}
