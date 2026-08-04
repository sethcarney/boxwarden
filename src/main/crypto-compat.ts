import { createRequire } from 'node:module';
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
  type verify,
} from 'node:crypto';

/**
 * Make Electron's crypto answer the question Node's would.
 *
 * ## The bug this exists for
 *
 * Electron links BoringSSL where Node links OpenSSL, and the two disagree
 * about one thing this app depends on: whether an EC key has a DEFAULT DIGEST.
 * OpenSSL says SHA-256. BoringSSL says there is no such thing and throws
 * `ERR_OSSL_EVP_NO_DEFAULT_DIGEST`.
 *
 * The whole verification chain under the self-update feature rests on the
 * digest-less call:
 *
 *   - `@tufjs/models/dist/utils/verify.js` → `crypto.verify(undefined, …)`
 *   - `@sigstore/core/dist/crypto.js`      → the same, at most call sites
 *
 * Both libraries treat a throw as "this key did not sign it" — sigstore's
 * wrapper catches and returns `false`, tuf-js counts the failure per key — so
 * the symptom is not an error about crypto at all. It is
 * `UnsignedMetadataError: root was signed by 0/3 keys`, four layers up, which
 * reads exactly like a corrupt download or a tampered release. It reached the
 * user as "boxwarden could not reach Sigstore", and finding it took a packaged
 * build, a redirected log and a runtime comparison. See
 * `scripts/check-sigstore.mjs`, which tests this primitive before anything else.
 *
 * Without this shim `downloadUpdate` can NEVER verify anything in a packaged
 * build, on ANY platform, because Electron uses BoringSSL everywhere. The
 * feature was dead on arrival and could not have been noticed until a release
 * existed to download.
 *
 * ## What it does, and what it deliberately does not
 *
 * It wraps `crypto.verify` so that a call naming NO digest against an EC key
 * names SHA-256 — the digest OpenSSL would have inferred. Everything else is
 * passed straight through: a named digest, a non-EC key, a key that cannot be
 * read at all.
 *
 * SHA-256 for every EC curve, NOT a curve-matched digest (P-384 → SHA-384),
 * because the job is to reproduce Node rather than improve on it. OpenSSL's
 * default for EC is SHA-256 whatever the curve, so a P-384 signature made with
 * SHA-384 fails here — and fails identically under plain Node, which is what
 * every one of these libraries was written and tested against. A shim in a
 * security path that is cleverer than the thing it stands in for is a shim
 * nobody can reason about.
 *
 * It cannot weaken verification. Substituting the digest changes WHICH hash is
 * compared, never whether the comparison is enforced: a signature that does not
 * verify still returns false, which the tests pin with tampered data and with a
 * key that did not sign it.
 *
 * ## Why a shim and not a patched dependency
 *
 * The call is inside two transitive dependencies, both already at their latest
 * versions with no upstream fix. Patching them means two patch files to
 * re-apply and re-verify on every bump, and a silent breakage the day one stops
 * applying. This is ours, it is tested, and it survives upgrades.
 *
 * DELETE IT once tuf-js and sigstore-js name their digests, or once Electron's
 * BoringSSL grows a default: `installCryptoCompat` already no-ops on a runtime
 * that does not need it, so the day it becomes dead code is the day that
 * function starts returning false in a packaged build.
 */

/** What OpenSSL infers for an EC key, and BoringSSL refuses to. */
const EC_DEFAULT_DIGEST = 'sha256';

/** `verify`'s shape, loosely, so the wrapper can pass arguments through untouched. */
type VerifyFn = (...args: readonly unknown[]) => unknown;

/**
 * The digest to substitute for a key, or undefined to leave the call alone.
 *
 * Separate and exported because the decision IS the behaviour: a test that
 * asserts on it directly says more than one inferring it from a verification
 * that happened to pass.
 */
export function substituteDigestFor(key: unknown): string | undefined {
  let asKeyObject: KeyObject;
  try {
    // The libraries pass a KeyObject, but `verify` also accepts PEM strings,
    // Buffers and `{ key, … }` objects. Normalising rather than narrowing means
    // a shape we did not anticipate is passed through untouched instead of
    // mishandled.
    asKeyObject =
      typeof key === 'object' && key !== null && 'asymmetricKeyType' in key
        ? (key as KeyObject)
        : createPublicKey(key as Parameters<typeof createPublicKey>[0]);
  } catch {
    return undefined;
  }

  return asKeyObject.asymmetricKeyType === 'ec' ? EC_DEFAULT_DIGEST : undefined;
}

/**
 * Wrap a `verify` so a digest-less EC call names SHA-256.
 *
 * A factory taking the original rather than reaching for the module, so the
 * whole of the behaviour is testable without patching anything global — the
 * same seam `UpdateChecker` uses for `fetchRelease`.
 */
export function wrapVerify(original: VerifyFn): VerifyFn {
  return function verifyWithInferredDigest(...args: readonly unknown[]): unknown {
    const [algorithm, , key] = args;
    if (algorithm === undefined || algorithm === null) {
      const substitute = substituteDigestFor(key);
      if (substitute !== undefined) return original(substitute, ...args.slice(1));
    }
    return original(...args);
  };
}

/**
 * Whether a `verify` can check an EC signature without being told the digest.
 *
 * Generates its own key, so it needs no network, no cache and no Sigstore: a
 * runtime that fails this fails on every input. Takes the function to probe, so
 * it answers both "does this runtime need the shim" (before installing) and
 * "can this build verify at all" (after). `update/trust.ts` asks the second to
 * tell "this build cannot check signatures" apart from "we could not reach
 * Sigstore" — different findings, reported as the same one until now.
 */
export function canVerifyWithoutDigest(verifyFn: VerifyFn): boolean {
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('boxwarden crypto probe');
    return verifyFn(undefined, data, publicKey, sign('sha256', data, privateKey)) === true;
  } catch {
    return false;
  }
}

/**
 * The CommonJS `crypto`, which is the object the dependencies actually hold.
 *
 * NOT the ESM namespace: that one is frozen, and its bindings are a snapshot
 * taken when it was first imported, so assigning to it would either throw or
 * patch a copy nobody reads. `@tufjs/models` and `@sigstore/core` are CommonJS
 * and reach `crypto.verify` through this object at call time, which is what
 * makes patching it after they have been imported work at all.
 */
const nodeCrypto = createRequire(import.meta.url)('node:crypto') as { verify: typeof verify };

let installed = false;

/**
 * Install the wrapper, and say whether it was needed.
 *
 * Idempotent, and a no-op on a runtime that can already do it — plain node
 * under the test suite, or a future Electron that has grown a default — so the
 * built-in stays untouched everywhere it works.
 *
 * Called first in `index.ts`. The ordering is belt and braces rather than
 * strictly required (both libraries read `crypto.verify` at call time, not at
 * import time), but a dependency that destructured it on import would need the
 * patch in place before its first import, and that is not a thing to discover
 * from a release.
 */
export function installCryptoCompat(): boolean {
  if (installed) return true;
  if (canVerifyWithoutDigest(nodeCrypto.verify as unknown as VerifyFn)) return false;

  nodeCrypto.verify = wrapVerify(
    nodeCrypto.verify.bind(nodeCrypto) as unknown as VerifyFn,
  ) as unknown as typeof verify;
  installed = true;
  return true;
}

/**
 * Whether this build can verify a signature at all, shim included.
 *
 * Read through the same object the shim patches, so it reports what the
 * dependencies will actually meet rather than what an ESM binding captured at
 * import time.
 */
export function verificationAvailable(): boolean {
  return canVerifyWithoutDigest(nodeCrypto.verify as unknown as VerifyFn);
}
