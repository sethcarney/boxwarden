import { describe, expect, it } from 'vitest';
import type { DockerEnvironment, EndpointProbe, EngineId } from './index.js';
import {
  ALL_ENGINES,
  engineIdFor,
  enginesFrom,
  parseEngineSelection,
  selectionIncludes,
  selectionIsReachable,
} from './index.js';

function ok(probe: Partial<EndpointProbe> & Pick<EndpointProbe, 'endpoint'>): EndpointProbe {
  return {
    ok: true,
    serverVersion: '29.3.1',
    apiVersion: '1.51',
    runtime: 'docker-engine',
    ...probe,
  } as EndpointProbe;
}

function environment(attempts: readonly EndpointProbe[]): DockerEnvironment {
  const first = attempts[0];
  if (first === undefined) throw new Error('need at least one attempt');
  return {
    api: first,
    cli: { ok: true, binaryPath: 'docker', version: '29.3.1' },
    attempts,
    wsl: { kind: 'not-applicable' },
  };
}

describe('engineIdFor', () => {
  it('gives every transport a distinct identity', () => {
    const ids = [
      engineIdFor({ transport: 'unix', socketPath: '/var/run/docker.sock' }),
      engineIdFor({ transport: 'npipe', pipeName: '//./pipe/docker_engine' }),
      engineIdFor({ transport: 'tcp', host: '10.0.0.5', port: 2375 }),
      engineIdFor({ transport: 'ssh', host: 'buildbox' }),
      engineIdFor({ transport: 'wsl', distro: 'dev', socketPath: '/run/podman.sock' }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The same podman socket path exists inside every distro that runs it, so an
   * id built from the path alone would make "podman in dev" and "podman in
   * legacy" the same engine — selecting one would silently list the other.
   */
  it('separates the same socket path in two different distros', () => {
    const dev = engineIdFor({ transport: 'wsl', distro: 'dev', socketPath: '/run/podman.sock' });
    const legacy = engineIdFor({
      transport: 'wsl',
      distro: 'legacy',
      socketPath: '/run/podman.sock',
    });
    expect(dev).not.toBe(legacy);
  });

  /**
   * This id is written to the preferences file, so it has to be stable across
   * runs and across rewording of the UI. Pinning the exact strings is what
   * makes an accidental change to the format show up as a failing test rather
   * than as everyone's engine choice quietly resetting on upgrade.
   */
  it('is a stable string, not a hash or an index', () => {
    expect(engineIdFor({ transport: 'unix', socketPath: '/var/run/docker.sock' })).toBe(
      'unix:/var/run/docker.sock',
    );
    expect(engineIdFor({ transport: 'wsl', distro: 'dev', socketPath: '/run/podman.sock' })).toBe(
      'wsl:dev:/run/podman.sock',
    );
  });
});

describe('enginesFrom', () => {
  it('lists only the endpoints that answered', () => {
    const engines = enginesFrom(
      environment([
        {
          ok: false,
          endpoint: {
            transport: { transport: 'unix', socketPath: '/nope.sock' },
            origin: { kind: 'well-known', runtime: 'docker-engine' },
          },
          failure: { code: 'not-present', detail: 'ENOENT' },
        },
        ok({
          endpoint: {
            transport: { transport: 'unix', socketPath: '/var/run/docker.sock' },
            origin: { kind: 'well-known', runtime: 'docker-engine' },
          },
        }),
      ]),
    );

    expect(engines).toHaveLength(1);
    expect(engines[0]?.id).toBe('unix:/var/run/docker.sock');
  });

  /** The name comes from the daemon's /version, not the socket it was found on. */
  it('reports the runtime that answered, not the one guessed from the path', () => {
    const engines = enginesFrom(
      environment([
        ok({
          endpoint: {
            transport: { transport: 'npipe', pipeName: '//./pipe/docker_engine' },
            origin: { kind: 'well-known', runtime: 'docker-desktop' },
          },
          runtime: 'podman',
          serverVersion: '5.7.0',
        }),
      ]),
    );
    expect(engines[0]?.runtime).toBe('podman');
  });
});

describe('selectionIncludes', () => {
  const socket = { transport: 'unix', socketPath: '/var/run/docker.sock' } as const;

  it('admits everything under the default', () => {
    expect(selectionIncludes(ALL_ENGINES, socket)).toBe(true);
  });

  it('admits only the named engine when one is chosen', () => {
    const selection = { kind: 'only', id: engineIdFor(socket) } as const;
    expect(selectionIncludes(selection, socket)).toBe(true);
    expect(selectionIncludes(selection, { transport: 'unix', socketPath: '/other.sock' })).toBe(
      false,
    );
  });
});

describe('parseEngineSelection', () => {
  it('reads back what was written', () => {
    expect(parseEngineSelection({ kind: 'only', id: 'unix:/var/run/docker.sock' })).toEqual({
      kind: 'only',
      id: 'unix:/var/run/docker.sock',
    });
  });

  /**
   * The preferences file can be hand-edited, truncated by a crash, or written
   * by a future version. None of those should cost the user more than their
   * engine choice — and the fallback is visible in the picker, so it explains
   * itself without an error.
   */
  it('falls back to all engines for anything unrecognised', () => {
    expect(parseEngineSelection(undefined)).toEqual(ALL_ENGINES);
    expect(parseEngineSelection(null)).toEqual(ALL_ENGINES);
    expect(parseEngineSelection('unix:/var/run/docker.sock')).toEqual(ALL_ENGINES);
    expect(parseEngineSelection({ kind: 'only' })).toEqual(ALL_ENGINES);
    expect(parseEngineSelection({ kind: 'only', id: '' })).toEqual(ALL_ENGINES);
    expect(parseEngineSelection({ kind: 'some', id: 'x' })).toEqual(ALL_ENGINES);
  });
});

describe('selectionIsReachable', () => {
  const engines = enginesFrom(
    environment([
      ok({
        endpoint: {
          transport: { transport: 'unix', socketPath: '/var/run/docker.sock' },
          origin: { kind: 'well-known', runtime: 'docker-engine' },
        },
      }),
    ]),
  );

  it('is always true for the union', () => {
    expect(selectionIsReachable(ALL_ENGINES, [])).toBe(true);
  });

  it('is false when the chosen engine did not answer this scan', () => {
    expect(selectionIsReachable({ kind: 'only', id: 'unix:/gone.sock' as EngineId }, engines)).toBe(
      false,
    );
    expect(
      selectionIsReachable({ kind: 'only', id: 'unix:/var/run/docker.sock' as EngineId }, engines),
    ).toBe(true);
  });
});
