import { describe, expect, it } from 'vitest';
import {
  apiVersionAtLeast,
  candidateEndpoints,
  classifyError,
  describeTransport,
  parseDockerHost,
  parseWslDistroList,
} from './endpoint.js';

describe('parseDockerHost', () => {
  it('reads each transport DOCKER_HOST can name', () => {
    expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({
      transport: 'unix',
      socketPath: '/var/run/docker.sock',
    });
    expect(parseDockerHost('npipe:////./pipe/docker_engine')).toEqual({
      transport: 'npipe',
      pipeName: '//./pipe/docker_engine',
    });
    expect(parseDockerHost('tcp://10.0.0.5:2375')).toEqual({
      transport: 'tcp',
      host: '10.0.0.5',
      port: 2375,
    });
    expect(parseDockerHost('ssh://dev@buildbox')).toEqual({
      transport: 'ssh',
      host: 'buildbox',
      user: 'dev',
    });
  });

  it('applies the conventional default ports for tcp', () => {
    expect(parseDockerHost('tcp://host')).toMatchObject({ port: 2375 });
    expect(parseDockerHost('https://host')).toMatchObject({ port: 2376 });
  });

  it('omits absent ssh parts instead of setting them undefined', () => {
    const parsed = parseDockerHost('ssh://buildbox');
    expect(parsed).toEqual({ transport: 'ssh', host: 'buildbox' });
    // exactOptionalPropertyTypes: the key must be absent, not present-and-undefined.
    expect(Object.hasOwn(parsed as object, 'user')).toBe(false);
  });

  it('returns undefined for anything unrecognised, so discovery can carry on', () => {
    expect(parseDockerHost('')).toBeUndefined();
    expect(parseDockerHost('   ')).toBeUndefined();
    expect(parseDockerHost('unix://')).toBeUndefined();
    expect(parseDockerHost('carrier-pigeon://somewhere')).toBeUndefined();
  });
});

describe('candidateEndpoints', () => {
  it('puts a valid DOCKER_HOST first, because the user meant it', () => {
    const candidates = candidateEndpoints('linux', '/home/dev', {
      DOCKER_HOST: 'tcp://10.0.0.5:2375',
    });
    expect(candidates[0]?.origin).toEqual({
      kind: 'env',
      variable: 'DOCKER_HOST',
      value: 'tcp://10.0.0.5:2375',
    });
  });

  it('falls back to the well-known sockets when DOCKER_HOST is unparseable', () => {
    const candidates = candidateEndpoints('linux', '/home/dev', { DOCKER_HOST: 'nonsense' });
    expect(candidates[0]?.origin.kind).toBe('well-known');
    expect(candidates.every((c) => c.origin.kind !== 'env')).toBe(true);
  });

  it('probes the real Docker Desktop socket before /var/run on macOS', () => {
    const candidates = candidateEndpoints('darwin', '/Users/dev', {});
    const paths = candidates.map((c) =>
      c.transport.transport === 'unix' ? c.transport.socketPath : '',
    );
    expect(paths.indexOf('/Users/dev/.docker/run/docker.sock')).toBeLessThan(
      paths.indexOf('/var/run/docker.sock'),
    );
  });

  it('covers the common macOS runtimes', () => {
    const paths = candidateEndpoints('darwin', '/Users/dev', {}).map((c) =>
      c.transport.transport === 'unix' ? c.transport.socketPath : '',
    );
    expect(paths).toContain('/Users/dev/.orbstack/run/docker.sock');
    expect(paths).toContain('/Users/dev/.colima/default/docker.sock');
    expect(paths).toContain('/Users/dev/.rd/docker.sock');
  });

  it('uses a named pipe on Windows, never a unix socket', () => {
    const candidates = candidateEndpoints('win32', 'C:\\Users\\dev', {});
    expect(candidates.every((c) => c.transport.transport === 'npipe')).toBe(true);
  });

  it('includes the rootless and podman sockets when XDG_RUNTIME_DIR is set', () => {
    const paths = candidateEndpoints('linux', '/home/dev', {
      XDG_RUNTIME_DIR: '/run/user/1000',
    }).map((c) => (c.transport.transport === 'unix' ? c.transport.socketPath : ''));
    expect(paths).toContain('/run/user/1000/docker.sock');
    expect(paths).toContain('/run/user/1000/podman/podman.sock');
  });

  /**
   * `podman machine` publishes its own pipe. Probing only `docker_engine` meant
   * a Windows machine running podman was reachable purely by accident — through
   * podman's docker-compat pipe — and not at all if the user had turned that
   * compatibility off.
   */
  it('probes the podman machine pipe on Windows, not just docker_engine', () => {
    const pipes = candidateEndpoints('win32', 'C:\\Users\\dev', {}).map((c) =>
      c.transport.transport === 'npipe' ? c.transport.pipeName : '',
    );
    expect(pipes).toContain('//./pipe/docker_engine');
    expect(pipes).toContain('//./pipe/podman-machine-default');
  });

  it('appends a candidate per WSL socket, after the named pipes', () => {
    const candidates = candidateEndpoints('win32', 'C:\\Users\\dev', {}, [
      { distro: 'dev', socketPath: '/run/user/1000/podman/podman.sock', runtime: 'podman' },
    ]);

    const last = candidates.at(-1);
    expect(last?.transport).toEqual({
      transport: 'wsl',
      distro: 'dev',
      socketPath: '/run/user/1000/podman/podman.sock',
    });
    expect(last?.origin).toEqual({ kind: 'wsl', distro: 'dev', runtime: 'podman' });
  });

  it('adds no WSL candidates when none were discovered', () => {
    const candidates = candidateEndpoints('win32', 'C:\\Users\\dev', {});
    expect(candidates.every((c) => c.transport.transport === 'npipe')).toBe(true);
  });
});

describe('parseWslDistroList', () => {
  it('reads the quiet distro list', () => {
    expect(parseWslDistroList('dev\r\nUbuntu-22.04\r\n')).toEqual(['dev', 'Ubuntu-22.04']);
  });

  /**
   * wsl.exe writes UTF-16LE. Decoded as UTF-8 — or with only the BOM stripped —
   * every character arrives with a NUL beside it, and a naive parser then
   * reports no distros on a machine full of them.
   */
  it('survives UTF-16 output that was decoded as bytes', () => {
    expect(parseWslDistroList('\ufeffd\0e\0v\0\r\0\n\0')).toEqual(['dev']);
  });

  /**
   * These already have a Windows named pipe of their own, so relaying into them
   * would only rediscover the same containers. docker-desktop-data has no
   * daemon in it at all.
   */
  it('skips distros that are already covered by a named pipe', () => {
    expect(
      parseWslDistroList('dev\ndocker-desktop\ndocker-desktop-data\npodman-machine-default\n'),
    ).toEqual(['dev']);
  });

  it('returns nothing when no distro is running', () => {
    expect(parseWslDistroList('')).toEqual([]);
    expect(parseWslDistroList('\r\n\r\n')).toEqual([]);
  });
});

describe('describeTransport', () => {
  it('renders a WSL socket as a path the user can recognise', () => {
    expect(
      describeTransport({
        transport: 'wsl',
        distro: 'dev',
        socketPath: '/run/user/1000/podman/podman.sock',
      }),
    ).toBe('\\\\wsl.localhost\\dev\\run\\user\\1000\\podman\\podman.sock');
  });
});

describe('classifyError', () => {
  /**
   * The distinction this test defends: "not installed" and "installed but not
   * running" need different sentences and different fixes, and both arrive
   * here as an exception from the same call.
   */
  it('separates a missing socket from one that refuses', () => {
    expect(classifyError(Object.assign(new Error('nope'), { code: 'ENOENT' })).code).toBe(
      'not-present',
    );
    expect(classifyError(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })).code).toBe(
      'connection-refused',
    );
  });

  it('recognises a permissions failure, which has its own fix', () => {
    expect(classifyError(Object.assign(new Error('denied'), { code: 'EACCES' })).code).toBe(
      'permission-denied',
    );
  });

  it('keeps the original message for anything it cannot classify', () => {
    const failure = classifyError(new Error('something odd'));
    expect(failure).toEqual({ code: 'unknown', detail: 'something odd' });
  });

  it('survives a thrown non-Error', () => {
    expect(classifyError('a string').code).toBe('unknown');
  });
});

describe('apiVersionAtLeast', () => {
  it('compares numerically, not lexically', () => {
    // The case a string compare gets wrong: "1.9" > "1.41" lexically.
    expect(apiVersionAtLeast('1.9', '1.41')).toBe(false);
    expect(apiVersionAtLeast('1.41', '1.41')).toBe(true);
    expect(apiVersionAtLeast('1.51', '1.41')).toBe(true);
    expect(apiVersionAtLeast('2.0', '1.41')).toBe(true);
  });
});
