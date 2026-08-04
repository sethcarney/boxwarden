import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bundleFromJSON } from '@sigstore/bundle';
import { Verifier, toSignedEntity } from '@sigstore/verify';
import type { TrustMaterial } from '@sigstore/verify';
import type { SignerIdentity } from '../../models/index.js';
import { parseChecksums } from '../../models/index.js';

/**
 * Deciding whether a downloaded file is the one this repository published.
 *
 * The verification a person would otherwise do by hand — `sha256sum -c`, then
 * `cosign verify-blob --bundle`, with `--certificate-identity` and
 * `--certificate-oidc-issuer` spelled correctly — automated, and made
 * non-optional. Everything it needs to DECIDE is in the pure
 * `src/models/download.ts`; what is left here is a hash, a file read and the
 * Sigstore library.
 *
 * Both checks are required and neither is allowed to degrade into a warning.
 * The reason is specific to this feature rather than general caution: a file
 * boxwarden downloaded itself carries no `com.apple.quarantine` attribute, so
 * the operating system will NOT second-guess it the way it would a browser
 * download. There is no other gate behind this one.
 */

/** `VerificationError` and friends carry useful text; anything else may not. */
function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') return `${fallback} (${error.message})`;
  return fallback;
}

/**
 * The SHA-256 of a file, streamed.
 *
 * Streamed rather than hashed from a buffer because this runs over a
 * hundred-megabyte installer in the main process, and the main process is also
 * the thread drawing the window: `readFile` then `createHash` would hold the
 * whole artefact twice and stall the UI while it did.
 */
export async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

export interface ChecksumCheck {
  /** The whole `sha256sums.txt`, as fetched. */
  readonly manifest: string;
  /** The artefact's name AS THE MANIFEST SPELLS IT — already validated safe. */
  readonly fileName: string;
  /** What the downloaded bytes actually hash to. */
  readonly actual: string;
}

/**
 * Throws unless the manifest names this file and agrees about its digest.
 *
 * A file the manifest does not mention is a failure, not a pass. The manifest
 * covers every artefact the release workflow built, so an artefact missing
 * from it is either a release assembled by something other than that workflow
 * or an asset added to it afterwards — and "not mentioned" is precisely the
 * state an attacker who uploads an extra file would leave things in.
 */
export function verifyChecksum(check: ChecksumCheck): void {
  const digests = parseChecksums(check.manifest);
  const expected = digests.get(check.fileName);

  if (expected === undefined) {
    throw new Error(`${check.fileName} is not listed in the release's checksums.`);
  }
  if (expected !== check.actual.toLowerCase()) {
    throw new Error(`${check.fileName} does not match the checksum this release published for it.`);
  }
}

export interface SignatureCheck {
  readonly filePath: string;
  /** The `<name>.sigstore.json` bundle, as fetched. */
  readonly bundle: string;
  readonly identity: SignerIdentity;
  readonly trust: TrustMaterial;
}

/**
 * Throws unless a Sigstore bundle covers this file AND names the right signer.
 *
 * The identity half is the half that matters and the half that is easy to
 * omit. Any workflow on GitHub can get a certificate from the same issuer, so
 * a bundle that merely verifies proves only that SOMEBODY signed these bytes.
 * The policy passed to `verify` is what turns that into a statement about this
 * repository's release workflow at this release's tag — see `signerIdentity`.
 *
 * `tlogThreshold: 1` requires an entry in the public transparency log, which
 * is what makes a signature that was never published useless: a certificate
 * minted quietly and used once still has to appear in a log anybody can read.
 */
export async function verifySignature(check: SignatureCheck): Promise<void> {
  let bundle;
  try {
    bundle = bundleFromJSON(JSON.parse(check.bundle));
  } catch (error) {
    throw new Error(describe(error, 'The signature file is not a readable Sigstore bundle.'), {
      cause: error,
    });
  }

  // The artefact has to be in memory for this: a detached blob signature is
  // over the bytes, and the library verifies rather than trusting the digest
  // the bundle states. Read after the checksum has already passed, so a
  // corrupted download never reaches it.
  const artefact = await readFile(check.filePath);

  try {
    const verifier = new Verifier(check.trust, { tlogThreshold: 1 });
    verifier.verify(toSignedEntity(bundle, artefact), {
      subjectAlternativeName: check.identity.subjectAlternativeName,
      extensions: { issuer: check.identity.issuer },
    });
  } catch (error) {
    throw new Error(
      describe(
        error,
        'The download is not signed by this repository’s release workflow for this version.',
      ),
      { cause: error },
    );
  }
}
