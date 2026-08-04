/**
 * Whether a newer boxwarden has been published, and what the person running
 * this one has to do about it.
 *
 * boxwarden does not swap its own application bundle on macOS or Windows.
 * `electron-updater` does exactly that, and it needs a CODE signature to
 * decide the swap is safe — an Apple Developer ID, an Authenticode
 * certificate. This project has neither, and until it does, Squirrel.Mac
 * refuses the swap outright and everywhere else it would replace a binary on
 * the user's disk on the strength of a download nothing checked.
 *
 * What it DOES do is the half that needs no certificate: fetch the one file
 * this machine needs, verify it against `sha256sums.txt` and the Sigstore
 * bundle the release workflow attaches, and hand it to the operating system's
 * own installer — see src/models/download.ts. The artefacts ARE signed, with
 * cosign, which is a different thing from code signing and does not substitute
 * for it: cosign proves these bytes came out of this repository's release
 * workflow, and Gatekeeper has never heard of it. Both statements are true at
 * once and this file is careful to keep them apart, because "unsigned" said
 * flatly is now wrong in one sense and right in the other.
 *
 * The one exception is the AppImage, which updates itself in place. Not
 * because the rule bent — because an AppImage is a single file the user owns,
 * with no installer to hand it to and no package manager to offend, so
 * "replace the file" IS the install procedure and boxwarden can do it with the
 * same verification a person would have to do by hand.
 *
 * That is also why this file is bigger than a version comparison. Telling
 * somebody "1.2.0 is available" is not the feature; telling them which file
 * their machine needs, and that Gatekeeper is about to refuse it, is. Those
 * instructions differ per platform AND per install kind — a `.deb` is replaced
 * by apt, an AppImage by overwriting a file — so the kind is detected rather
 * than guessed from the platform alone.
 *
 * Pure, and imports nothing: the network call, the clock and `app.getVersion()`
 * live in the shell at src/main/update/check.ts.
 */

/**
 * The repository releases are published from — the same one
 * `electron-builder.yml` names in `publish:`.
 *
 * Here rather than in the shell because two things derive from it and they
 * MUST agree: the API URL that is fetched, and the prefix every URL in the
 * response is checked against. Splitting them across two files is how you end
 * up trusting links from a repository you did not query.
 */
// Type-only, and therefore erased: `download.ts` imports this module back for
// `UPDATE_REPOSITORY` and `InstallKind`, and a value import in this direction
// would make that a real cycle at runtime.
import type { UpdateDownload } from './download.js';

export const UPDATE_REPOSITORY = { owner: 'sethcarney', repo: 'boxwarden' } as const;

/**
 * GitHub's "latest release" endpoint.
 *
 * `/releases/latest` rather than `/releases` because it already excludes
 * drafts and prereleases, which is exactly the filter this needs: a draft is a
 * release that has not been decided on yet, and pointing a user at one would
 * be pointing them at assets that can still be deleted.
 */
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/latest`;

/**
 * Every URL taken out of the API response has to start with this.
 *
 * The response is network data. It reaches the UI as links the user is being
 * invited to click, and `shell.openExternal` only checks the ORIGIN, so
 * `https://github.com/someone-else/malware/releases` would sail through the
 * allow-list in src/main/index.ts. This is the narrower check that makes the
 * link mean what the banner says it means.
 *
 * A prefix match, not a URL parse, and the trailing slash is what makes it
 * sound: `https://github.com.evil.test/` and `https://github.com@evil.test/`
 * both fail it, because the character after `github.com` is not `/`.
 */
export const RELEASE_URL_PREFIX = `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/`;

/** How long a check is good for. The issue asks for daily; this is that number. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---- versions ----

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The dot-separated identifiers after `-`, or empty for a final release. */
  readonly prerelease: readonly string[];
}

/**
 * Anchored, and it accepts a leading `v` because tags carry one and
 * `package.json` does not — the two spellings have to compare equal.
 * Build metadata (`+sha`) is matched and discarded: semver says it takes no
 * part in precedence.
 */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Undefined for anything that is not a semantic version — including `''`. */
export function parseVersion(raw: string): SemanticVersion | undefined {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (match === null) return undefined;

  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

/** Strip the tag's `v`, so `v1.2.3` and `1.2.3` are one string. */
export function normaliseVersion(raw: string): string {
  const parsed = parseVersion(raw);
  if (parsed === undefined) return raw.trim();
  const base = `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`;
  return parsed.prerelease.length === 0 ? base : `${base}-${parsed.prerelease.join('.')}`;
}

/**
 * Semver precedence: negative if `a` sorts before `b`.
 *
 * The prerelease rules are the half that is easy to get wrong, and getting
 * them wrong is not cosmetic — `1.2.0-rc.1` sorting ABOVE `1.2.0` would
 * prompt everyone on the final release to "update" to the candidate it
 * replaced.
 */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A version with a prerelease has LOWER precedence than one without.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    // A larger set of identifiers wins when the common prefix is equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) - Number(right);
      continue;
    }
    // Numeric identifiers always sort below alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `candidate` is worth telling the user about.
 *
 * Returns FALSE when either side is unparseable, deliberately. The only
 * versions that cannot be parsed are ones this app has no business reasoning
 * about — a locally built `0.0.0-dev`, a tag somebody typed by hand — and the
 * safe answer to "should I nag about an upgrade I cannot order" is no.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === undefined || now === undefined) return false;
  return compareVersions(next, now) > 0;
}

// ---- the release ----

export interface ReleaseAsset {
  readonly name: string;
  /** Always under `RELEASE_URL_PREFIX`; anything else was dropped by the parser. */
  readonly url: string;
  /** Bytes, when GitHub reported a positive number. */
  readonly size?: number;
}

export interface Release {
  /** Normalised — no leading `v`, so it compares against `package.json`. */
  readonly version: string;
  /** The tag as published, which is what the release page is named after. */
  readonly tag: string;
  readonly url: string;
  readonly publishedAt?: Date;
  readonly assets: readonly ReleaseAsset[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trustedUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith(RELEASE_URL_PREFIX) ? value : undefined;
}

/**
 * The GitHub release payload, narrowed to the five fields this app uses.
 *
 * `unknown` in, because it IS unknown: it arrives over the network from a
 * service that versions its API and can answer with an error object at the
 * same status code as a release. Undefined means "nothing usable here", which
 * the caller reports as a failed check rather than as "you are up to date".
 *
 * Drafts and prereleases are refused even though `/releases/latest` already
 * excludes them — the two-line check costs nothing and the day somebody
 * switches this to `/releases` is the day it matters.
 */
export function parseRelease(payload: unknown): Release | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  if (record['draft'] === true || record['prerelease'] === true) return undefined;

  const tag = record['tag_name'];
  if (typeof tag !== 'string' || parseVersion(tag) === undefined) return undefined;

  const url = trustedUrl(record['html_url']);
  if (url === undefined) return undefined;

  const publishedAt = parseDate(record['published_at']);
  const rawAssets = record['assets'];

  return {
    version: normaliseVersion(tag),
    tag,
    url,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    assets: Array.isArray(rawAssets) ? rawAssets.flatMap(parseAsset) : [],
  };
}

/**
 * The same release as it was written to preferences.json, read back.
 *
 * Remembered between runs so that relaunching the app inside the daily window
 * does not lose an update that was already found — without it, quitting five
 * minutes after the banner appeared would hide it again until tomorrow, which
 * looks exactly like the check being broken.
 *
 * Its own parser rather than a reuse of `parseRelease` because the two shapes
 * are genuinely different (`tag` vs `tag_name`, `url` vs `browser_download_url`),
 * and it is held to the SAME URL rule: a preferences file is a file on disk
 * that anything on the machine can write, so a link out of it gets no more
 * trust than a link off the network.
 */
export function parseStoredRelease(raw: unknown): Release | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;

  const tag = record['tag'];
  if (typeof tag !== 'string' || parseVersion(tag) === undefined) return undefined;

  const url = trustedUrl(record['url']);
  if (url === undefined) return undefined;

  const publishedAt = parseDate(record['publishedAt']);
  const rawAssets = record['assets'];

  return {
    version: normaliseVersion(tag),
    tag,
    url,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    assets: Array.isArray(rawAssets)
      ? rawAssets.flatMap((value) => parseAssetWith(value, 'url'))
      : [],
  };
}

/** Flat-mapped, so one malformed entry drops itself rather than the whole list. */
function parseAsset(value: unknown): ReleaseAsset[] {
  return parseAssetWith(value, 'browser_download_url');
}

function parseAssetWith(value: unknown, urlKey: string): ReleaseAsset[] {
  const record = asRecord(value);
  if (record === undefined) return [];

  const name = record['name'];
  const url = trustedUrl(record[urlKey]);
  if (typeof name !== 'string' || name === '' || url === undefined) return [];

  const size = record['size'];
  return [
    {
      name,
      url,
      ...(typeof size === 'number' && Number.isFinite(size) && size > 0 ? { size } : {}),
    },
  ];
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// ---- which file this machine needs ----

/**
 * How this copy of boxwarden was installed, which is what decides the
 * instructions — not the platform.
 *
 * Linux is the reason this type exists: the same platform ships as a `.deb`
 * that apt replaces in place and as an `.AppImage` that the user overwrites by
 * hand, and telling somebody to `sudo apt install` a file they never
 * downloaded is worse than saying nothing.
 */
export type InstallKind = 'dmg' | 'nsis' | 'appimage' | 'deb' | 'linux-unknown' | 'unknown';

/**
 * `platform`, `env` and `execPath` are parameters rather than reads of
 * `process`, for the reason the whole models layer takes its inputs: a test
 * asserts on a Windows answer from Linux.
 *
 * `APPIMAGE` is set by the AppImage runtime itself, so its presence is
 * evidence rather than inference. Without it, an install under `/opt` or
 * `/usr` is where the deb puts things; anything else — a `linux-unpacked`
 * directory, an unusual prefix — is honestly reported as unknown rather than
 * guessed at.
 */
export function detectInstallKind(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): InstallKind {
  if (platform === 'darwin') return 'dmg';
  if (platform === 'win32') return 'nsis';
  if (platform !== 'linux') return 'unknown';

  if (env['APPIMAGE'] !== undefined && env['APPIMAGE'] !== '') return 'appimage';
  if (execPath.startsWith('/opt/') || execPath.startsWith('/usr/')) return 'deb';
  return 'linux-unknown';
}

/** The file extension each install kind is upgraded from. */
const KIND_EXTENSION: Readonly<Record<InstallKind, string | undefined>> = {
  dmg: '.dmg',
  nsis: '.exe',
  appimage: '.appimage',
  deb: '.deb',
  'linux-unknown': undefined,
  unknown: undefined,
};

/**
 * How each architecture is spelled in an artefact name.
 *
 * `amd64` is in here because dpkg names packages with Debian's architecture
 * and electron-builder follows it: the x64 deb is `boxwarden_1.2.3_amd64.deb`
 * while the x64 AppImage beside it has no architecture in its name at all.
 * One table, because a per-target regex is how the deb ends up unmatched.
 */
const ARCH_TOKENS: Readonly<Record<string, readonly string[]>> = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'x86_64', 'amd64'],
};

const ALL_ARCH_TOKENS = Object.values(ARCH_TOKENS).flat();

/**
 * The one asset this machine should download, or undefined when the answer is
 * not obvious.
 *
 * Undefined is a real outcome and the UI has a screen for it: the release page
 * link, and the user picking. That beats naming a plausible file — an arm64
 * user sent to the x64 dmg gets an app that launches under Rosetta or not at
 * all, and blames the update rather than the guess.
 */
export function pickAsset(
  assets: readonly ReleaseAsset[],
  kind: InstallKind,
  arch: string,
): ReleaseAsset | undefined {
  const extension = KIND_EXTENSION[kind];
  if (extension === undefined) return undefined;

  const candidates = assets.filter((asset) => asset.name.toLowerCase().endsWith(extension));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const tokens = ARCH_TOKENS[arch] ?? [];
  const named = candidates.filter((asset) => hasAnyToken(asset.name, tokens));
  if (named.length === 1) return named[0];

  // Nothing carries this architecture's name. electron-builder omits the
  // architecture from the DEFAULT build's filename (`boxwarden-1.2.3.dmg` is
  // the x64 one), so an unmarked candidate is x64's — and only x64's.
  if (named.length === 0 && arch === 'x64') {
    const unmarked = candidates.filter((asset) => !hasAnyToken(asset.name, ALL_ARCH_TOKENS));
    if (unmarked.length === 1) return unmarked[0];
  }

  return undefined;
}

function hasAnyToken(name: string, tokens: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

// ---- what to tell the user to do ----

export interface UpdateInstructions {
  /** One line naming what to fetch for this machine. */
  readonly headline: string;
  readonly steps: readonly string[];
  /** Copyable one-liners, offered with a Copy button. Never run — shown. */
  readonly commands: readonly string[];
}

/**
 * The install steps for this machine.
 *
 * WRITING RULE, borrowed from advice.ts because it earns its keep twice over
 * here: every step says what to DO. And each platform's step about its
 * gatekeeper is not padding — the builds are not CODE-signed, so macOS and
 * Windows both interpose on first launch, and a user who was not warned reads
 * that as "the update is malware" and stops updating.
 *
 * These are the manual steps, and they stay reachable even now that boxwarden
 * can fetch and verify the file itself: the download refuses on a release
 * missing its signature, on an install kind whose artefact is ambiguous, and
 * on any machine where the user would rather do it themselves.
 */
export function updateInstructions(
  kind: InstallKind,
  asset: ReleaseAsset | undefined,
): UpdateInstructions {
  const quit = 'Quit boxwarden first — you cannot replace a running application.';

  switch (kind) {
    case 'dmg':
      return {
        headline: 'Download the .dmg and install it over the top.',
        steps: [
          quit,
          'Open the .dmg and drag boxwarden to Applications, replacing the copy already there.',
          'The build is not code-signed or notarised, so Gatekeeper refuses it on first launch: right-click the app in Applications and choose Open.',
        ],
        commands: [],
      };

    case 'nsis':
      return {
        headline: 'Download the Setup .exe and run it.',
        steps: [
          quit,
          'Run the installer. It installs per user, needs no admin rights, and replaces the version you have — there is nothing to uninstall first.',
          'The build is not code-signed, so SmartScreen interposes: More info → Run anyway.',
        ],
        commands: [],
      };

    case 'appimage':
      return {
        headline: 'Download the new .AppImage and replace the one you are running.',
        steps: [
          quit,
          'Overwrite the .AppImage you launched with the new one, then make it executable again — the executable bit does not survive the download.',
        ],
        commands: [`chmod +x ${asset?.name ?? 'boxwarden-<version>.AppImage'}`],
      };

    case 'deb':
      return {
        headline: 'Download the .deb and install it over the top.',
        steps: [
          quit,
          'apt replaces the installed version in place, so there is nothing to uninstall first. Run this from the folder you downloaded into.',
        ],
        commands: [`sudo apt install ./${asset?.name ?? 'boxwarden_<version>_amd64.deb'}`],
      };

    case 'linux-unknown':
      return {
        headline: 'Download the Linux build you installed from and install it over the top.',
        steps: [
          quit,
          'boxwarden could not tell whether this copy came from the .deb or the AppImage. If you installed the .deb, apt replaces it in place; if you are running the AppImage, overwrite the file and make it executable again.',
        ],
        commands: [],
      };

    case 'unknown':
      return {
        headline: 'Download the build for your platform and install it over the top.',
        steps: [quit, 'Install the download over the version you have.'],
        commands: [],
      };
  }
}

// ---- the status the rest of the app reads ----

/**
 * What the last look found. Six arms, and every one of them renders
 * differently — collapsing any two would be the app claiming to know something
 * it does not:
 *
 *   - `disabled`      the user turned checks off. Nothing has been fetched.
 *   - `unsupported`   a development build. `app.getVersion()` is the
 *                     placeholder, so there is nothing to compare against.
 *   - `unchecked`     enabled, nothing fetched YET. Not the same as `current`.
 *   - `current`       looked, and this is the newest release.
 *   - `failed`        looked, and could not tell. Emphatically not `current`.
 *   - `available`     there is a newer one, and here is how to get it.
 */
export type UpdateOutcome =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'current' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'available';
      readonly release: Release;
      /** The file for this machine, when exactly one matched. */
      readonly asset?: ReleaseAsset;
      readonly instructions: UpdateInstructions;
      /**
       * The user has already said "not now" about THIS version. The banner
       * stays down; the footer still says the update exists, because hiding it
       * entirely would make the dismissal permanent by accident.
       */
      readonly dismissed: boolean;
    };

export interface UpdateStatus {
  /**
   * The running version, on every arm — this is also the only place the app
   * displays its own version, and a footer that goes blank when a check fails
   * would be losing information it never had to fetch.
   */
  readonly currentVersion: string;
  /** When the last COMPLETED check happened. Absent until one has. */
  readonly checkedAt?: Date;
  readonly outcome: UpdateOutcome;
  /**
   * How far a download of the offered version has got.
   *
   * Required rather than optional, and always present even on the arms where
   * downloading is impossible — `idle` says that plainly, and an absent field
   * would leave the renderer distinguishing "nothing has been asked for" from
   * "this build cannot ask" by the shape of the object rather than by reading
   * the outcome beside it.
   *
   * It rides on the status rather than on a channel of its own because the two
   * are one state machine: the file being fetched is the asset named by
   * `outcome.asset`, and a download that outlived the offer it belongs to
   * would be a progress bar for a version nobody is being shown.
   */
  readonly download: UpdateDownload;
}

export interface UpdateFacts {
  readonly currentVersion: string;
  readonly installKind: InstallKind;
  /** `process.arch` — `x64`, `arm64`. */
  readonly arch: string;
  /**
   * The newest published release, or undefined when the repository has none.
   * A repository with no releases is "you are current", not a failure: there
   * is nothing newer than what you have.
   */
  readonly release: Release | undefined;
  /** The version the user last said "not now" to. */
  readonly dismissedVersion?: string;
  /**
   * The download in progress, when there is one. Absent means `idle`, which is
   * what every caller that has never started one passes.
   */
  readonly download?: UpdateDownload;
}

/**
 * Fold a successful check into a status.
 *
 * The whole decision lives here, in a function that takes facts and returns
 * data, so the shell around it does nothing but fetch and remember.
 */
export function foldUpdateStatus(facts: UpdateFacts, checkedAt: Date): UpdateStatus {
  const base = {
    currentVersion: facts.currentVersion,
    checkedAt,
    // The download belongs to a version on offer. Folding a check that found
    // none — or found one the running build already is — resets it, so a
    // finished download of 1.2.0 stops being advertised the moment 1.2.0 is
    // what is running.
    download: facts.download ?? { kind: 'idle' as const },
  };

  if (facts.release === undefined || !isNewerVersion(facts.release.version, facts.currentVersion)) {
    return { ...base, download: { kind: 'idle' }, outcome: { kind: 'current' } };
  }

  const asset = pickAsset(facts.release.assets, facts.installKind, facts.arch);
  return {
    ...base,
    outcome: {
      kind: 'available',
      release: facts.release,
      ...(asset === undefined ? {} : { asset }),
      instructions: updateInstructions(facts.installKind, asset),
      dismissed: facts.dismissedVersion === facts.release.version,
    },
  };
}

/**
 * Whether it is time to look again.
 *
 * A timestamp gate rather than a timer, because the app is not running most of
 * the time: an interval would make "daily" mean "every launch" for anyone who
 * opens boxwarden twice a day and "never" for anyone who leaves it closed.
 *
 * A `lastCheckedAt` in the FUTURE — a clock that was wrong and got corrected,
 * a machine that travelled — is treated as due. The alternative is an app that
 * stops checking until the date catches up.
 */
export function isCheckDue(
  lastCheckedAt: Date | undefined,
  now: Date,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckedAt === undefined) return true;
  const elapsed = now.getTime() - lastCheckedAt.getTime();
  return elapsed < 0 || elapsed >= intervalMs;
}

// ---- what is remembered between runs ----

export interface UpdatePreferences {
  /**
   * Whether to contact GitHub at all. Defaults to ON, and is a setting rather
   * than a constant because this is the only outbound network request the app
   * makes: somebody on a metered link or an air-gapped machine gets to say no,
   * and an app that phones home with no off switch has to be trusted rather
   * than checked.
   */
  readonly enabled: boolean;
  /** The version the user said "not now" to. Cleared when a newer one appears. */
  readonly dismissedVersion?: string;
  /** When GitHub was last asked. Persisted, so "daily" survives a restart. */
  readonly lastCheckedAt?: Date;
  /**
   * What that check found — so a relaunch inside the daily window still knows
   * about an update instead of going quiet until tomorrow. Absent when nothing
   * has been fetched, or when the repository had published nothing.
   */
  readonly lastRelease?: Release;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { enabled: true };

/**
 * Read the block out of preferences.json.
 *
 * Absent, malformed and empty all mean the defaults — checks on, never
 * checked. The one field with a sharp edge is `lastCheckedAt`: it round-trips
 * through JSON as a string, and an unparseable one becomes "never checked"
 * rather than an Invalid Date that would make every comparison against it
 * false and silently stop the daily check forever.
 */
export function parseUpdatePreferences(raw: unknown): UpdatePreferences {
  const record = asRecord(raw);
  if (record === undefined) return DEFAULT_UPDATE_PREFERENCES;

  const dismissedVersion = record['dismissedVersion'];
  const lastCheckedAt = parseDate(record['lastCheckedAt']);
  const lastRelease = parseStoredRelease(record['lastRelease']);

  return {
    // Only an explicit `false` turns it off, so a file written by an older
    // build — which has no such key — keeps the default.
    enabled: record['enabled'] !== false,
    ...(typeof dismissedVersion === 'string' && parseVersion(dismissedVersion) !== undefined
      ? { dismissedVersion: normaliseVersion(dismissedVersion) }
      : {}),
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
    ...(lastRelease === undefined ? {} : { lastRelease }),
  };
}
