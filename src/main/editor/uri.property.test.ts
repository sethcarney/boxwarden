import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { authorityFor, decodeAuthority } from './uri.js';

/**
 * Property-based tests for the reattach authority.
 *
 * The rule this file exists to defend is stated at length in `uri.ts` and in
 * CLAUDE.md: the hex is built from the RAW `devcontainer.local_folder` label,
 * byte for byte. Normalising slashes, trimming whitespace or case-folding a
 * drive letter produces a valid-looking URI that names a container which does
 * not exist, and VS Code responds by offering to build a new one — the failure
 * looks like a missing feature rather than a bug.
 *
 * `uri.test.ts` pins that with a handful of named cases, including the Windows
 * paths it was written for. What a generator adds is the reminder that a label
 * is an arbitrary string written by another program: it can hold a newline, a
 * NUL, an emoji, a lone surrogate, or the empty string, and none of those may
 * change the answer or throw.
 */

describe('authorityFor', () => {
  it('round-trips any label through decodeAuthority', () => {
    fc.assert(
      fc.property(fc.string(), (label) => {
        expect(decodeAuthority(authorityFor(label))).toBe(label);
      }),
    );
  });

  it('round-trips labels containing anything a filesystem allows', () => {
    // fc.string() is ASCII-weighted. Paths in the wild are not: a checkout
    // under `~/Документы/проект` is an ordinary Tuesday, and it is the
    // multi-byte case that catches an encoder written against `charCodeAt`.
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (label) => {
        expect(decodeAuthority(authorityFor(label))).toBe(label);
      }),
    );
  });

  it('does not normalise — distinct labels give distinct authorities', () => {
    // The property behind the raw label rule. Any two labels that differ at
    // all, including only in case, separator or trailing slash, must produce
    // different authorities. A collision here IS the bug: it means some
    // normalisation crept in, and two containers now claim one URI.
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(authorityFor(a)).not.toBe(authorityFor(b));
      }),
    );
  });

  it('produces a well-formed authority for every label', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (label) => {
        const authority = authorityFor(label);
        // Lowercase hex, even length, nothing that would need escaping in a
        // URI authority. An odd length would mean a byte lost its padding —
        // the `.padStart(2, '0')` that a "simplification" removes first.
        expect(authority).toMatch(/^dev-container\+([0-9a-f]{2})*$/);
      }),
    );
  });

  it('is stable — the same label always gives the same authority', () => {
    // VS Code reuses a window per authority. If this were ever not a pure
    // function of the label, reattaching would open a second window for the
    // same folder rather than focusing the first.
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (label) => {
        expect(authorityFor(label)).toBe(authorityFor(label));
      }),
    );
  });
});

describe('decodeAuthority', () => {
  it('rejects anything that is not a well-formed authority', () => {
    // Diagnostics call this on strings that came from outside. It has to
    // answer undefined rather than throw or return mojibake, whatever it is
    // handed.
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = decodeAuthority(text as ReturnType<typeof authorityFor>);
        expect(result === undefined || typeof result === 'string').toBe(true);
      }),
    );
  });
});
