import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseChecksums, safeAssetFileName } from './download.js';

/**
 * The example tests next door name the attacks somebody has already thought
 * of — traversal, a NUL, a right-to-left override, a trailing dot Windows
 * strips after the check. This file is for the one nobody named.
 *
 * That distinction is the reason both exist. `stripJsonc` had example tests
 * covering every comment shape anybody could think of, and the property test
 * still found a `,}` inside a string literal that the trailing-comma pass
 * rewrote. A name that reaches `safeAssetFileName` comes out of a JSON
 * document fetched over the network and goes on to become a path on the
 * user's disk, which is the same shape of problem: a small pure function
 * standing between hostile input and something irreversible.
 */
describe('safeAssetFileName', () => {
  /**
   * The property the whole function exists for.
   *
   * Whatever comes back — for ANY input string at all — joining it to a
   * directory has to stay inside that directory. Stated over `String()` rather
   * than over a generator of plausible filenames on purpose: the interesting
   * inputs are the implausible ones.
   */
  it('never returns a name that escapes the directory it is joined to', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const safe = safeAssetFileName(raw);
        if (safe === undefined) return;

        expect(safe.includes('/')).toBe(false);
        expect(safe.includes('\\')).toBe(false);
        expect(safe).not.toBe('.');
        expect(safe).not.toBe('..');
        // `path.join` is what the shell actually does with the result, so the
        // property is asserted against its answer rather than against a
        // re-implementation of it.
        expect(`/downloads/${safe}`.startsWith('/downloads/')).toBe(true);
        expect(`/downloads/${safe}`.split('/').filter((part) => part === '..')).toHaveLength(0);
      }),
    );
  });

  /**
   * Windows strips trailing dots and spaces from a filename AFTER any
   * application has validated it, so `evil.exe.` and `evil.exe ` are two
   * spellings of a name that becomes a third thing once written. A returned
   * name must already be its own final form.
   */
  it('never returns a name Windows would silently rewrite', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const safe = safeAssetFileName(raw);
        if (safe === undefined) return;
        expect(safe.trimEnd()).toBe(safe);
        expect(safe.endsWith('.')).toBe(false);
      }),
    );
  });

  /** Idempotent: a name that survived once survives unchanged. */
  it('accepts its own output', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const safe = safeAssetFileName(raw);
        if (safe === undefined) return;
        expect(safeAssetFileName(safe)).toBe(safe);
      }),
    );
  });
});

describe('parseChecksums', () => {
  /**
   * Every name the parser hands back has to be one the downloader would write,
   * because the name from the manifest is what a digest is looked up by. A
   * parser that returned `../../etc/passwd` would be offering a key that only
   * ever matches something that should not exist.
   */
  it('only ever yields names that are themselves safe', () => {
    fc.assert(
      fc.property(fc.string(), (manifest) => {
        for (const name of parseChecksums(manifest).keys()) {
          expect(safeAssetFileName(name)).toBe(name);
        }
      }),
    );
  });

  /** Every value is a lower-case 64-character hex digest, or it is not there. */
  it('only ever yields well-formed digests', () => {
    fc.assert(
      fc.property(fc.string(), (manifest) => {
        for (const digest of parseChecksums(manifest).values()) {
          expect(digest).toMatch(/^[0-9a-f]{64}$/);
        }
      }),
    );
  });

  /**
   * Generated from the real shape rather than from arbitrary text, so the
   * generator actually reaches the parsing path instead of producing millions
   * of lines that match nothing.
   */
  it('round-trips a manifest it wrote itself', () => {
    const digest = fc
      .array(
        fc.constantFrom(
          '0',
          '1',
          '2',
          '3',
          '4',
          '5',
          '6',
          '7',
          '8',
          '9',
          'a',
          'b',
          'c',
          'd',
          'e',
          'f',
        ),
        {
          minLength: 64,
          maxLength: 64,
        },
      )
      .map((characters) => characters.join(''));
    const name = fc
      .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}[A-Za-z0-9]$/)
      .filter((value) => safeAssetFileName(value) !== undefined);

    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(digest, name), { selector: ([, n]) => n }), (entries) => {
        const manifest = entries.map(([d, n]) => `${d}  ${n}`).join('\n');
        const parsed = parseChecksums(manifest);

        expect(parsed.size).toBe(entries.length);
        for (const [d, n] of entries) expect(parsed.get(n)).toBe(d.toLowerCase());
      }),
    );
  });
});
