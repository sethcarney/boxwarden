import { describe, expect, it } from 'vitest';
import {
  apiVersionAtLeast,
  candidateEndpoints,
  classifyError,
  parseDockerHost,
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
