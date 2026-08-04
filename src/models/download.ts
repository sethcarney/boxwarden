/**
 * Fetching a release artefact and deciding whether to believe it.
 *
 * boxwarden does not swap its own binary on macOS or Windows — that needs a
 * code signature Squirrel can check, and there is none (see
 * docs/releasing.md). What it does instead is the half that does not: download
 * the one file this machine needs, prove the bytes came out of this
 * repository's release workflow, hand them to the operating system's own
 * installer, and delete the download afterwards.
 *
 * The proving is the whole reason this module is careful. A file boxwarden
 * writes itself carries no `com.apple.quarantine` attribute, so Gatekeeper's
 * first-launch check does not fire the way it does on a browser download —
 * which means the verification here is not a second opinion, it is the ONLY
 * one. Everything below is written for that: a refusal is a refusal, never a
 * warning the user can click past, and every input from the network is treated
 * as hostile until a signature says otherwise.
 *
 * Two independent checks, both required:
 *
 *   1. **SHA-256** against `sha256sums.txt`, which the release workflow
 *      generates over the installers before anything is signed.
 *   2. **The Sigstore bundle** beside the artefact, whose certificate has to
 *      name this repository's release workflow at this release's tag.
 *
 * Neither subsumes the other. The checksum catches a truncated or corrupted
 * download, which is the common case and the one a signature reports as a
 * baffling cryptographic failure. The signature catches a swapped artefact,
 * which is the rare case and the one a checksum published beside it cannot
 * catch at all.
 *
 * Pure, and imports nothing: the fetch, the filesystem and the Sigstore
 * verifier live in src/main/update/.
 */

import { UPDATE_REPOSITORY } from './update.js';
import type { InstallKind, Release, ReleaseAsset } from './update.js';

/**
 * The checksum manifest the release workflow attaches to every release.
 *
 * Generated BEFORE signing, so it covers the installers rather than the
 * signatures over them — see the `publish` job in
 * `.github/workflows/release.yml`, which is the other half of this contract.
 * If that filename changes, this refuses every download rather than silently
 * skipping the checksum, which is the outcome to want.
 */
export const CHECKSUMS_ASSET_NAME = 'sha256sums.txt';

/** cosign v3 writes one bundle per artefact, named after it. */
export function signatureAssetName(assetName: string): string {
  return `${assetName}.sigstore.json`;
}

/**
 * The certificate identity a release artefact's signature must carry.
 *
 * This is the point of signing at all. cosign's keyless flow puts the
 * workflow's own identity into the Fulcio certificate, so a valid signature
 * over the right bytes is still worthless unless somebody checks WHOSE it is:
 * any GitHub Actions workflow in the world can obtain a certificate from the
 * same issuer, and an unchecked signature would accept every one of them.
 *
 * Pinned to the tag as well as the workflow, so a signature made for 1.0.0
 * cannot be replayed over an artefact offered as 2.0.0.
 */
export interface SignerIdentity {
  /** The SAN URI Fulcio issues for a workflow — the job that ran, and on what. */
  readonly subjectAlternativeName: string;
  /** The OIDC issuer. GitHub's Actions token service, and nothing else. */
  readonly issuer: string;
}

/** The workflow that signs. A different file signing a release is a refusal. */
const SIGNING_WORKFLOW = '.github/workflows/release.yml';

export const SIGNING_ISSUER = 'https://token.actions.githubusercontent.com';

export function signerIdentity(tag: string): SignerIdentity {
  const { owner, repo } = UPDATE_REPOSITORY;
  return {
    subjectAlternativeName: `https://github.com/${owner}/${repo}/${SIGNING_WORKFLOW}@refs/tags/${tag}`,
    issuer: SIGNING_ISSUER,
  };
}

// ---- the filename ----

/**
 * Every character an artefact name may contain to be written to disk.
 *
 * An allow-list, not a deny-list, and that asymmetry is the point: the name
 * arrives inside a JSON document fetched over the network, and it is about to
 * become a path. A deny-list of `..` and `/` is a promise to have thought of
 * every other spelling — `..%2f`, a NUL that truncates the name inside a
 * syscall, a trailing space or dot that Windows strips after the check, a
 * right-to-left override that makes `exe.gpj` render as `jpg.exe`. This
 * refuses all of them by refusing everything that is not plainly a filename.
 *
 * The set is what electron-builder actually emits: letters, digits, dot,
 * underscore, hyphen — and the SPACE, because the NSIS artefact really is
 * called `boxwarden Setup 1.2.0.exe`. A rule without it would have been a rule
 * that quietly excluded every Windows user from the verified download, which
 * is the kind of correctness that shows up as a bug report about a missing
 * button.
 *
 * The space is safe here for a reason worth stating rather than assuming:
 * nothing on this path goes through a shell. `shell.openPath` calls the
 * platform's open API with a path, and the AppImage branch does filesystem
 * operations — there is no command line for a space to split.
 *
 * First and last characters must be alphanumeric, which is what keeps the
 * space from mattering at the ends. A trailing space or dot is stripped by
 * Windows AFTER a name is validated, so `evil.exe.` and `evil.exe ` are the
 * classic ways to make a checked name become a different one; both fail here.
 * It also excludes `.` and `..` without a special case.
 */
const SAFE_ASSET_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9])?$/;

/** No name may be longer than this once written; a filesystem limit, stated. */
const MAX_ASSET_NAME_LENGTH = 128;

/**
 * The name as it may be written to disk, or undefined if it may not be.
 *
 * Undefined is a refusal to download, not a prompt to sanitise. Rewriting a
 * hostile name into a safe one produces a file whose name no longer matches
 * the entry in `sha256sums.txt`, and the checksum lookup would then fail with
 * a confusing message about integrity rather than the true one about a
 * malformed release.
 */
export function safeAssetFileName(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_ASSET_NAME_LENGTH) return undefined;
  if (!SAFE_ASSET_NAME.test(name)) return undefined;
  return name;
}

// ---- the checksum manifest ----

/**
 * `sha256sums.txt` as `sha256sum` writes it, parsed.
 *
 * The format is `<64 hex digits><two spaces><name>`, with `*` in place of the
 * second space for a file read in binary mode. Both spellings are accepted
 * because both are correct and which one appears depends on how the workflow
 * invoked the tool — a parser that knows only one is a parser that starts
 * refusing every download the day somebody adds a `-b`.
 *
 * Unparseable lines are skipped rather than failing the whole file: a manifest
 * that grows a comment or a trailing blank line should not take the update
 * mechanism down with it. A name that appears twice keeps the FIRST entry, so
 * an attacker who can append to the file cannot override an earlier digest.
 */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();

  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})[ \t]+[* ]?([^\s].*)$/.exec(line.trim());
    if (match === null) continue;

    const [, digest, name] = match;
    if (digest === undefined || name === undefined) continue;

    const safe = safeAssetFileName(name.trim());
    if (safe === undefined || digests.has(safe)) continue;
    digests.set(safe, digest.toLowerCase());
  }

  return digests;
}

// ---- what a download needs before it starts ----

/**
 * A cap on what will be written to disk, whatever the release says.
 *
 * The installers are around a hundred megabytes. This is generous enough that
 * a legitimate one never approaches it and small enough that a response with
 * no `Content-Length` and no end cannot fill the user's disk while a progress
 * bar sits at an unknown percentage.
 */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/**
 * The three files a verified download needs, resolved against one release.
 *
 * The signature and the checksum manifest are release ASSETS rather than URLs
 * derived by string-building, so both are held to the same
 * `RELEASE_URL_PREFIX` rule the artefact is — see `parseRelease`. Deriving
 * `<url>.sigstore.json` from the artefact URL instead would be trusting the
 * network to tell us where its own alibi lives.
 */
export interface DownloadPlan {
  readonly artefact: ReleaseAsset;
  readonly signature: ReleaseAsset;
  readonly checksums: ReleaseAsset;
  /** Validated: safe to write to disk under this name. */
  readonly fileName: string;
  readonly identity: SignerIdentity;
  readonly version: string;
}

/**
 * Why a release cannot be downloaded, phrased for the person reading it.
 *
 * Every arm here sends the user to the release page instead, which is why the
 * messages say what boxwarden could not do rather than what the user did
 * wrong: none of these is their fault, and all of them are recoverable by
 * downloading in a browser.
 */
export interface DownloadRefusal {
  readonly reason: string;
}

export function planDownload(
  release: Release,
  asset: ReleaseAsset | undefined,
): DownloadPlan | DownloadRefusal {
  if (asset === undefined) {
    return { reason: 'boxwarden could not tell which file this machine needs.' };
  }

  const fileName = safeAssetFileName(asset.name);
  if (fileName === undefined) {
    return { reason: 'The release names its files in a way boxwarden will not write to disk.' };
  }

  if (asset.size !== undefined && asset.size > MAX_DOWNLOAD_BYTES) {
    return { reason: 'The download is larger than boxwarden is willing to fetch.' };
  }

  const signature = findAsset(release.assets, signatureAssetName(asset.name));
  if (signature === undefined) {
    // Not a soft failure. An unsigned artefact is the exact thing the
    // verification exists to refuse, and falling back to "checksum only" here
    // would mean an attacker who can add an asset to a release need only omit
    // the signature to disable the check.
    return {
      reason: `This release has no signature for ${asset.name}, so boxwarden cannot verify it.`,
    };
  }

  const checksums = findAsset(release.assets, CHECKSUMS_ASSET_NAME);
  if (checksums === undefined) {
    return {
      reason: `This release has no ${CHECKSUMS_ASSET_NAME}, so boxwarden cannot verify it.`,
    };
  }

  return {
    artefact: asset,
    signature,
    checksums,
    fileName,
    identity: signerIdentity(release.tag),
    version: release.version,
  };
}

export function isRefusal(plan: DownloadPlan | DownloadRefusal): plan is DownloadRefusal {
  return 'reason' in plan;
}

/** Exact, case-sensitive: asset names are chosen by the workflow, not typed. */
function findAsset(assets: readonly ReleaseAsset[], name: string): ReleaseAsset | undefined {
  return assets.find((asset) => asset.name === name);
}

// ---- the state the UI renders ----

export interface DownloadProgress {
  readonly receivedBytes: number;
  /** Absent when the response declared no length — the bar goes indeterminate. */
  readonly totalBytes?: number;
}

/**
 * Where a download has got to. Six arms, and none of them collapse:
 *
 *   - `idle`        nothing has been asked for.
 *   - `fetching`    bytes are arriving. Cancellable.
 *   - `verifying`   all the bytes are here and are being checked. NOT ready.
 *   - `ready`       verified, on disk, safe to hand to the installer.
 *   - `failed`      could not be fetched, or could not be believed.
 *   - `installing`  handed over; on some platforms the app is about to exit.
 *
 * `verifying` is separate from `ready` because it is the arm during which the
 * file exists in full and must not be opened. A UI that showed "downloaded"
 * for both would be inviting the one click the verification exists to prevent.
 */
export type UpdateDownload =
  | { readonly kind: 'idle' }
  | { readonly kind: 'fetching'; readonly version: string; readonly progress: DownloadProgress }
  | { readonly kind: 'verifying'; readonly version: string }
  | {
      readonly kind: 'ready';
      readonly version: string;
      readonly fileName: string;
      /** How the verified file is applied, which differs per install kind. */
      readonly apply: ApplyKind;
    }
  | { readonly kind: 'failed'; readonly version: string; readonly message: string }
  | { readonly kind: 'installing'; readonly version: string };

/**
 * What "install" does with a verified file, which is not the same everywhere.
 *
 *   - `open`      hand it to the OS installer and get out of the way. The user
 *                 finishes the install; boxwarden does not replace itself.
 *   - `replace`   overwrite the running AppImage and relaunch. Only ever this
 *                 for an AppImage, and only because an AppImage IS one file
 *                 the user owns — there is no installer to hand it to and no
 *                 package manager that would object.
 *
 * The distinction is in the model rather than decided at the call site so that
 * `replace` cannot be reached on a platform where overwriting the executable
 * would be vandalism: a deb is apt's file, and an .app bundle is a directory
 * Gatekeeper has opinions about.
 */
export type ApplyKind = 'open' | 'replace';

/**
 * `replace` for an AppImage and `open` for everything else.
 *
 * Written as an exhaustive switch rather than `kind === 'appimage'` so that
 * adding an install kind is a compile error here. The default that a boolean
 * would silently give a new arm is `open`, which is the safe one — but the
 * next kind to be added is as likely to be a portable Windows build, where
 * `open` would hand the user an installer for a copy they unpacked by hand.
 */
export function applyKindFor(kind: InstallKind): ApplyKind {
  switch (kind) {
    case 'appimage':
      return 'replace';
    case 'dmg':
    case 'nsis':
    case 'deb':
    case 'linux-unknown':
    case 'unknown':
      return 'open';
  }
}

// ---- cleaning up ----

/**
 * How long a verified download is kept before it is swept.
 *
 * It is deleted as soon as it has been applied, so this is only for the copies
 * nothing applied: the user downloaded, did not install, and quit. A week is
 * long enough that "I'll do it Monday" still finds the file and short enough
 * that a laptop does not accumulate a year of installers.
 */
export const DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DownloadEntry {
  readonly name: string;
  readonly modifiedAt: Date;
}

/**
 * Which files in the download directory should be deleted now.
 *
 * `keep` is the one this run has verified and may still install — sweeping it
 * because it happens to be old would delete the file out from under the
 * button offering it.
 *
 * Anything whose name is not a safe asset name is swept regardless of age. The
 * directory is boxwarden's own and nothing else should ever write there, so an
 * unexpected name is either a bug or something worth not keeping.
 */
export function staleDownloads(
  entries: readonly DownloadEntry[],
  keep: string | undefined,
  now: Date,
  retentionMs: number = DOWNLOAD_RETENTION_MS,
): readonly string[] {
  return entries
    .filter((entry) => {
      if (entry.name === keep) return false;
      if (safeAssetFileName(entry.name) === undefined) return true;
      return now.getTime() - entry.modifiedAt.getTime() >= retentionMs;
    })
    .map((entry) => entry.name);
}
