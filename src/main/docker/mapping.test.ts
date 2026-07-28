import { describe, expect, it } from 'vitest';
import {
  mapContainer,
  mapRuntime,
  parsePorts,
  resolveWorkspaceFolder,
  type InspectResponse,
} from './mapping.js';
import { parseLocalFolder } from './host-path.js';

const BASE: InspectResponse = {
  Id: 'deadbeef0000000000000000000000000000000000000000000000000000cafe',
  Name: '/vsc-webapp-9f2c1a-uid',
  Created: '2026-07-20T10:00:00Z',
  State: { Status: 'running', StartedAt: '2026-07-27T09:00:00Z' },
  Config: {
    Image: 'vsc-webapp-features',
    WorkingDir: '/workspaces/webapp',
    Labels: { 'devcontainer.local_folder': '/home/dev/code/webapp' },
  },
};

describe('mapContainer', () => {
  it('maps a running dev container', () => {
    const result = mapContainer(BASE);
    expect(result).toBeDefined();
    expect(result?.name).toBe('vsc-webapp-9f2c1a-uid');
    expect(result?.image).toBe('vsc-webapp-features');
    expect(result?.localFolder).toEqual({ kind: 'posix', path: '/home/dev/code/webapp' });
    expect(result?.workspaceFolder).toBe('/workspaces/webapp');
    expect(result?.runtime.state).toBe('running');
  });

  it('returns undefined for a container with no devcontainer label', () => {
    const plain: InspectResponse = { ...BASE, Config: { ...BASE.Config, Labels: {} } };
    expect(mapContainer(plain)).toBeUndefined();
  });

  it('keeps the raw label verbatim even when the parse degrades', () => {
    const odd: InspectResponse = {
      ...BASE,
      Config: { ...BASE.Config, Labels: { 'devcontainer.local_folder': 'not/absolute' } },
    };
    const result = mapContainer(odd);
    // Still listed — the row renders greyed rather than vanishing.
    expect(result).toBeDefined();
    expect(result?.localFolder.kind).toBe('unresolved');
    // And the raw value survives for URI construction and for the UI.
    expect(result?.labels.localFolderRaw).toBe('not/absolute');
  });

  it('carries the compose project label through', () => {
    const compose: InspectResponse = {
      ...BASE,
      Config: {
        ...BASE.Config,
        Labels: {
          'devcontainer.local_folder': '/home/dev/code/platform',
          'com.docker.compose.project': 'platform_devcontainer',
        },
      },
    };
    expect(mapContainer(compose)?.labels.composeProject).toBe('platform_devcontainer');
  });

  it('falls back to a shortened id when the container has no name', () => {
    const unnamed: InspectResponse = { ...BASE, Name: '' };
    expect(mapContainer(unnamed)?.name).toBe('deadbeef0000');
  });

  it('attaches published ports to the running arm', () => {
    const withPorts: InspectResponse = {
      ...BASE,
      NetworkSettings: { Ports: { '5173/tcp': [{ HostIp: '0.0.0.0', HostPort: '5173' }] } },
    };
    const runtime = mapContainer(withPorts)?.runtime;
    expect(runtime?.state).toBe('running');
    if (runtime?.state === 'running') {
      expect(runtime.ports).toEqual([
        { containerPort: 5173, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 5173 },
      ]);
    }
  });
});

describe('mapRuntime', () => {
  it('maps each Docker state onto the matching domain arm', () => {
    expect(mapRuntime({ Status: 'created' })).toEqual({ state: 'created' });
    expect(mapRuntime({ Status: 'removing' })).toEqual({ state: 'removing' });
    expect(mapRuntime({ Status: 'dead' })).toEqual({ state: 'dead' });
  });

  it('keeps the exit code, which is the difference between "stopped" and "OOM-killed"', () => {
    const runtime = mapRuntime({
      Status: 'exited',
      ExitCode: 137,
      FinishedAt: '2026-07-27T08:00:00Z',
    });
    expect(runtime).toEqual({
      state: 'exited',
      exitCode: 137,
      finishedAt: new Date('2026-07-27T08:00:00Z'),
    });
  });

  it('carries health through on the running arm', () => {
    const runtime = mapRuntime({
      Status: 'running',
      StartedAt: '2026-07-27T09:00:00Z',
      Health: { Status: 'unhealthy' },
    });
    expect(runtime.state === 'running' && runtime.health).toBe('unhealthy');
  });

  it('drops an unrecognised health value rather than widening the type', () => {
    const runtime = mapRuntime({
      Status: 'running',
      StartedAt: '2026-07-27T09:00:00Z',
      Health: { Status: 'something-new' },
    });
    expect(runtime.state === 'running' && runtime.health).toBeUndefined();
  });

  /**
   * Docker writes year 1 rather than omitting the field for "never happened".
   * Passing it through renders as "up 2025 years".
   */
  it('treats Docker\u2019s 0001-01-01 sentinel as absent', () => {
    const runtime = mapRuntime({ Status: 'running', StartedAt: '0001-01-01T00:00:00Z' });
    expect(runtime.state === 'running' && runtime.startedAt).toEqual(new Date(0));
  });

  it('falls back to dead for a state Docker has not told us about', () => {
    expect(mapRuntime({ Status: 'hibernating' })).toEqual({ state: 'dead' });
    expect(mapRuntime(undefined)).toEqual({ state: 'dead' });
  });
});

describe('parsePorts', () => {
  it('keeps exposed-but-unpublished ports, with no hostPort', () => {
    expect(parsePorts({ '9229/tcp': null })).toEqual([{ containerPort: 9229, protocol: 'tcp' }]);
  });

  it('reads udp and sorts by container port', () => {
    expect(parsePorts({ '9000/udp': null, '80/tcp': null })).toEqual([
      { containerPort: 80, protocol: 'tcp' },
      { containerPort: 9000, protocol: 'udp' },
    ]);
  });

  it('expands multiple host bindings for one container port', () => {
    const ports = parsePorts({
      '8080/tcp': [
        { HostIp: '127.0.0.1', HostPort: '18080' },
        { HostIp: '::1', HostPort: '18080' },
      ],
    });
    expect(ports).toHaveLength(2);
  });

  it('returns an empty list when there are no ports at all', () => {
    expect(parsePorts(undefined)).toEqual([]);
    expect(parsePorts({})).toEqual([]);
  });
});

describe('resolveWorkspaceFolder', () => {
  it('prefers devcontainer.metadata when it names a workspace folder', () => {
    const withMetadata: InspectResponse = {
      ...BASE,
      Config: {
        ...BASE.Config,
        WorkingDir: '/somewhere/else',
        Labels: {
          'devcontainer.local_folder': '/home/dev/code/webapp',
          'devcontainer.metadata': '[{"workspaceFolder":"/workspaces/from-metadata"}]',
        },
      },
    };
    expect(resolveWorkspaceFolder(withMetadata, parseLocalFolder('/home/dev/code/webapp'))).toBe(
      '/workspaces/from-metadata',
    );
  });

  it('ignores unparseable metadata and falls through to WorkingDir', () => {
    const broken: InspectResponse = {
      ...BASE,
      Config: {
        ...BASE.Config,
        Labels: {
          'devcontainer.local_folder': '/home/dev/code/webapp',
          'devcontainer.metadata': 'not json at all {{{',
        },
      },
    };
    expect(resolveWorkspaceFolder(broken, parseLocalFolder('/home/dev/code/webapp'))).toBe(
      '/workspaces/webapp',
    );
  });

  it('ignores a WorkingDir of "/", which means unset rather than the root', () => {
    const rooted: InspectResponse = { ...BASE, Config: { ...BASE.Config, WorkingDir: '/' } };
    expect(resolveWorkspaceFolder(rooted, parseLocalFolder('/home/dev/code/webapp'))).toBe(
      '/workspaces/webapp',
    );
  });

  it('derives /workspaces/<basename> from a Windows path using the right separator', () => {
    const windows: InspectResponse = { ...BASE, Config: { ...BASE.Config, WorkingDir: '' } };
    expect(
      resolveWorkspaceFolder(windows, parseLocalFolder('C:\\Users\\dev\\reporting-tool')),
    ).toBe('/workspaces/reporting-tool');
  });

  it('gives up rather than guessing when the host path is unresolved', () => {
    const noWorkingDir: InspectResponse = { ...BASE, Config: { ...BASE.Config, WorkingDir: '' } };
    expect(resolveWorkspaceFolder(noWorkingDir, parseLocalFolder('garbage'))).toBeUndefined();
  });
});

describe('mapContainer + WSL mounts', () => {
  it('upgrades an ambiguous POSIX label to a WSL path when the mounts prove it', () => {
    const wsl: InspectResponse = {
      ...BASE,
      Config: {
        ...BASE.Config,
        Labels: { 'devcontainer.local_folder': '/home/dev/infra' },
      },
      Mounts: [
        { Source: '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/9f2c1a' },
        { Source: '/var/run/docker.sock' },
      ],
    };
    expect(mapContainer(wsl)?.localFolder).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      path: '/home/dev/infra',
    });
  });

  it('leaves a native Linux path alone when the mounts say nothing about WSL', () => {
    const native: InspectResponse = {
      ...BASE,
      Mounts: [{ Source: '/home/dev/code/webapp' }, { Source: '/var/run/docker.sock' }],
    };
    expect(mapContainer(native)?.localFolder).toEqual({
      kind: 'posix',
      path: '/home/dev/code/webapp',
    });
  });

  it('does not upgrade when there are no mounts at all', () => {
    expect(mapContainer(BASE)?.localFolder.kind).toBe('posix');
  });

  /**
   * The raw label is what builds the editor URI, so an upgrade must not touch
   * it. If it did, reattach would break on exactly the platform this feature
   * is meant to help.
   */
  it('does not disturb the raw label the editor URI is built from', () => {
    const wsl: InspectResponse = {
      ...BASE,
      Config: { ...BASE.Config, Labels: { 'devcontainer.local_folder': '/home/dev/infra' } },
      Mounts: [{ Source: '/mnt/wsl/docker-desktop-bind-mounts/Debian/abc' }],
    };
    expect(mapContainer(wsl)?.labels.localFolderRaw).toBe('/home/dev/infra');
  });
});
