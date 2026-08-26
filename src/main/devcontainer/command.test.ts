import { describe, expect, it } from 'vitest';
import { devcontainerUpInvocation, parseUpOutcome } from './command.js';

describe('devcontainerUpInvocation', () => {
  it('builds the argv from the raw folder spelling, byte for byte', () => {
    const invocation = devcontainerUpInvocation({
      binaryPath: '/usr/local/bin/devcontainer',
      // Trailing slash kept on purpose: the CLI matches the existing
      // container by this label spelling, exact-match first, so "cleaning"
      // it here is how a rebuild orphans the container it meant to replace.
      workspaceFolderRaw: '/home/dev/webapp/',
      flavour: 'posix',
    });

    expect(invocation).toEqual({
      ok: true,
      command: '/usr/local/bin/devcontainer',
      args: ['up', '--workspace-folder', '/home/dev/webapp/'],
    });
  });

  it('names the config for a variant, and the remove flag for a rebuild', () => {
    const invocation = devcontainerUpInvocation({
      binaryPath: '/usr/local/bin/devcontainer',
      workspaceFolderRaw: '/home/dev/webapp',
      flavour: 'posix',
      configPath: '/home/dev/webapp/.devcontainer/gpu/devcontainer.json',
      removeExistingContainer: true,
    });

    expect(invocation.ok).toBe(true);
    if (!invocation.ok) return;
    expect(invocation.args).toEqual([
      'up',
      '--workspace-folder',
      '/home/dev/webapp',
      '--config',
      '/home/dev/webapp/.devcontainer/gpu/devcontainer.json',
      '--remove-existing-container',
    ]);
  });

  /**
   * Running the CLI inside a distro needs the CLI installed inside that
   * distro, which no probe of this machine has established. A refusal that
   * points at the copy button is honest; a spawn that dies on a missing
   * binary looks like the build failing.
   */
  it('refuses a WSL workspace rather than guessing at the distro', () => {
    const invocation = devcontainerUpInvocation({
      binaryPath: '/usr/local/bin/devcontainer',
      workspaceFolderRaw: '/home/dev/webapp',
      flavour: 'wsl',
    });
    expect(invocation.ok).toBe(false);
    if (invocation.ok) return;
    expect(invocation.reason).toContain('WSL');
  });

  it('refuses an empty folder', () => {
    const invocation = devcontainerUpInvocation({
      binaryPath: '/usr/local/bin/devcontainer',
      workspaceFolderRaw: '   ',
      flavour: 'posix',
    });
    expect(invocation.ok).toBe(false);
  });
});

describe('parseUpOutcome', () => {
  it('finds the result object at the end of a noisy stream', () => {
    const stdout = [
      'Resolving Feature dependencies...',
      '{"type":"progress","name":"pull"}',
      '{"outcome":"success","containerId":"abc123","remoteUser":"node"}',
      '',
    ].join('\n');
    expect(parseUpOutcome(stdout)).toEqual({ kind: 'success' });
  });

  it('carries the CLI’s own words for a failure, deduplicated', () => {
    const outcome = parseUpOutcome(
      '{"outcome":"error","message":"Command failed","description":"Dockerfile not found."}',
    );
    expect(outcome).toEqual({
      kind: 'error',
      message: 'Command failed — Dockerfile not found.',
    });

    // Both fields carrying one sentence must not print it twice.
    expect(parseUpOutcome('{"outcome":"error","message":"boom","description":"boom"}')).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  /**
   * A crash before the CLI could report — bad arguments, an unreadable
   * config — leaves no result line, and the caller falls back to stderr.
   * Conflating that with "the build failed" would put a generic sentence
   * where the real one was available.
   */
  it('reports an absent result as unparseable, not as an error', () => {
    expect(parseUpOutcome('')).toEqual({ kind: 'unparseable' });
    expect(parseUpOutcome('npm ERR! enoent')).toEqual({ kind: 'unparseable' });
    // An outcome value from a future CLI it does not recognise is an error
    // with no message, not a success.
    expect(parseUpOutcome('{"outcome":"cancelled"}')).toEqual({
      kind: 'error',
      message: 'The build failed.',
    });
  });
});
