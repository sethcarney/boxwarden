import { describe, expect, it } from 'vitest';
import { expandWindowsPath, isSpawnableOnWindows } from './resolve.js';

/**
 * Both functions exist because of one concrete failure: "Open in VS Code" on
 * Windows died with `spawn ... ENOENT` while VS Code was plainly installed.
 * They now guard the terminal launcher on the same grounds.
 *
 * `where code` returns two hits, in this order:
 *
 *   ...\Microsoft VS Code\bin\code       <- a bash script, for Git Bash users
 *   ...\Microsoft VS Code\bin\code.cmd
 *
 * The resolver took the first. Windows cannot execute an extensionless file, so
 * it failed with ENOENT — and taking the second instead fails too, with EINVAL,
 * because Node refuses to spawn a .cmd without `shell: true`. Only the GUI
 * `Code.exe` can actually be launched, and it takes the same --folder-uri flag.
 */
describe('isSpawnableOnWindows', () => {
  it('accepts only what Windows can execute without a shell', () => {
    expect(isSpawnableOnWindows('C:\\VS Code\\Code.exe')).toBe(true);
    expect(isSpawnableOnWindows('C:\\VS Code\\Code.EXE')).toBe(true);
  });

  it('rejects the bash script and the batch shim that ship beside it', () => {
    expect(isSpawnableOnWindows('C:\\VS Code\\bin\\code')).toBe(false);
    expect(isSpawnableOnWindows('C:\\VS Code\\bin\\code.cmd')).toBe(false);
    expect(isSpawnableOnWindows('C:\\VS Code\\bin\\code.bat')).toBe(false);
  });
});

describe('expandWindowsPath', () => {
  it('substitutes environment references', () => {
    expect(
      expandWindowsPath('%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', {
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe');
  });

  /**
   * Undefined rather than a half-expanded string. `\Programs\...\Code.exe` with
   * the variable silently dropped is a real path that could exist and would be
   * the wrong binary.
   */
  it('yields nothing when a referenced variable is missing or empty', () => {
    expect(expandWindowsPath('%LOCALAPPDATA%\\Code.exe', {})).toBeUndefined();
    expect(expandWindowsPath('%LOCALAPPDATA%\\Code.exe', { LOCALAPPDATA: '' })).toBeUndefined();
  });

  it('leaves a path with no references alone', () => {
    expect(expandWindowsPath('/usr/bin/code', {})).toBe('/usr/bin/code');
  });
});
