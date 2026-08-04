import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { appleScriptString, posixQuote, posixQuoteOne } from './command.js';

/**
 * Property-based tests for the quoting functions, which are the security
 * boundary of the open-a-terminal feature.
 *
 * `command.test.ts` next door asks whether one deliberately hostile string is
 * handled. That test is worth more than this one for reading — it names the
 * attack. What it cannot do is find the string nobody thought of, and quoting
 * bugs are exactly the class where the missed case is a character somebody
 * chose precisely because it did not occur to the author: a lone surrogate, a
 * NUL, a backslash immediately before the closing quote, `'\''` written out
 * longhand by a user who was trying to be clever.
 *
 * So these tests do not assert on outputs. They assert on the *property* the
 * outputs must have, over ten thousand strings fast-check picks — including,
 * because that is what a shrinking generator is for, the smallest string that
 * breaks it.
 *
 * The property in every case is round-tripping: quote a string, have the
 * receiving language parse it back, and get the original. That is a stronger
 * claim than "the dangerous characters are escaped", and it is the claim the
 * feature actually needs — anything a shell reconstructs as a different string
 * from the one we quoted is a command the user did not write.
 */

/**
 * Interpret a POSIX single-quoted word the way `sh` does, so the property has
 * something to check against.
 *
 * Deliberately a separate, dumber implementation rather than a call back into
 * `posixQuoteOne`'s logic: a test that inverts the code under test with the
 * code under test proves only that it is self-consistent. This one knows just
 * one rule — inside single quotes nothing is special — which is the rule the
 * real shell has.
 */
function unquotePosix(quoted: string): string {
  let out = '';
  let index = 0;
  let inQuotes = false;

  while (index < quoted.length) {
    const char = quoted.charAt(index);
    if (char === "'") {
      inQuotes = !inQuotes;
      index += 1;
      continue;
    }
    if (!inQuotes && char === '\\') {
      // Outside quotes, a backslash escapes the next character. This is how
      // the `'\''` idiom smuggles a single quote through.
      out += quoted.charAt(index + 1);
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }

  return out;
}

/** Interpret an AppleScript string literal, per the escapes the encoder emits. */
function unquoteAppleScript(literal: string): string {
  const body = literal.slice(1, -1);
  let out = '';
  let index = 0;

  while (index < body.length) {
    const char = body.charAt(index);
    if (char !== '\\') {
      out += char;
      index += 1;
      continue;
    }
    const next = body.charAt(index + 1);
    out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
    index += 2;
  }

  return out;
}

describe('posixQuoteOne', () => {
  it('round-trips any string through a POSIX shell', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(unquotePosix(posixQuoteOne(value))).toBe(value);
      }),
    );
  });

  it('round-trips strings made of shell metacharacters', () => {
    // fc.string() rarely produces a dense run of these on its own, and dense
    // is where quoting breaks: `'''` and `\'` are the interesting inputs, not
    // a metacharacter surrounded by letters.
    const metacharacters = fc.string({
      unit: fc.constantFrom(...`'"\\$\`;&|<>()[]{}*?!#~ \t\n\r`.split('')),
      maxLength: 40,
    });

    fc.assert(
      fc.property(metacharacters, (value) => {
        expect(unquotePosix(posixQuoteOne(value))).toBe(value);
      }),
    );
  });

  it('leaves no unquoted region a shell could interpret', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const quoted = posixQuoteOne(value);
        // Every character is either inside single quotes, or is one of the
        // four characters of the `'\''` idiom that closes and reopens them.
        // Anything else outside the quotes would be shell syntax.
        expect(quoted.replaceAll(`'\\''`, '')).toMatch(/^'[^']*'$/);
      }),
    );
  });

  it('quotes a value containing only quotes', () => {
    // Worth its own case because it is the input where a naive "count the
    // quotes are balanced" intuition is wrong: `'` becomes `''\'''`, which
    // holds five of them. Only the round trip settles it.
    fc.assert(
      fc.property(fc.string({ unit: fc.constant("'"), maxLength: 12 }), (value) => {
        expect(unquotePosix(posixQuoteOne(value))).toBe(value);
      }),
    );
  });
});

describe('posixQuote', () => {
  it('preserves argv boundaries whatever the arguments contain', () => {
    // The join is the risk here rather than the quoting: an argument
    // containing a space, or an empty one, must stay exactly one argument.
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 6 }), (argv) => {
        const line = posixQuote(argv);
        const split: string[] = [];
        let current = '';
        let inQuotes = false;
        let index = 0;

        while (index < line.length) {
          const char = line.charAt(index);
          if (char === "'") {
            inQuotes = !inQuotes;
            index += 1;
          } else if (!inQuotes && char === '\\') {
            current += line.charAt(index + 1);
            index += 2;
          } else if (!inQuotes && char === ' ') {
            split.push(current);
            current = '';
            index += 1;
          } else {
            current += char;
            index += 1;
          }
        }
        split.push(current);

        expect(split).toEqual([...argv]);
      }),
    );
  });
});

describe('appleScriptString', () => {
  it('round-trips any string through an AppleScript literal', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(unquoteAppleScript(appleScriptString(value))).toBe(value);
      }),
    );
  });

  it('never emits a raw newline, which would fail to compile', () => {
    // This is the one that is not about attack at all. AppleScript string
    // literals cannot span lines, and containerShellScript is multi-line by
    // construction, so a missed escape here is a feature that silently never
    // works on macOS rather than a vulnerability.
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(appleScriptString(value)).not.toMatch(/[\n\r]/);
      }),
    );
  });

  it('closes the literal exactly once', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const literal = appleScriptString(value);
        expect(literal.startsWith('"')).toBe(true);
        expect(literal.endsWith('"')).toBe(true);
        // No unescaped quote in the body: an odd run of backslashes before a
        // quote would mean the literal ends early and the rest is code.
        expect(literal.slice(1, -1)).not.toMatch(/(?<!\\)(\\\\)*"/);
      }),
    );
  });
});
