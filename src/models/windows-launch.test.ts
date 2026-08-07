import { describe, expect, it } from 'vitest';
import { cmdShimLaunch, isCmdSafeArgument, isWindowsShim } from './windows-launch.js';

describe('isWindowsShim', () => {
  it('recognises the two extensions Node will not spawn', () => {
    expect(isWindowsShim('C:\\Programs\\cursor\\bin\\cursor.cmd')).toBe(true);
    expect(isWindowsShim('C:\\x\\y.BAT')).toBe(true);
  });

  it('leaves an executable alone', () => {
    expect(isWindowsShim('C:\\Programs\\cursor\\Cursor.exe')).toBe(false);
    expect(isWindowsShim('/usr/bin/code')).toBe(false);
  });
});

describe('isCmdSafeArgument', () => {
  it('accepts the arguments this actually has to carry', () => {
    expect(isCmdSafeArgument('--folder-uri')).toBe(true);
    expect(isCmdSafeArgument('--new-window')).toBe(true);
    expect(isCmdSafeArgument('vscode-remote://dev-container+7b2f/workspaces/app')).toBe(true);
    expect(
      isCmdSafeArgument('C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\bin\\cursor.cmd'),
    ).toBe(true);
  });

  /**
   * The operators. A denylist written from memory is how one of these ships;
   * the allowlist means forgetting one costs a refused launch instead.
   */
  it('refuses every character cmd.exe would interpret', () => {
    for (const bad of ['&', '|', '<', '>', '^', '(', ')', '"', "'", '`', ';', ',', '=']) {
      expect(isCmdSafeArgument(`vscode-remote://x${bad}y`)).toBe(false);
    }
  });

  /** Expansions rather than operators, and the two most easily forgotten. */
  it('refuses % and !', () => {
    expect(isCmdSafeArgument('%PATH%')).toBe(false);
    expect(isCmdSafeArgument('a!b!')).toBe(false);
  });

  it('refuses whitespace and newlines', () => {
    expect(isCmdSafeArgument('a b')).toBe(false);
    expect(isCmdSafeArgument('a\nb')).toBe(false);
    expect(isCmdSafeArgument('a\tb')).toBe(false);
    expect(isCmdSafeArgument('')).toBe(false);
  });
});

describe('cmdShimLaunch', () => {
  const SHIM = 'C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd';
  const URI = 'vscode-remote://dev-container+7b2f/workspaces/app';

  it('runs the shim through cmd.exe, skipping AutoRun', () => {
    expect(cmdShimLaunch(SHIM, ['--folder-uri', URI])).toEqual({
      file: 'cmd.exe',
      // `/d` skips the user's registry AutoRun, which is a program this app has
      // no business running on their behalf.
      args: ['/d', '/c', SHIM, '--folder-uri', URI],
    });
  });

  /**
   * Fails CLOSED. The caller still holds a resolved binary and a URI to offer
   * for copying, which is a better outcome than an escaped command line.
   */
  it('refuses when an argument would be interpreted', () => {
    expect(cmdShimLaunch(SHIM, ['--folder-uri', 'vscode-remote://x&calc'])).toBeUndefined();
  });

  it('refuses when the shim path itself would be', () => {
    expect(
      cmdShimLaunch('C:\\Program Files\\cursor\\bin\\cursor.cmd', ['--folder-uri', URI]),
    ).toBeUndefined();
  });
});
