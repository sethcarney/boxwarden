import { describe, expect, it } from 'vitest';
import { parseLocalFolder } from './host-path.js';

describe('parseLocalFolder', () => {
  it('reads an absolute POSIX path', () => {
    expect(parseLocalFolder('/home/dev/code/webapp')).toEqual({
      kind: 'posix',
      path: '/home/dev/code/webapp',
    });
  });

  it('reads a Windows drive path and normalises forward slashes', () => {
    expect(parseLocalFolder('C:\\Users\\dev\\code\\app')).toEqual({
      kind: 'windows',
      path: 'C:\\Users\\dev\\code\\app',
    });
    expect(parseLocalFolder('C:/Users/dev/code/app')).toEqual({
      kind: 'windows',
      path: 'C:\\Users\\dev\\code\\app',
    });
  });

  it('reads both WSL UNC spellings and converts the remainder to a Linux path', () => {
    expect(parseLocalFolder('\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj')).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      path: '/home/dev/proj',
    });
    // The older \\wsl$\ form is still emitted by installed VS Code versions.
    expect(parseLocalFolder('\\\\wsl$\\Debian\\srv\\thing')).toEqual({
      kind: 'wsl',
      distro: 'Debian',
      path: '/srv/thing',
    });
  });

  it('treats a non-WSL UNC path as an ordinary Windows path', () => {
    expect(parseLocalFolder('\\\\fileserver\\share\\proj')).toEqual({
      kind: 'windows',
      path: '\\\\fileserver\\share\\proj',
    });
  });

  it.each([
    ['', 'an empty label'],
    ['relative/not/absolute', 'a relative path'],
    ['C:', 'a bare drive letter'],
    ['\\\\wsl.localhost\\', 'a WSL path with no distro'],
  ])('degrades %j (%s) to unresolved rather than dropping it', (input) => {
    const result = parseLocalFolder(input);
    expect(result.kind).toBe('unresolved');
    // The raw value must survive: the UI shows it, and it is the only clue in
    // a bug report about a container that renders oddly.
    if (result.kind === 'unresolved') {
      expect(result.raw).toBe(input);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('keeps the untrimmed original in `raw` when the label has stray whitespace', () => {
    const result = parseLocalFolder('  nonsense  ');
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') expect(result.raw).toBe('  nonsense  ');
  });
});
