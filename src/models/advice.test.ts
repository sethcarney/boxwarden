import { describe, expect, it } from 'vitest';
import type {
  Advice,
  DockerEnvironment,
  EndpointFailure,
  EndpointProbe,
  EngineId,
  EngineSelection,
  HostPlatform,
  WslStatus,
} from './index.js';
import { ALL_ENGINES, adviseEnvironment, hostPlatform } from './index.js';

/**
 * These tests are the reason the advice engine is pure.
 *
 * Every branch below describes a machine in a specific state of disrepair —
 * WSL absent, a distro without socat, a socket that refuses — and the only
 * other way to see one is to own that machine. Reproducing "Windows with WSL
 * installed but no distribution" on demand is not something a test suite can
 * do; constructing the record that describes it is trivial.
 */

function failed(socketPath: string, failure: EndpointFailure): EndpointProbe {
  return {
    ok: false,
    endpoint: {
      transport: { transport: 'unix', socketPath },
      origin: { kind: 'well-known', runtime: 'docker-engine' },
    },
    failure,
  };
}

function connected(socketPath: string): EndpointProbe {
  return {
    ok: true,
    endpoint: {
      transport: { transport: 'unix', socketPath },
      origin: { kind: 'well-known', runtime: 'docker-engine' },
    },
    serverVersion: '29.3.1',
    apiVersion: '1.51',
    runtime: 'docker-engine',
  };
}

function environment(
  attempts: readonly EndpointProbe[],
  wsl: WslStatus = { kind: 'not-applicable' },
  cliOk = true,
): DockerEnvironment {
  const first = attempts[0] ?? failed('/var/run/docker.sock', { code: 'not-present', detail: '' });
  return {
    api: first,
    cli: cliOk
      ? { ok: true, binaryPath: 'docker', version: '29.3.1' }
      : { ok: false, code: 'not-on-path' },
    attempts,
    wsl,
  };
}

function advise(
  platform: HostPlatform,
  env: DockerEnvironment,
  selection: EngineSelection = ALL_ENGINES,
): readonly Advice[] {
  return adviseEnvironment({ platform, environment: env, selection });
}

const ids = (advice: readonly Advice[]): readonly string[] => advice.map((entry) => entry.id);

describe('hostPlatform', () => {
  it('narrows the platforms it has advice for and buckets the rest', () => {
    expect(hostPlatform('win32')).toBe('win32');
    expect(hostPlatform('darwin')).toBe('darwin');
    expect(hostPlatform('linux')).toBe('linux');
    expect(hostPlatform('freebsd')).toBe('other');
  });
});

describe('a healthy machine', () => {
  it('says nothing at all', () => {
    expect(advise('linux', environment([connected('/var/run/docker.sock')]))).toEqual([]);
  });
});

describe('Windows without WSL', () => {
  const noWsl = environment(
    [failed('//./pipe/docker_engine', { code: 'not-present', detail: 'ENOENT' })],
    { kind: 'not-installed' },
  );

  /**
   * The headline case this whole feature exists for. Linux containers need a
   * Linux kernel, and on Windows WSL2 is where it comes from — so "no engine
   * found" on a machine without WSL has one cause and one fix, and reporting
   * only the missing pipe sends the user hunting through Docker settings.
   */
  it('leads with WSL, and gives the command to install it', () => {
    const advice = advise('win32', noWsl);
    expect(advice[0]?.id).toBe('wsl-not-installed');
    expect(advice[0]?.severity).toBe('error');
    expect(advice[0]?.commands).toContain('wsl --install');
    expect(advice[0]?.links.map((link) => link.url)).toContain(
      'https://learn.microsoft.com/windows/wsl/install',
    );
  });

  it('still offers the install menu, after the WSL advice rather than instead of it', () => {
    expect(ids(advise('win32', noWsl))).toEqual(['wsl-not-installed', 'install-engine-win32']);
  });

  /**
   * Docker Desktop on the Hyper-V backend, or Windows containers, works
   * without WSL. Nagging a user whose setup demonstrably functions is how a
   * diagnostic panel trains people to ignore it.
   */
  it('says nothing about WSL when an engine is reachable anyway', () => {
    const working = environment([connected('//./pipe/docker_engine')], { kind: 'not-installed' });
    expect(advise('win32', working)).toEqual([]);
  });
});

describe('Windows with WSL but nothing in it', () => {
  it('asks for a distribution rather than for WSL again', () => {
    const advice = advise(
      'win32',
      environment([failed('//./pipe/docker_engine', { code: 'not-present', detail: 'ENOENT' })], {
        kind: 'no-distros',
      }),
    );
    expect(advice[0]?.id).toBe('wsl-no-distros');
    expect(advice[0]?.commands).toContain('wsl --install -d Ubuntu');
  });

  it('names a real distribution in the start command when one is merely stopped', () => {
    const advice = advise(
      'win32',
      environment([failed('//./pipe/docker_engine', { code: 'not-present', detail: 'ENOENT' })], {
        kind: 'none-running',
        installed: ['Ubuntu-22.04', 'dev'],
      }),
    );
    const wsl = advice.find((entry) => entry.id === 'wsl-none-running');
    expect(wsl?.commands).toEqual(['wsl -d Ubuntu-22.04']);
    expect(wsl?.body).toContain('Ubuntu-22.04, dev');
  });
});

describe('a WSL distribution with no relay', () => {
  const missingSocat: WslStatus = {
    kind: 'ready',
    distros: [
      { distro: 'dev', hasSocat: true, hasPodman: true, socketPath: '/run/podman.sock' },
      { distro: 'legacy', hasSocat: false, hasPodman: true },
    ],
  };

  /**
   * The nastiest failure boxwarden has, and the reason this advisory is not
   * gated on the engine being unreachable: an engine IS reachable, the list
   * renders, and it is quietly missing every container in `legacy`. Nothing on
   * screen would otherwise suggest anything is wrong.
   */
  it('warns even when another engine is working fine', () => {
    const advice = advise(
      'win32',
      environment([connected('//./pipe/docker_engine')], missingSocat),
    );
    const socat = advice.find((entry) => entry.id === 'wsl-socat-missing');
    expect(socat).toBeDefined();
    expect(socat?.severity).toBe('warning');
    expect(socat?.title).toContain('legacy');
  });

  it('gives the install command for each affected distribution, and only those', () => {
    const advice = advise(
      'win32',
      environment([connected('//./pipe/docker_engine')], missingSocat),
    );
    const socat = advice.find((entry) => entry.id === 'wsl-socat-missing');
    expect(socat?.commands).toEqual(['wsl -d legacy -- sudo apt-get install -y socat']);
  });

  it('stays quiet when every distribution has one', () => {
    const fine: WslStatus = {
      kind: 'ready',
      distros: [{ distro: 'dev', hasSocat: true, hasPodman: true, socketPath: '/run/podman.sock' }],
    };
    const advice = advise('win32', environment([connected('//./pipe/docker_engine')], fine));
    expect(ids(advice)).not.toContain('wsl-socat-missing');
  });
});

describe('failures with a specific fix', () => {
  /**
   * "Installed but you are not in the docker group" and "not installed" arrive
   * as failures from the same call and need completely different fixes. The
   * install menu is actively wrong for the first one.
   */
  it('offers the docker group rather than an install menu for EACCES', () => {
    const advice = advise(
      'linux',
      environment([
        failed('/var/run/docker.sock', { code: 'permission-denied', detail: 'EACCES' }),
      ]),
    );
    expect(ids(advice)).toEqual(['socket-permission-denied']);
    expect(advice[0]?.commands).toContain('sudo usermod -aG docker "$USER"');
  });

  it('says "installed and stopped" rather than "missing" for a refused socket', () => {
    const advice = advise(
      'linux',
      environment([failed('/var/run/docker.sock', { code: 'connection-refused' })]),
    );
    expect(ids(advice)).toEqual(['engine-not-running']);
    expect(advice[0]?.commands).toContain('sudo systemctl start docker');
  });

  it('tailors the start command to the platform', () => {
    const refused = environment([failed('/var/run/docker.sock', { code: 'connection-refused' })]);
    expect(advise('darwin', refused)[0]?.commands).toContain('open -a Docker');
  });

  it('names the API floor when the engine is simply too old', () => {
    const advice = advise(
      'linux',
      environment([
        failed('/var/run/docker.sock', { code: 'api-too-old', server: '1.24', minimum: '1.41' }),
      ]),
    );
    expect(ids(advice)).toEqual(['api-too-old']);
    expect(advice[0]?.body).toContain('1.41');
  });
});

describe('nothing installed', () => {
  it('offers the options for the platform, not a single vendor', () => {
    const nothing = environment([
      failed('/var/run/docker.sock', { code: 'not-present', detail: 'ENOENT' }),
    ]);

    const mac = advise('darwin', nothing)[0];
    expect(mac?.id).toBe('install-engine-darwin');
    const macLinks = mac?.links.map((link) => link.label) ?? [];
    expect(macLinks).toContain('OrbStack');
    expect(macLinks).toContain('Colima');
    expect(macLinks.length).toBeGreaterThan(2);

    const linux = advise('linux', nothing)[0];
    expect(linux?.id).toBe('install-engine-linux');
    // No VM on Linux, so no OrbStack/Colima — offering them would be noise.
    expect(linux?.links.map((link) => link.label)).not.toContain('OrbStack');
  });

  it('falls back to DOCKER_HOST advice on a platform it has no menu for', () => {
    const advice = advise(
      'other',
      environment([failed('/var/run/docker.sock', { code: 'not-present', detail: 'ENOENT' })]),
    );
    expect(advice[0]?.id).toBe('install-engine-other');
    expect(advice[0]?.commands.join(' ')).toContain('DOCKER_HOST');
  });
});

describe('engine selection', () => {
  const twoEngines = environment([
    connected('/var/run/docker.sock'),
    connected('/run/podman.sock'),
  ]);

  /**
   * The one case where the app looks broken and nothing is: engines are up,
   * the user narrowed to one, and that one went away. Without this the list is
   * simply empty and there is nothing on screen connecting it to the setting.
   */
  it('explains an empty list caused by a selection that is no longer answering', () => {
    const advice = advise('linux', twoEngines, {
      kind: 'only',
      id: 'unix:/gone.sock' as EngineId,
    });
    expect(advice[0]?.id).toBe('selected-engine-unreachable');
    expect(advice[0]?.body).toContain('All engines');
  });

  it('stays quiet when the selected engine is answering', () => {
    expect(
      advise('linux', twoEngines, {
        kind: 'only',
        id: 'unix:/run/podman.sock' as EngineId,
      }),
    ).toEqual([]);
  });
});

describe('the docker CLI', () => {
  /**
   * A note, never a warning: nothing boxwarden does today shells out to it.
   * Ranking it above a missing engine would bury the thing that is actually
   * stopping the app from working.
   */
  it('is mentioned only once the engine is working, and only as a note', () => {
    const working = environment([connected('/var/run/docker.sock')], undefined, false);
    const advice = advise('linux', working);
    expect(ids(advice)).toEqual(['docker-cli-missing']);
    expect(advice[0]?.severity).toBe('info');

    const broken = environment(
      [failed('/var/run/docker.sock', { code: 'not-present', detail: 'ENOENT' })],
      undefined,
      false,
    );
    expect(ids(advise('linux', broken))).not.toContain('docker-cli-missing');
  });
});
