/**
 * Pins scripts/devcontainer-open.mjs against the app.
 *
 * The script cannot import src/main/editor/uri.ts — it runs as plain ESM with
 * no build step — so it carries its own copy of the hex encoding. That copy is
 * only safe while it agrees with the original, and "the app opens the container
 * but the documented command builds a URI for one that does not exist" is
 * exactly the kind of drift nobody notices until it wastes an afternoon. This
 * file imports both and asserts they agree.
 */
import { describe, expect, it } from 'vitest';
import { authorityFor as appAuthorityFor, devContainerUri as appUri } from '../src/main/editor/uri';
import { authorityFor, devContainerUri, parseArgs, parseUpResult } from './devcontainer-open.mjs';

const PATHS = [
  '/home/node/boxwarden',
  'C:\\Users\\seth\\code\\boxwarden',
  '/mnt/c/Users/seth/code/boxwarden',
  '/Users/seth/Library/Application Support/box warden',
  '/home/seth/проекты/boxwarden',
  '/home/seth/trailing/',
];

describe('agreement with src/main/editor/uri.ts', () => {
  it.each(PATHS)('builds the same authority for %s', (path) => {
    expect(authorityFor(path)).toBe(appAuthorityFor(path));
  });

  it.each(PATHS)('builds the same URI for %s', (path) => {
    expect(devContainerUri(path, '/workspaces/boxwarden')).toBe(
      appUri(path, '/workspaces/boxwarden'),
    );
  });

  it('agrees on a container path needing escapes', () => {
    expect(devContainerUri('/host', '/workspaces/my project')).toBe(
      appUri('/host', '/workspaces/my project'),
    );
  });
});

describe('parseUpResult', () => {
  it('takes the last JSON object carrying an outcome', () => {
    const stdout = [
      '[12 ms] @devcontainers/cli 0.80.0.',
      '{"outcome":"success","containerId":"abc123","remoteWorkspaceFolder":"/workspaces/boxwarden"}',
    ].join('\n');

    expect(parseUpResult(stdout)).toEqual({
      outcome: 'success',
      containerId: 'abc123',
      remoteWorkspaceFolder: '/workspaces/boxwarden',
    });
  });

  it('ignores JSON progress lines that are not the result', () => {
    const stdout = [
      '{"type":"text","level":2,"timestamp":1,"text":"Building..."}',
      '{"outcome":"error","message":"boom","description":"the container exited"}',
    ].join('\n');

    expect(parseUpResult(stdout)?.outcome).toBe('error');
  });

  it('is undefined when the CLI died before printing a result', () => {
    expect(parseUpResult('Command failed: docker ps\n')).toBeUndefined();
  });
});

describe('parseArgs', () => {
  it('defaults to VS Code and this repo', () => {
    const options = parseArgs([]);
    expect(options.editor).toBe('code');
    expect(options.print).toBe(false);
    expect(options.workspaceFolder.endsWith('boxwarden')).toBe(true);
  });

  it('reads --editor and --print', () => {
    expect(parseArgs(['--editor', 'cursor', '--print'])).toMatchObject({
      editor: 'cursor',
      print: true,
    });
  });

  it('rejects a flag with no value rather than silently eating the next one', () => {
    expect(() => parseArgs(['--editor'])).toThrow(/needs a value/);
  });

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--rebuild'])).toThrow(/unknown argument/);
  });
});
