import { describe, expect, it } from 'vitest';
import { parseDevcontainerVersion } from './resolve.js';

describe('parseDevcontainerVersion', () => {
  it('reads the bare semver line the CLI prints', () => {
    expect(parseDevcontainerVersion('0.88.0\n')).toBe('0.88.0');
    expect(parseDevcontainerVersion('  0.72.1-pre.1\n')).toBe('0.72.1-pre.1');
  });

  /**
   * A wrapper script that chats before exec'ing the real thing, or npm
   * printing an update nag, must read as "could not parse" rather than as a
   * version — the value is shown in diagnostics, and a lie there costs more
   * than an honest shrug.
   */
  it('refuses anything that does not start with a version', () => {
    expect(parseDevcontainerVersion('')).toBeUndefined();
    expect(parseDevcontainerVersion('devcontainer 0.88.0')).toBeUndefined();
    expect(parseDevcontainerVersion('npm WARN old lockfile\n0.88.0')).toBeUndefined();
  });
});
