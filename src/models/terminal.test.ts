import { describe, expect, it } from 'vitest';
import {
  MAX_STARTUP_COMMAND_LENGTH,
  normaliseStartupCommand,
  parseStartupCommands,
  withStartupCommand,
} from './terminal.js';

/**
 * The preferences file lives on disk where a user, an editor, or a
 * half-finished write can reach it, so every case below is really "what happens
 * when the file is not what we wrote". The answer has to be a map, never a
 * throw: losing a startup command is an annoyance, an app that will not start
 * is not.
 */
describe('parseStartupCommands', () => {
  it('reads a well-formed map', () => {
    expect(parseStartupCommands({ '/home/dev/webapp': 'bun run dev' })).toEqual({
      '/home/dev/webapp': 'bun run dev',
    });
  });

  it('treats anything that is not an object as no commands', () => {
    for (const raw of [undefined, null, 42, 'commands', [], true]) {
      expect(parseStartupCommands(raw)).toEqual({});
    }
  });

  it('drops individual bad entries and keeps the rest', () => {
    // One malformed command should cost the user that command, not the file.
    expect(
      parseStartupCommands({ good: 'make watch', numeric: 7, nested: { a: 1 }, '': 'no key' }),
    ).toEqual({ good: 'make watch' });
  });

  it('normalises on the way in, so a hand-edited file cannot smuggle a stray CR through', () => {
    expect(parseStartupCommands({ a: '  make \r\n' })).toEqual({ a: 'make' });
  });
});

describe('normaliseStartupCommand', () => {
  it('clears on blank input', () => {
    expect(normaliseStartupCommand('')).toBeUndefined();
    expect(normaliseStartupCommand('   \n ')).toBeUndefined();
  });

  /**
   * NUL is stripped rather than rejected because it cannot survive the journey
   * regardless: it terminates the string at the exec boundary, so a command
   * containing one would be truncated somewhere far less visible than here.
   */
  it('strips the characters that would be silently mangled later', () => {
    expect(normaliseStartupCommand('echo\0 hi')).toBe('echo hi');
    expect(normaliseStartupCommand('echo\r\nhi')).toBe('echo\nhi');
  });

  it('keeps the shell syntax that is the whole point of the field', () => {
    // The command runs inside the container. Quoting it out of existence here
    // would break the feature, not secure it — containment is argv, not a filter.
    expect(normaliseStartupCommand('cd $HOME && bun run dev | tee log')).toBe(
      'cd $HOME && bun run dev | tee log',
    );
  });

  it('bounds the length', () => {
    expect(normaliseStartupCommand('x'.repeat(5_000))).toHaveLength(MAX_STARTUP_COMMAND_LENGTH);
  });
});

describe('withStartupCommand', () => {
  const base = parseStartupCommands({ a: 'one', b: 'two' });

  it('sets without disturbing the others', () => {
    expect(withStartupCommand(base, 'c', 'three')).toEqual({ a: 'one', b: 'two', c: 'three' });
  });

  it('deletes rather than storing an empty value', () => {
    // An empty entry is indistinguishable from a mistake, and the file would
    // grow for every container the user typed into and cleared again.
    expect(Object.keys(withStartupCommand(base, 'a', '   '))).toEqual(['b']);
  });

  it('does not mutate the map it was given', () => {
    withStartupCommand(base, 'a', 'changed');
    expect(base['a']).toBe('one');
  });
});
