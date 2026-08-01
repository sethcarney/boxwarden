import { describe, expect, it } from 'vitest';
import type { DevContainer, DevContainerProject, MaybeHostPath } from './index.js';
import {
  asContainerId,
  asProjectId,
  comparableFolder,
  defaultProjectRoots,
  devcontainerName,
  parseProjectRoots,
  partitionProjects,
  resolveProjectRoots,
  shouldDescend,
  sortProjects,
  stripJsonc,
} from './index.js';

function project(overrides: Partial<DevContainerProject> = {}): DevContainerProject {
  return {
    id: asProjectId('/home/dev/code/api/.devcontainer/devcontainer.json'),
    name: 'api',
    folder: { kind: 'posix', path: '/home/dev/code/api' },
    configPath: '/home/dev/code/api/.devcontainer/devcontainer.json',
    configLabel: '.devcontainer/devcontainer.json',
    root: '/home/dev',
    ...overrides,
  };
}

function container(localFolder: MaybeHostPath): DevContainer {
  return {
    id: asContainerId('c'.repeat(64)),
    name: 'vsc-api',
    image: 'vsc-api-features',
    createdAt: new Date('2026-07-20T10:00:00Z'),
    localFolder,
    labels: { localFolderRaw: localFolder.kind === 'unresolved' ? localFolder.raw : '' },
    runtime: { state: 'running', startedAt: new Date('2026-07-27T09:00:00Z'), ports: [] },
  };
}

describe('stripJsonc', () => {
  it('removes line and block comments', () => {
    const source = `{
      // the name shown in the UI
      "name": "api", /* inline */
      "image": "node:22"
    }`;
    expect(JSON.parse(stripJsonc(source))).toEqual({ name: 'api', image: 'node:22' });
  });

  /**
   * The regression this file exists for. Every image reference with a registry
   * host in it contains "//" once you count the scheme, and any comment
   * stripper that does not track string state eats the rest of the document.
   */
  it('leaves slashes inside strings alone', () => {
    const source = '{"image": "https://ghcr.io/org/img", "name": "x // not a comment"}';
    expect(JSON.parse(stripJsonc(source))).toEqual({
      image: 'https://ghcr.io/org/img',
      name: 'x // not a comment',
    });
  });

  it('does not mistake an escaped quote for the end of a string', () => {
    const source = String.raw`{"name": "say \"hi\" // here", "image": "a"}`;
    expect(JSON.parse(stripJsonc(source))).toEqual({ name: 'say "hi" // here', image: 'a' });
  });

  it('drops trailing commas in objects and arrays', () => {
    const source = '{"name": "api", "forwardPorts": [3000, 5432,],}';
    expect(JSON.parse(stripJsonc(source))).toEqual({ name: 'api', forwardPorts: [3000, 5432] });
  });

  /** Byte offsets in a JSON.parse error have to keep pointing at the right line. */
  it('preserves newlines inside block comments', () => {
    const stripped = stripJsonc('{\n/* one\ntwo */\n"name": "x"}');
    expect(stripped.split('\n')).toHaveLength(4);
  });
});

describe('devcontainerName', () => {
  it('reads the name field out of a commented config', () => {
    expect(devcontainerName('{\n  // generated\n  "name": "boxwarden",\n}')).toBe('boxwarden');
  });

  it('returns undefined for a config with no name, so the caller falls back to the folder', () => {
    expect(devcontainerName('{"image": "node:22"}')).toBeUndefined();
  });

  it('returns undefined rather than throwing on a broken config', () => {
    expect(devcontainerName('{ this is not json')).toBeUndefined();
  });

  it('ignores a name that is not a non-empty string', () => {
    expect(devcontainerName('{"name": "   "}')).toBeUndefined();
    expect(devcontainerName('{"name": 42}')).toBeUndefined();
  });
});

describe('shouldDescend', () => {
  it('refuses dot-directories as a class', () => {
    expect(shouldDescend('.git')).toBe(false);
    expect(shouldDescend('.venv')).toBe(false);
    expect(shouldDescend('.devcontainer')).toBe(false);
  });

  it('refuses the expensive well-known directories', () => {
    expect(shouldDescend('node_modules')).toBe(false);
    expect(shouldDescend('Library')).toBe(false);
  });

  it('allows anything else', () => {
    expect(shouldDescend('code')).toBe(true);
    expect(shouldDescend('my-project')).toBe(true);
  });
});

describe('defaultProjectRoots', () => {
  it('is the home directory on macOS and Windows', () => {
    expect(defaultProjectRoots('darwin', '/Users/dev')).toEqual(['/Users/dev']);
    expect(defaultProjectRoots('win32', 'C:\\Users\\dev')).toEqual(['C:\\Users\\dev']);
  });

  /** /workspaces is the one default outside $HOME — it is where a dev container mounts. */
  it('adds /workspaces on Linux', () => {
    expect(defaultProjectRoots('linux', '/home/dev')).toEqual(['/home/dev', '/workspaces']);
  });
});

describe('parseProjectRoots', () => {
  /**
   * The distinction the whole preference hinges on. Folding an empty list into
   * "unset" would make removing the last root silently undo itself.
   */
  it('separates "never configured" from "the user removed everything"', () => {
    expect(parseProjectRoots(undefined)).toBeUndefined();
    expect(parseProjectRoots('not an array')).toBeUndefined();
    expect(parseProjectRoots([])).toEqual([]);
  });

  it('drops non-strings and duplicates from a corrupt file', () => {
    expect(parseProjectRoots(['/a', 42, '/a', '', null, '/b'])).toEqual(['/a', '/b']);
  });
});

describe('resolveProjectRoots', () => {
  const defaults = ['/home/dev', '/workspaces'];

  it('falls back to the defaults when nothing is configured', () => {
    expect(resolveProjectRoots(undefined, defaults)).toEqual([
      { path: '/home/dev', source: 'default' },
      { path: '/workspaces', source: 'default' },
    ]);
  });

  it('honours an explicit empty list rather than reinstating the defaults', () => {
    expect(resolveProjectRoots([], defaults)).toEqual([]);
  });

  it('still calls a configured path a default when it is one', () => {
    expect(resolveProjectRoots(['/home/dev', '/mnt/d/work'], defaults)).toEqual([
      { path: '/home/dev', source: 'default' },
      { path: '/mnt/d/work', source: 'user' },
    ]);
  });
});

describe('comparableFolder', () => {
  it('is case-sensitive for POSIX paths, because POSIX filesystems are', () => {
    expect(comparableFolder({ kind: 'posix', path: '/home/dev/Api' })).not.toBe(
      comparableFolder({ kind: 'posix', path: '/home/dev/api' }),
    );
  });

  /** The extension writes whatever the shell handed it; the walk writes what the OS reports. */
  it('folds case and separators for Windows paths', () => {
    expect(comparableFolder({ kind: 'windows', path: 'c:/Users/dev/api/' })).toBe(
      comparableFolder({ kind: 'windows', path: 'C:\\Users\\dev\\api' }),
    );
  });

  it('keeps the distro in a WSL path, so the same path in two distros does not collide', () => {
    expect(comparableFolder({ kind: 'wsl', distro: 'Ubuntu', path: '/home/dev/api' })).not.toBe(
      comparableFolder({ kind: 'wsl', distro: 'Debian', path: '/home/dev/api' }),
    );
  });

  it('has no answer for an unparseable path', () => {
    expect(comparableFolder({ kind: 'unresolved', raw: 'x', reason: 'y' })).toBeUndefined();
  });
});

describe('partitionProjects', () => {
  it('calls a project built when a container claims its folder', () => {
    const { unbuilt, built } = partitionProjects(
      [project()],
      [container({ kind: 'posix', path: '/home/dev/code/api' })],
    );
    expect(unbuilt).toEqual([]);
    expect(built).toHaveLength(1);
  });

  it('leaves a project unbuilt when the only container is somewhere else', () => {
    const { unbuilt } = partitionProjects(
      [project()],
      [container({ kind: 'posix', path: '/home/dev/code/web' })],
    );
    expect(unbuilt).toHaveLength(1);
  });

  /**
   * A container whose label could not be parsed contributes no folder, so it
   * can never mark a project built. Erring this way lists a project that is
   * arguably already running; erring the other way hides it entirely.
   */
  it('ignores containers with an unresolved host path', () => {
    const { unbuilt } = partitionProjects(
      [project()],
      [container({ kind: 'unresolved', raw: 'relative/path', reason: 'not absolute' })],
    );
    expect(unbuilt).toHaveLength(1);
  });

  it('counts a folder as built when either of its two configs has been', () => {
    const projects = [
      project(),
      project({
        id: asProjectId('/home/dev/code/api/.devcontainer/gpu/devcontainer.json'),
        configPath: '/home/dev/code/api/.devcontainer/gpu/devcontainer.json',
        configLabel: '.devcontainer/gpu/devcontainer.json',
        variant: 'gpu',
      }),
    ];
    const { unbuilt, built } = partitionProjects(projects, [
      container({ kind: 'posix', path: '/home/dev/code/api' }),
    ]);
    expect(unbuilt).toEqual([]);
    expect(built).toHaveLength(2);
  });
});

describe('sortProjects', () => {
  it('orders by name case-insensitively, then by config path', () => {
    const beta = project({ name: 'beta', configPath: '/b/.devcontainer/devcontainer.json' });
    const alphaOne = project({ name: 'Alpha', configPath: '/a/.devcontainer/devcontainer.json' });
    const alphaTwo = project({
      name: 'alpha',
      configPath: '/a/.devcontainer/gpu/devcontainer.json',
    });

    expect(sortProjects([beta, alphaTwo, alphaOne]).map((entry) => entry.configPath)).toEqual([
      '/a/.devcontainer/devcontainer.json',
      '/a/.devcontainer/gpu/devcontainer.json',
      '/b/.devcontainer/devcontainer.json',
    ]);
  });
});
