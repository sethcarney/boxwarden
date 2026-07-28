import { describe, expect, it } from 'vitest';
import { asContainerPath } from '../../domain/index.js';
import { authorityFor, decodeAuthority, devContainerUri } from './uri.js';

describe('authorityFor', () => {
  it('hex-encodes the host path exactly as VS Code does', () => {
    // Computed independently: Buffer.from('/home/dev/code/webapp').toString('hex')
    expect(authorityFor('/home/dev/code/webapp')).toBe(
      'dev-container+2f686f6d652f6465762f636f64652f776562617070',
    );
  });

  it('encodes non-ASCII paths as UTF-8 bytes', () => {
    expect(authorityFor('/home/dev/café')).toBe('dev-container+2f686f6d652f6465762f636166c3a9');
  });

  it('round-trips through decodeAuthority', () => {
    for (const path of ['/home/dev/proj', 'C:\\Users\\dev\\proj', '\\\\wsl.localhost\\Ubuntu\\x']) {
      expect(decodeAuthority(authorityFor(path))).toBe(path);
    }
  });
});

describe('devContainerUri', () => {
  it('builds the full remote URI', () => {
    expect(devContainerUri('/home/dev/code/webapp', asContainerPath('/workspaces/webapp'))).toBe(
      'vscode-remote://dev-container+2f686f6d652f6465762f636f64652f776562617070/workspaces/webapp',
    );
  });

  /**
   * The reattach contract. Normalising the host path before hex-encoding
   * produces a valid-looking URI for a container that does not exist, and VS
   * Code responds by offering to build a new one — so these must differ.
   */
  it('does not normalise the host path, because the authority must match byte for byte', () => {
    const backslashes = devContainerUri('C:\\Users\\dev\\app', asContainerPath('/workspaces/app'));
    const forwardSlashes = devContainerUri('C:/Users/dev/app', asContainerPath('/workspaces/app'));
    expect(backslashes).not.toBe(forwardSlashes);

    const trailing = devContainerUri('/home/dev/app/', asContainerPath('/workspaces/app'));
    const noTrailing = devContainerUri('/home/dev/app', asContainerPath('/workspaces/app'));
    expect(trailing).not.toBe(noTrailing);
  });

  it('percent-encodes path segments without eating the separators', () => {
    const uri = devContainerUri('/home/dev/p', asContainerPath('/workspaces/my project'));
    expect(uri).toContain('/workspaces/my%20project');
    expect(uri).not.toContain('%2Fworkspaces');
  });

  it('escapes characters that would otherwise terminate the URI path', () => {
    const uri = devContainerUri('/home/dev/p', asContainerPath('/workspaces/a#b?c'));
    expect(uri?.endsWith('/workspaces/a%23b%3Fc')).toBe(true);
  });

  it('adds a leading slash when the workspace folder lacks one', () => {
    const uri = devContainerUri('/home/dev/p', asContainerPath('workspaces/app'));
    expect(uri).toBe(`vscode-remote://${authorityFor('/home/dev/p')}/workspaces/app`);
  });

  it('returns undefined for an empty host path rather than an authority-less URI', () => {
    expect(devContainerUri('', asContainerPath('/workspaces/app'))).toBeUndefined();
    expect(devContainerUri('   ', asContainerPath('/workspaces/app'))).toBeUndefined();
  });
});

describe('decodeAuthority', () => {
  it('rejects malformed authorities instead of returning garbage', () => {
    expect(decodeAuthority('nonsense' as never)).toBeUndefined();
    expect(decodeAuthority('dev-container+xyz' as never)).toBeUndefined();
    expect(decodeAuthority('dev-container+abc' as never)).toBeUndefined();
  });
});
