import { describe, expect, it } from 'vitest';
import { parseLocalFolder, withWslDistro, wslDistroFromMountSources } from './host-path.js';

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

describe('wslDistroFromMountSources', () => {
  it('recovers the distro from Docker Desktop\u2019s WSL staging paths', () => {
    expect(
      wslDistroFromMountSources([
        '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/9f2c1a',
      ]),
    ).toBe('Ubuntu');
    expect(
      wslDistroFromMountSources(['/mnt/wsl/docker-desktop-bind-mounts/Ubuntu-22.04/9f2c1a']),
    ).toBe('Ubuntu-22.04');
  });

  it('finds it among unrelated mounts', () => {
    expect(
      wslDistroFromMountSources([
        '/var/run/docker.sock',
        '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Debian/abc',
        '/some/volume',
      ]),
    ).toBe('Debian');
  });

  /**
   * The false-positive cases. A bind-mounted Windows drive and a native Linux
   * mount must both come back undefined, or every Linux user's paths would be
   * relabelled as WSL.
   */
  it('ignores Windows drive mounts and ordinary Linux paths', () => {
    expect(wslDistroFromMountSources(['/run/desktop/mnt/host/c/Users/dev/code'])).toBeUndefined();
    expect(wslDistroFromMountSources(['/home/dev/code/webapp'])).toBeUndefined();
    expect(wslDistroFromMountSources([])).toBeUndefined();
  });

  it('ignores a staging path with an empty distro segment', () => {
    expect(wslDistroFromMountSources(['/docker-desktop-bind-mounts//abc'])).toBeUndefined();
  });
});

describe('withWslDistro', () => {
  it('upgrades a bare POSIX path when a distro was found', () => {
    expect(withWslDistro({ kind: 'posix', path: '/home/dev/proj' }, 'Ubuntu')).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      path: '/home/dev/proj',
    });
  });

  it('leaves the path alone when no distro was found', () => {
    const posix = { kind: 'posix', path: '/home/dev/proj' } as const;
    expect(withWslDistro(posix, undefined)).toBe(posix);
  });

  /**
   * Only `posix` is ambiguous. Attaching a distro to an unresolved path would
   * be inventing a location rather than discovering one.
   */
  it('never touches windows, wsl, or unresolved paths', () => {
    const windows = { kind: 'windows', path: 'C:\\code' } as const;
    const wsl = { kind: 'wsl', distro: 'Debian', path: '/srv' } as const;
    const unresolved = { kind: 'unresolved', raw: 'junk', reason: 'nope' } as const;

    expect(withWslDistro(windows, 'Ubuntu')).toBe(windows);
    expect(withWslDistro(wsl, 'Ubuntu')).toBe(wsl);
    expect(withWslDistro(unresolved, 'Ubuntu')).toBe(unresolved);
  });
});
