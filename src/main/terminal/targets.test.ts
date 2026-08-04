import { describe, expect, it } from 'vitest';
import { TERMINAL_TARGETS, terminalTarget, terminalsFor } from './targets.js';

/**
 * The table is data, so what is worth testing is the invariants the launcher
 * assumes about it rather than any individual row.
 */
describe('terminal targets', () => {
  it('has a unique id per entry, since ids cross IPC', () => {
    const ids = TERMINAL_TARGETS.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('claims at least one platform per entry', () => {
    // An entry with no platforms would be probed nowhere and offered nowhere —
    // dead weight that looks like a supported terminal.
    for (const target of TERMINAL_TARGETS) {
      expect(target.platforms.length).toBeGreaterThan(0);
      expect(target.discovery.length).toBeGreaterThan(0);
    }
  });

  it('offers a terminal on each supported platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(terminalsFor(platform).length).toBeGreaterThan(0);
    }
  });

  it('never offers a terminal from another platform', () => {
    // The launcher spawns whatever it is handed. A macOS AppleScript target
    // reaching a Linux probe would spawn osascript there and fail obscurely.
    for (const target of terminalsFor('linux')) {
      expect(target.invocation.kind).not.toBe('applescript');
    }
    expect(terminalsFor('darwin').map((target) => target.id)).toEqual(['iterm2', 'macos-terminal']);
  });

  /**
   * Terminal.app ships with macOS, so probing it before iTerm2 would make it
   * the default on every Mac and leave iTerm2 permanently unreachable as one.
   * The same reasoning puts the always-present fallbacks last on Linux.
   */
  it('probes the terminals a user chose ahead of the ones that are simply there', () => {
    const linux = terminalsFor('linux').map((target) => target.id);
    expect(linux.indexOf('gnome-terminal')).toBeLessThan(linux.indexOf('x-terminal-emulator'));
    expect(linux.indexOf('x-terminal-emulator')).toBeLessThan(linux.indexOf('xterm'));

    const windows = terminalsFor('win32').map((target) => target.id);
    expect(windows.indexOf('windows-terminal')).toBeLessThan(windows.indexOf('windows-console'));
  });

  it('escapes wt arguments, and only wt', () => {
    const escaping = TERMINAL_TARGETS.filter((target) => target.argumentEscaping !== undefined);
    expect(escaping.map((target) => target.id)).toEqual(['windows-terminal']);
  });

  it('resolves an id back to its entry, and an unknown one to nothing', () => {
    expect(terminalTarget('konsole')?.displayName).toBe('Konsole');
    expect(terminalTarget('not-a-terminal')).toBeUndefined();
  });
});
