import { getTrustedRoot } from '@sigstore/tuf';
import { toTrustMaterial } from '@sigstore/verify';
import type { TrustMaterial } from '@sigstore/verify';
import { verificationAvailable } from '../crypto-compat.js';

/**
 * Who boxwarden is willing to believe signed something.
 *
 * A Sigstore signature is only as good as the root of trust it chains to, and
 * that root is not a constant — Sigstore's public-good instance rotates its
 * keys, and a client holding a snapshot eventually holds a snapshot of keys
 * nobody uses. TUF exists for exactly this: the root is fetched, verified
 * against the previous one, and cached, so rotation is something the client
 * follows rather than something that breaks it.
 *
 * Which is why this is a module rather than a vendored `trusted_root.json`.
 * A pinned file would be simpler to read and would, on some Tuesday after the
 * next rotation, silently turn every verified download into a failed one — an
 * update mechanism that disables itself is worse than one that was never
 * built, because nobody finds out until they need it.
 *
 * The network is not a hard dependency, though. See `#load`.
 */

/** The refresh is an HTTP fetch of a few small files; this is generous. */
const TUF_TIMEOUT_MS = 15_000;

/**
 * Resolved at most once per run, and kept.
 *
 * The TUF refresh is a handful of round trips and some signature checks over
 * the metadata. Doing it per download would put it in front of a button the
 * user just pressed; doing it once puts it behind the first one only.
 *
 * A rejected promise is not cached — the field is cleared in the `catch` — so
 * a laptop that was offline at launch and is online now gets a real attempt
 * rather than a remembered failure.
 */
let material: Promise<TrustMaterial> | undefined;

export interface TrustOptions {
  /** Where TUF keeps its metadata. `app.getPath('userData')` in practice. */
  readonly cachePath: string;
}

export function trustMaterial(options: TrustOptions): Promise<TrustMaterial> {
  material ??= load(options).catch((error: unknown) => {
    material = undefined;
    throw error instanceof Error ? error : new Error(String(error));
  });
  return material;
}

/**
 * Fresh if the network allows, cached if it does not.
 *
 * The two attempts answer two different situations and the order matters. The
 * first refreshes from Sigstore's CDN, which is what keeps a key rotation from
 * stranding this client. The second — `forceCache` — uses the metadata already
 * on disk from a previous successful refresh.
 *
 * Be precise about what the fallback does and does not cover. `@sigstore/tuf`
 * seeds a `root.json` into the cache on first use, but the root alone is not a
 * usable trust chain: timestamp, snapshot and targets still have to be fetched.
 * So the fallback rescues a machine that has refreshed successfully at least
 * once and is now offline — NOT a first run with no network. A first run
 * without reachable TUF metadata cannot verify anything, and says so rather
 * than pretending otherwise.
 *
 * Falling back is safe in a way it usually is not: the cached metadata was
 * itself TUF-verified when written, and it carries its own expiry, so
 * something too old to trust is refused by the library rather than accepted
 * here. What the fallback gives up is FRESHNESS, not validation — and giving
 * that up beats failing closed on a transient DNS error.
 */
async function load(options: TrustOptions): Promise<TrustMaterial> {
  try {
    return toTrustMaterial(
      await getTrustedRoot({ cachePath: options.cachePath, timeout: TUF_TIMEOUT_MS }),
    );
  } catch (error) {
    try {
      return toTrustMaterial(
        await getTrustedRoot({ cachePath: options.cachePath, forceCache: true }),
      );
    } catch (cachedError) {
      // Both errors, out loud, because neither reaches the user.
      //
      // The sentence below is deliberately vague — see the next comment — which
      // makes this the ONLY record of what actually went wrong, and a failure
      // whose stated remedy is "verify it by hand" is precisely the one that
      // gets reported. On Windows the app is a GUI process with no attached
      // console, so seeing this means launching it with output redirected
      // (`boxwarden.exe *> log.txt`); `scripts/check-sigstore.mjs` asks the
      // same question without a rebuild.
      console.error('[boxwarden] Sigstore trust root: refresh failed:', error);
      console.error('[boxwarden] Sigstore trust root: cached fallback failed:', cachedError);

      // "We could not reach it" and "this build cannot check signatures at all"
      // are different findings, and until this check existed they were reported
      // as the same one — which sent a whole afternoon after DNS, proxies and
      // certificates while the fault was in the runtime's crypto. A build whose
      // primitive is broken fails identically whatever the network is doing, so
      // it has to be asked separately. See src/main/crypto-compat.ts.
      if (!verificationAvailable()) {
        throw new Error(
          'This build of boxwarden cannot check signatures: its runtime refuses to verify without being told which digest to use, so no download can be vouched for. The release page has the file and the commands to verify it by hand.',
          { cause: cachedError },
        );
      }
      // Deliberately its own sentence, and deliberately not phrased as a
      // failed verification. "We could not check this" and "this is not what
      // it claims to be" are different findings, and merging them would tell
      // somebody behind a restrictive proxy that their download was forged —
      // the same distinction `ClaudeStatus` keeps between `unknown` and
      // `none`. tuf-repo-cdn.sigstore.dev is a separate host from GitHub, so a
      // network that allows one may well block the other.
      // `cachedError` rather than `error` as the cause: it is the failure that
      // actually ended the attempt chain, and the refresh error above is not
      // lost — it is on the line before. Nothing downstream reads either one,
      // which is exactly why they are logged rather than only attached.
      throw new Error(
        'boxwarden could not reach Sigstore to check the signature, so it will not install this download. The release page has the file and the commands to verify it by hand.',
        { cause: cachedError },
      );
    }
  }
}

/** Test seam, and the reason the cache above is a module-level binding. */
export function resetTrustMaterial(): void {
  material = undefined;
}
