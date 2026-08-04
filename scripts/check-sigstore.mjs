#!/usr/bin/env node
/**
 * Ask Sigstore for its trust root, the way the app does, and say exactly what
 * happened.
 *
 * ## Why this exists
 *
 * `src/main/update/trust.ts` refuses to install a download it cannot verify,
 * and the sentence it shows — "boxwarden could not reach Sigstore to check the
 * signature" — is deliberately vague about the cause: "we could not check this"
 * and "this is not what it claims to be" are different findings, and a user
 * behind a restrictive proxy must not be told their download was forged.
 *
 * That is right for the UI and useless for debugging, because the app is a
 * Windows GUI process with no attached console: nothing is written down
 * anywhere. This script is the other half — same library, same options, same
 * cache directory, every error printed in full.
 *
 * ## What it is NOT
 *
 * It is not the app's code. `trust.ts` is TypeScript compiled into the Electron
 * bundle and cannot be imported from plain node, so the two attempts below are
 * a DELIBERATE MIRROR of `load()` in that file. If the options there change —
 * the timeout, the fallback, the cache path — change them here too, or this
 * script starts answering a question the app is no longer asking.
 *
 *   node scripts/check-sigstore.mjs
 *   node scripts/check-sigstore.mjs --cache "C:\\Users\\me\\AppData\\Roaming\\boxwarden\\sigstore"
 */

import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { getTrustedRoot } from '@sigstore/tuf';

/** Mirrors TUF_TIMEOUT_MS in src/main/update/trust.ts. */
const TUF_TIMEOUT_MS = 15_000;

/** Mirrors electron-builder.yml's productName, which is what names userData. */
const APP_NAME = 'boxwarden';

/** `DEFAULT_MIRROR_URL` in @sigstore/tuf — the host the app actually needs. */
const MIRROR_URL = 'https://tuf-repo-cdn.sigstore.dev';

/**
 * Where Electron would put `app.getPath('userData')`, computed rather than
 * asked, because this runs in plain node.
 *
 * Electron's rule per platform, and the reason each is written out: getting
 * this wrong would have the script inspect a directory the app never touches
 * and report a healthy cache the app cannot see.
 */
function userDataDirectory() {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), APP_NAME);
  }
}

/**
 * Every layer of an error, which is where the code that names the fault lives.
 *
 * Three details are load-bearing, all learned from tuf-js's own error classes:
 * they do not set `name`, so the constructor is the only thing that says which
 * one this is; an HTTP failure carries its status as `statusCode` rather than
 * `code`; and `cause` is where undici puts the DNS or TLS error that actually
 * explains a failure. Printing only `name` and `message` — the obvious version
 * of this function — reports every one of them as "Error: Failed to download".
 */
function describe(error) {
  const lines = [];
  let current = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 8) {
    const name =
      current.name === undefined || current.name === 'Error'
        ? (current.constructor?.name ?? 'Error')
        : current.name;
    const code = current.code === undefined ? '' : ` [${String(current.code)}]`;
    const status = current.statusCode === undefined ? '' : ` [HTTP ${String(current.statusCode)}]`;
    const message = current.message ?? String(current);
    lines.push(
      `${'  '.repeat(depth)}${depth === 0 ? '' : 'caused by: '}${name}${code}${status}: ${message}`,
    );
    current = current.cause;
    depth += 1;
  }
  return lines.join('\n');
}

async function describeCache(cachePath) {
  try {
    const entries = await readdir(cachePath, { withFileTypes: true });
    if (entries.length === 0) return 'exists, empty';

    const described = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        described.push(entry.name);
        continue;
      }
      // One level down is where the per-repository metadata actually lands —
      // `@sigstore/tuf` keys the directory on the mirror's host and path.
      const inner = await readdir(join(cachePath, entry.name)).catch(() => []);
      described.push(`${entry.name}/ (${inner.length === 0 ? 'empty' : inner.join(', ')})`);
    }
    return described.join('\n           ');
  } catch (error) {
    // ENOENT is the ordinary first-run state, not a failure: the library
    // creates the directory itself. Anything else is worth seeing.
    return error?.code === 'ENOENT'
      ? 'does not exist yet (normal before the first check)'
      : describe(error);
  }
}

/** Which JavaScript runtime this is — the answer usually turns on it. */
function runtimeLabel() {
  const electron = process.versions['electron'];
  const openssl = process.versions['openssl'] ?? 'none reported';
  return electron === undefined
    ? `plain node, openssl ${openssl}`
    : `electron ${electron} (BoringSSL), openssl ${openssl}`;
}

/**
 * Can this runtime verify a signature the way the TUF client asks it to?
 *
 * `@tufjs/models/dist/utils/verify.js` calls `crypto.verify(undefined, …)` —
 * no digest named — and `@sigstore/core/dist/crypto.js` does the same for the
 * signature bundle, so the entire verification chain rests on that one call
 * shape working. Node's OpenSSL infers the digest from the key; a runtime that
 * does not returns `false` rather than throwing, which surfaces four layers up
 * as "root was signed by 0/3 keys" and looks for all the world like a corrupt
 * download or a blocked CDN.
 *
 * Freshly generated keys, so this needs no network, no cache, and no Sigstore:
 * if it fails here it fails on every input, and nothing below it can pass.
 */
function checkCrypto() {
  const data = Buffer.from('tuf canonical metadata');
  const results = [];

  const attemptVerify = (label, fn) => {
    try {
      const ok = fn();
      results.push({ label, ok, note: ok ? '' : 'returned false' });
      return ok;
    } catch (error) {
      results.push({
        label,
        ok: false,
        note: `threw ${error.code ?? error.name}: ${error.message}`,
      });
      return false;
    }
  };

  // ECDSA P-256 is what Sigstore's TUF root keys are.
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecSig = sign('sha256', data, ec.privateKey);
  const withoutDigest = attemptVerify('ecdsa P-256, no digest named (what tuf-js does)', () =>
    verify(undefined, data, ec.publicKey, ecSig),
  );
  attemptVerify('ecdsa P-256, sha256 named explicitly', () =>
    verify('sha256', data, ec.publicKey, ecSig),
  );

  // ed25519 REQUIRES the undefined form, so it distinguishes "this runtime
  // cannot infer a digest" from "this runtime rejects the undefined form".
  const ed = generateKeyPairSync('ed25519');
  const edSig = sign(undefined, data, ed.privateKey);
  attemptVerify('ed25519, no digest named', () => verify(undefined, data, ed.publicKey, edSig));

  for (const { label, ok, note } of results) {
    console.log(`  ${ok ? 'ok     ' : 'FAILED '} ${label}${note === '' ? '' : ` — ${note}`}`);
  }

  if (!withoutDigest) {
    console.log('');
    console.log('  ^ THIS IS THE FAULT. Nothing below can pass: every signature this runtime');
    console.log('    is asked to check goes through that call, so the TUF root fails as');
    console.log('    "signed by 0/3 keys" and the download refuses. It is the runtime, not');
    console.log('    the network, not the cache, and not the release.');
  }
  return withoutDigest;
}

/** One attempt, timed — how long a failure took separates a refusal from a timeout. */
async function attempt(label, options) {
  const started = Date.now();
  try {
    await getTrustedRoot(options);
    console.log(`  ok      ${label} (${String(Date.now() - started)}ms)`);
    return true;
  } catch (error) {
    console.log(`  FAILED  ${label} (${String(Date.now() - started)}ms)`);
    console.log(
      describe(error)
        .split('\n')
        .map((line) => `          ${line}`)
        .join('\n'),
    );
    return false;
  }
}

const flagIndex = process.argv.indexOf('--cache');
const cachePath =
  flagIndex === -1 ? join(userDataDirectory(), 'sigstore') : process.argv[flagIndex + 1];

if (cachePath === undefined || cachePath === '') {
  console.error('--cache needs a path.');
  process.exit(2);
}

console.log(`platform   ${platform()}`);
console.log(`node       ${process.version}`);
console.log(`runtime    ${runtimeLabel()}`);
console.log(`cache      ${cachePath}`);
console.log(`           ${await describeCache(cachePath)}`);
console.log('');

// Before any of the TUF work, because a runtime that cannot do the primitive
// makes everything below it a foregone conclusion.
const cryptoOk = checkCrypto();
console.log('');

// Attempt 1: what the app tries first — a fresh refresh from Sigstore's CDN.
const fresh = await attempt('fresh refresh from the Sigstore CDN', {
  cachePath,
  timeout: TUF_TIMEOUT_MS,
});

// Attempt 2: the app's fallback. It rescues a machine that has refreshed
// successfully at least once and is now offline — NOT a first run, where the
// seeded root.json alone is not a usable trust chain.
const cached = fresh
  ? undefined
  : await attempt('cached metadata (forceCache)', {
      cachePath,
      forceCache: true,
    });

/**
 * The raw request, when both attempts failed.
 *
 * tuf-js flattens an HTTP failure into `DownloadHTTPError('Failed to download')`
 * and a network failure into whatever undici threw, so the layer that names the
 * fault — a 403 from a proxy, ENOTFOUND, a certificate error — is easiest to
 * see by asking for the same file directly. This is the one thing in the script
 * the app does not do, and it is here because it answers the question the app's
 * message cannot.
 */
if (!fresh && cached !== true) {
  const url = `${MIRROR_URL}/1.root.json`;
  console.log('');
  console.log(`  probing ${url} directly:`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TUF_TIMEOUT_MS) });
    console.log(`          HTTP ${String(response.status)} ${response.statusText}`);
    if (response.status === 403 || response.status === 407) {
      console.log('          A proxy is answering for the CDN rather than the CDN itself.');
    }
  } catch (error) {
    console.log(
      describe(error)
        .split('\n')
        .map((line) => `          ${line}`)
        .join('\n'),
    );
  }
}

console.log('');
if (!cryptoOk) {
  console.log('The crypto preflight above already explains this: the refusal is this');
  console.log("runtime's, and the same script under a plain `node` will verify the very");
  console.log('same files. Nothing about the network, the cache or the release is wrong.');
  process.exitCode = 1;
} else if (fresh) {
  console.log('Sigstore is reachable and the trust root verified. The app should be able to');
  console.log('verify a download; if it still refuses, the fault is after this point —');
  console.log('the checksum, the bundle, or the certificate identity in verify.ts.');
} else if (cached === true) {
  console.log('The refresh failed but the cached metadata is usable, which is what the app');
  console.log('falls back to. If the app still refused, its cache directory is not this one.');
} else {
  console.log('Both attempts failed, which is exactly what makes the app refuse to install.');
  console.log('The first error above is the real cause — a DNS or connection code means the');
  console.log('host is blocked, a certificate code means TLS interception (try');
  console.log('NODE_EXTRA_CA_CERTS), and a timeout means it is reachable but too slow.');
  process.exitCode = 1;
}
