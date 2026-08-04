import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canVerifyWithoutDigest, substituteDigestFor, wrapVerify } from './crypto-compat.js';

/**
 * Real keys and real signatures, no daemon and no display — the suite's rule
 * holds. Node's OpenSSL passes every one of these unwrapped; the point is that
 * the wrapper does not change any answer except the one BoringSSL refuses to
 * give, and above all that it never turns a bad signature into a good one.
 */

const DATA = Buffer.from('tuf canonical metadata');

function ecKeys(namedCurve = 'P-256') {
  return generateKeyPairSync('ec', { namedCurve });
}

/**
 * A `verify` that refuses the digest-less EC call, the way Electron's does.
 *
 * A stand-in rather than the real thing because the suite runs under node,
 * where the bug does not reproduce: without this there is no way to test the
 * behaviour that motivates the whole module.
 */
function boringSslLike(): (...args: readonly unknown[]) => unknown {
  return (...args: readonly unknown[]) => {
    const [algorithm, data, key, signature] = args;
    if (algorithm === undefined || algorithm === null) {
      const asKey = key as { asymmetricKeyType?: string };
      if (asKey.asymmetricKeyType === 'ec') {
        throw Object.assign(new Error('NO_DEFAULT_DIGEST'), {
          code: 'ERR_OSSL_EVP_NO_DEFAULT_DIGEST',
        });
      }
    }
    return (verify as (...inner: readonly unknown[]) => unknown)(algorithm, data, key, signature);
  };
}

describe('substituteDigestFor', () => {
  it('names sha256 for an EC key, which is what OpenSSL infers', () => {
    expect(substituteDigestFor(ecKeys().publicKey)).toBe('sha256');
  });

  /**
   * Reproducing Node rather than improving on it: OpenSSL's default for EC is
   * sha256 whatever the curve, so a curve-matched digest here would make this
   * build accept something plain node rejects.
   */
  it('names sha256 for every curve, not a curve-matched digest', () => {
    expect(substituteDigestFor(ecKeys('P-384').publicKey)).toBe('sha256');
    expect(substituteDigestFor(ecKeys('P-521').publicKey)).toBe('sha256');
  });

  it('leaves alone the key types that already work', () => {
    expect(substituteDigestFor(generateKeyPairSync('ed25519').publicKey)).toBeUndefined();
    expect(
      substituteDigestFor(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey),
    ).toBeUndefined();
  });

  it('reads a PEM as well as a KeyObject, since verify accepts both', () => {
    const pem = ecKeys().publicKey.export({ type: 'spki', format: 'pem' });
    expect(substituteDigestFor(pem)).toBe('sha256');
  });

  it('passes through anything it cannot read rather than guessing', () => {
    expect(substituteDigestFor('not a key')).toBeUndefined();
    expect(substituteDigestFor(undefined)).toBeUndefined();
    expect(substituteDigestFor(42)).toBeUndefined();
  });
});

describe('wrapVerify', () => {
  it('verifies an EC signature on a runtime that refuses the digest-less call', () => {
    const { privateKey, publicKey } = ecKeys();
    const signature = sign('sha256', DATA, privateKey);
    const wrapped = wrapVerify(boringSslLike());

    // The whole bug, in one assertion: this is the call tuf-js makes.
    expect(wrapped(undefined, DATA, publicKey, signature)).toBe(true);
  });

  /**
   * The property that matters more than the fix working: a shim in a security
   * path must not be able to turn a failed verification into a passed one.
   */
  it('still rejects a signature over different data', () => {
    const { privateKey, publicKey } = ecKeys();
    const signature = sign('sha256', DATA, privateKey);
    const wrapped = wrapVerify(boringSslLike());

    expect(wrapped(undefined, Buffer.from('tampered'), publicKey, signature)).toBe(false);
  });

  it('still rejects a signature from a different key', () => {
    const signer = ecKeys();
    const stranger = ecKeys();
    const signature = sign('sha256', DATA, signer.privateKey);
    const wrapped = wrapVerify(boringSslLike());

    expect(wrapped(undefined, DATA, stranger.publicKey, signature)).toBe(false);
  });

  it('does not touch a call that already names its digest', () => {
    const original = vi.fn(() => true);
    const { publicKey } = ecKeys();
    wrapVerify(original)('sha512', DATA, publicKey, Buffer.alloc(0));

    expect(original).toHaveBeenCalledWith('sha512', DATA, publicKey, Buffer.alloc(0));
  });

  it('does not touch ed25519, which requires the digest-less form', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signature = sign(undefined, DATA, privateKey);
    const original = vi.fn((...args: readonly unknown[]) =>
      (verify as (...inner: readonly unknown[]) => unknown)(...args),
    );

    expect(wrapVerify(original)(undefined, DATA, publicKey, signature)).toBe(true);
    // Still undefined — substituting a digest here would break it.
    expect(original.mock.calls[0]?.[0]).toBeUndefined();
  });
});

describe('canVerifyWithoutDigest', () => {
  it('is true for a runtime that infers the digest, which node does', () => {
    expect(canVerifyWithoutDigest(verify as (...args: readonly unknown[]) => unknown)).toBe(true);
  });

  it('is false for one that refuses, and true again once wrapped', () => {
    const boring = boringSslLike();
    expect(canVerifyWithoutDigest(boring)).toBe(false);
    expect(canVerifyWithoutDigest(wrapVerify(boring))).toBe(true);
  });

  /** A probe that threw must read as "cannot", never as "can". */
  it('is false for a verify that throws anything at all', () => {
    expect(
      canVerifyWithoutDigest(() => {
        throw new Error('nope');
      }),
    ).toBe(false);
  });

  /** Anything other than a literal true is a runtime we do not trust to check. */
  it('is false for a verify that answers with something other than true', () => {
    expect(canVerifyWithoutDigest(() => 'yes')).toBe(false);
    expect(canVerifyWithoutDigest(() => undefined)).toBe(false);
  });
});
