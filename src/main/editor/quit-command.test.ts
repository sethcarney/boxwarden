import { describe, expect, it } from 'vitest';
import { editorQuitPlan, probeSaysRunning } from './quit-command.js';

describe('editorQuitPlan', () => {
  it('answers undefined for a platform it has no plan for', () => {
    expect(editorQuitPlan('freebsd')).toBeUndefined();
    expect(editorQuitPlan('')).toBeUndefined();
  });

  /**
   * The graceful step must be the quit the user's own ⌘Q / Alt-F4 delivers —
   * hot exit runs, unsaved work is kept — so no platform's graceful arm may
   * carry a force flag or a kill signal.
   */
  it('keeps force out of the graceful step on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const plan = editorQuitPlan(platform);
      expect(plan).toBeDefined();
      expect(plan?.graceful.args).not.toContain('/F');
      expect(plan?.graceful.args).not.toContain('-9');
      expect(plan?.graceful.args).not.toContain('-KILL');
    }
  });

  it('targets only stable VS Code, never a fork', () => {
    // Insiders is `Code - Insiders.exe` / `.vscode-server-insiders`; Cursor
    // and Windsurf have their own names. None may match: their support was
    // removed and this button has never been tested against them.
    for (const platform of ['win32', 'darwin', 'linux']) {
      const plan = editorQuitPlan(platform);
      const everything = JSON.stringify(plan);
      expect(everything).not.toMatch(/insiders/i);
      expect(everything).not.toMatch(/cursor/i);
      expect(everything).not.toMatch(/windsurf/i);
    }
  });

  /**
   * A bare `tell application … to quit` LAUNCHES the app to deliver the
   * event when it is not running — the one AppleScript trap this feature
   * cannot afford, since the probe and the quit race a user who just quit by
   * hand.
   */
  it('guards the macOS quit behind "is running"', () => {
    const script = editorQuitPlan('darwin')?.graceful.args.join(' ') ?? '';
    expect(script).toContain('is running');
  });

  it('matches the snap and flatpak spellings of the Linux install', () => {
    const pattern = editorQuitPlan('linux')?.probe.args.at(-1) ?? '';
    const regex = new RegExp(pattern);
    // deb, and the snap that mounts the deb layout under /snap:
    expect(regex.test('/usr/share/code/code --no-sandbox')).toBe(true);
    expect(regex.test('/snap/code/165/usr/share/code/code')).toBe(true);
    // flatpak:
    expect(regex.test('/app/extra/vscode/code')).toBe(true);
    // NOT an ordinary process that merely mentions code:
    expect(regex.test('node /home/dev/code/server.js')).toBe(false);
  });

  it('takes the whole tree on the Windows force, so the probe can go quiet', () => {
    const force = editorQuitPlan('win32')?.force;
    expect(force?.args).toContain('/F');
    expect(force?.args).toContain('/T');
  });
});

describe('probeSaysRunning', () => {
  it('reads the exit code on POSIX, where pgrep speaks that way', () => {
    expect(probeSaysRunning('linux', 0, '')).toBe(true);
    expect(probeSaysRunning('linux', 1, '')).toBe(false);
    expect(probeSaysRunning('darwin', 0, '12345\n')).toBe(true);
    expect(probeSaysRunning('darwin', 1, '')).toBe(false);
  });

  /** `tasklist` exits 0 either way; the answer is in the output. */
  it('reads stdout on Windows, where tasklist always exits 0', () => {
    expect(
      probeSaysRunning('win32', 0, 'Code.exe                      1234 Console    1   210,000 K'),
    ).toBe(true);
    expect(
      probeSaysRunning(
        'win32',
        0,
        'INFO: No tasks are running which match the specified criteria.',
      ),
    ).toBe(false);
  });
});
