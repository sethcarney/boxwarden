import { describe, expect, it } from 'vitest';
import {
  mapContainer,
  mapRuntime,
  parsePorts,
  resolveRemoteUser,
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

describe('resolveRemoteUser', () => {
  const withMetadata = (metadata: string, user?: string): InspectResponse => ({
    ...BASE,
    Config: {
      ...BASE.Config,
      ...(user === undefined ? {} : { User: user }),
      Labels: { ...BASE.Config?.Labels, 'devcontainer.metadata': metadata },
    },
  });

  /**
   * The whole point: this is the field VS Code reads to decide who to attach
   * as, so matching it is not a guess about what the developer wanted.
   */
  it('prefers remoteUser, which is what VS Code attaches as', () => {
    expect(resolveRemoteUser(withMetadata('[{"remoteUser":"vscode"}]'))).toBe('vscode');
  });

  it('falls back to containerUser when no remote user is named', () => {
    expect(resolveRemoteUser(withMetadata('[{"containerUser":"node"}]'))).toBe('node');
  });

  it('prefers remoteUser over containerUser when both are present', () => {
    expect(
      resolveRemoteUser(withMetadata('[{"containerUser":"node","remoteUser":"vscode"}]')),
    ).toBe('vscode');
  });

  /**
   * The label is ordered image → features → devcontainer.json, and the spec
   * merges single-valued properties by letting later entries win. Taking the
   * first would let a feature declaring `root` override what the developer
   * wrote in their own config — the exact inversion this fixes.
   */
  it('lets a later fragment override an earlier one', () => {
    expect(resolveRemoteUser(withMetadata('[{"remoteUser":"root"},{"remoteUser":"vscode"}]'))).toBe(
      'vscode',
    );
  });

  it('reads a bare object as well as an array', () => {
    expect(resolveRemoteUser(withMetadata('{"remoteUser":"vscode"}'))).toBe('vscode');
  });

  it("falls back to the image's user when the metadata names nobody", () => {
    expect(resolveRemoteUser(withMetadata('[{"id":"ghcr.io/x/y"}]', 'node'))).toBe('node');
  });

  /**
   * Undefined, never a guess: `docker exec -u` at a user that does not exist
   * makes the daemon refuse outright, and an emulator closes the window of a
   * command that exited — so the button would appear to do nothing at all.
   */
  it('answers undefined rather than guessing', () => {
    expect(resolveRemoteUser(BASE)).toBeUndefined();
    expect(resolveRemoteUser(withMetadata('not json at all'))).toBeUndefined();
    expect(resolveRemoteUser(withMetadata('[{"remoteUser":""}]'))).toBeUndefined();
    expect(resolveRemoteUser(withMetadata('[{"remoteUser":42}]'))).toBeUndefined();
  });

  it('reaches DevContainer, since the terminal is what needs it', () => {
    expect(mapContainer(withMetadata('[{"remoteUser":"vscode"}]'))?.remoteUser).toBe('vscode');
    expect(mapContainer(BASE)?.remoteUser).toBeUndefined();
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

describe('mapContainer and the SSH agent', () => {
  it('reports a forwarded socket when a mount lands on it', () => {
    const forwarded: InspectResponse = {
      ...BASE,
      Config: { ...BASE.Config, Env: ['SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock'] },
      Mounts: [{ Destination: '/run/host-services/ssh-auth.sock' }],
    };
    expect(mapContainer(forwarded)?.sshAgent).toEqual({
      kind: 'forwarded',
      socket: '/run/host-services/ssh-auth.sock',
    });
  });

  it('reports declared-unmounted when the variable is set and nothing is mounted there', () => {
    const broken: InspectResponse = {
      ...BASE,
      Config: { ...BASE.Config, Env: ['SSH_AUTH_SOCK=/ssh-agent'] },
      Mounts: [{ Source: '/home/dev/code/webapp', Destination: '/workspaces/webapp' }],
    };
    expect(mapContainer(broken)?.sshAgent).toEqual({
      kind: 'declared-unmounted',
      socket: '/ssh-agent',
    });
  });

  /** A required field with an `absent` arm — there is no "we did not look". */
  it('reports absent for a container with no environment block', () => {
    expect(mapContainer(BASE)?.sshAgent).toEqual({ kind: 'absent' });
  });

  /**
   * THE SECURITY TEST.
   *
   * A container's environment holds registry credentials, database passwords
   * and API tokens. Exactly one variable is read out of it; everything else
   * must be gone by the time `mapContainer` returns, because what it returns
   * crosses IPC into a Chromium renderer and is held in a snapshot there.
   *
   * Asserted over the serialised object rather than field by field, so a
   * future field that copies `Config.Env` somewhere new fails here too — the
   * point is that no path exists, not that the paths we thought of are closed.
   */
  it('does not carry any environment variable other than SSH_AUTH_SOCK', () => {
    const secrets: InspectResponse = {
      ...BASE,
      Config: {
        ...BASE.Config,
        Env: [
          'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          'POSTGRES_PASSWORD=hunter2',
          'GITHUB_TOKEN=ghp_000000000000000000000000000000000000',
          'SSH_AUTH_SOCK=/ssh-agent',
          'NPM_CONFIG_//registry.npmjs.org/:_authToken=npm_0000000000',
        ],
      },
      Mounts: [{ Destination: '/ssh-agent' }],
    };

    const mapped = mapContainer(secrets);
    expect(mapped?.sshAgent).toEqual({ kind: 'forwarded', socket: '/ssh-agent' });

    const serialised = JSON.stringify(mapped);
    for (const secret of ['wJalrXUtnFEMI', 'hunter2', 'ghp_0000', 'npm_0000', 'AWS_SECRET']) {
      expect(serialised).not.toContain(secret);
    }
    // The one value that is allowed through, so the assertions above cannot
    // pass by the object being empty.
    expect(serialised).toContain('/ssh-agent');
  });
});
