import { describe, expect, it } from 'vitest';
import type {
  Advice,
  DockerEnvironment,
  EndpointFailure,
  EndpointProbe,
  EngineId,
  EngineSelection,
  HostPlatform,
  SshAgentHostProbe,
  WslStatus,
} from './index.js';
import { ALL_ENGINES, adviseEnvironment, adviseSshAgent, hostPlatform } from './index.js';

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

/**
 * SSH agent forwarding.
 *
 * Every branch here is a machine in a state nobody can arrange on demand — a
 * Windows box with the ssh-agent service disabled, a Linux session whose agent
 * died with the shell that made it — which is the same reason the rest of this
 * file exists.
 */
describe('SSH agent advice', () => {
  const HEALTHY_LINUX: SshAgentHostProbe = {
    authSock: '/run/user/1000/keyring/ssh',
    authSockExists: true,
    inContainer: false,
  };

  function ssh(
    platform: HostPlatform,
    host: SshAgentHostProbe,
    unmountedIn: readonly string[] = [],
  ): Advice | undefined {
    return adviseSshAgent(platform, { host, unmountedIn });
  }

  describe('when there is nothing to say', () => {
    it('says nothing when the host agent is healthy and no container is broken', () => {
      expect(ssh('linux', HEALTHY_LINUX)).toBeUndefined();
      expect(
        ssh('darwin', {
          authSock: '/private/tmp/x/agent',
          authSockExists: true,
          inContainer: false,
        }),
      ).toBeUndefined();
      expect(ssh('win32', { service: 'running', inContainer: false })).toBeUndefined();
    });

    /**
     * The probe could not read the service. Inventing a problem out of that is
     * how an advisory panel starts getting ignored.
     */
    it('says nothing when the Windows service state could not be read', () => {
      expect(ssh('win32', { service: 'unknown', inContainer: false })).toBeUndefined();
    });

    /** No probe, no evidence, no advice. */
    it('says nothing when the host was never probed', () => {
      expect(adviseSshAgent('linux', undefined)).toBeUndefined();
    });
  });

  describe('Windows', () => {
    it('separates a disabled service from a merely stopped one', () => {
      const disabled = ssh('win32', { service: 'disabled', inContainer: false });
      const stopped = ssh('win32', { service: 'stopped', inContainer: false });
      expect(disabled?.title).toMatch(/disabled/i);
      expect(stopped?.title).toMatch(/not running/i);
      expect(disabled?.title).not.toBe(stopped?.title);
    });

    it('gives the four commands that fix it', () => {
      expect(ssh('win32', { service: 'disabled', inContainer: false })?.commands).toEqual([
        'Get-Service ssh-agent',
        'Set-Service ssh-agent -StartupType Automatic',
        'Start-Service ssh-agent',
        'ssh-add $env:USERPROFILE\\.ssh\\id_ed25519',
      ]);
    });

    /**
     * The wrinkle that makes this worth an advisory rather than a link. An
     * agent started inside a distro is not the agent the Dev Containers
     * extension forwards, so a user can do everything right in WSL and see no
     * keys in the container.
     */
    it('warns that an agent inside WSL is a different agent', () => {
      const body = ssh('win32', { service: 'stopped', inContainer: false })?.body ?? '';
      expect(body).toMatch(/WSL/);
      expect(body).toMatch(/different agent/i);
    });

    it('links the Microsoft key-management docs as well as the container ones', () => {
      const urls = ssh('win32', { service: 'stopped', inContainer: false })?.links.map(
        (link) => link.url,
      );
      expect(urls).toContain(
        'https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement',
      );
      expect(urls).toContain(
        'https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials',
      );
    });
  });

  describe('macOS', () => {
    it('gives the keychain commands', () => {
      const advice = ssh('darwin', { inContainer: false });
      expect(advice?.commands).toEqual([
        'ssh-add --apple-use-keychain ~/.ssh/id_ed25519',
        'ssh-add -l',
      ]);
    });

    /** The part that survives a reboot, and a file edit rather than a command. */
    it('mentions the ~/.ssh/config stanza in the body', () => {
      const body = ssh('darwin', { inContainer: false })?.body ?? '';
      expect(body).toContain('~/.ssh/config');
      expect(body).toContain('AddKeysToAgent yes');
      expect(body).toContain('UseKeychain yes');
    });
  });

  describe('Linux', () => {
    it('gives the shell agent and the systemd unit', () => {
      expect(ssh('linux', { inContainer: false })?.commands).toEqual([
        'eval "$(ssh-agent -s)"',
        'ssh-add ~/.ssh/id_ed25519',
        'systemctl --user enable --now ssh-agent.service',
      ]);
    });

    /** Why the systemd unit is the one worth setting up. */
    it('says the eval form dies with the shell', () => {
      const body = ssh('linux', { inContainer: false })?.body ?? '';
      expect(body).toMatch(/dies with the shell/i);
      expect(body).toContain('systemd --user');
    });

    /** A stale socket left by a previous login is not the same as no agent. */
    it('separates a stale socket from no agent at all', () => {
      const stale = ssh('linux', {
        authSock: '/tmp/ssh-old/agent.42',
        authSockExists: false,
        inContainer: false,
      });
      const none = ssh('linux', { inContainer: false });
      expect(stale?.title).not.toBe(none?.title);
      expect(stale?.title).toMatch(/not there/i);
    });
  });

  describe('a container that declares a socket it does not have', () => {
    it('warns, and names the container', () => {
      const advice = ssh('linux', HEALTHY_LINUX, ['platform_devcontainer-app-1']);
      expect(advice?.severity).toBe('warning');
      expect(advice?.title).toContain('platform_devcontainer-app-1');
      expect(advice?.id).toBe('ssh-agent-declared-unmounted');
    });

    it('counts them rather than listing them in the title when there are several', () => {
      const advice = ssh('linux', HEALTHY_LINUX, ['app', 'worker']);
      expect(advice?.title).toContain('2 containers');
      // Both are still named in the body — the count alone does not say which.
      expect(advice?.body).toContain('app');
      expect(advice?.body).toContain('worker');
    });

    /** The symptom, named. Nobody connects "socket not mounted" to this on their own. */
    it('says what will actually go wrong', () => {
      const body = ssh('linux', HEALTHY_LINUX, ['app'])?.body ?? '';
      expect(body).toContain('Could not open a connection to your authentication agent');
    });

    /** It outranks the host advisory: the host agent being fine does not fix it. */
    it('warns even when the host agent is perfectly healthy', () => {
      expect(ssh('linux', HEALTHY_LINUX, ['app'])?.severity).toBe('warning');
    });
  });

  describe('when boxwarden is itself inside a container', () => {
    /**
     * docker-outside-of-docker: boxwarden sees the host's containers while
     * process.env belongs to the container it is in. Advising from that would
     * be reporting confidently on the wrong machine.
     */
    it('suppresses the host advisory entirely', () => {
      expect(ssh('linux', { inContainer: true })).toBeUndefined();
      expect(ssh('win32', { service: 'stopped', inContainer: true })).toBeUndefined();
    });

    /** Half A reads the inspected container, so it is unaffected — but say so. */
    it('still warns about a broken container, worded so it cannot mislead', () => {
      const advice = ssh('linux', { inContainer: true }, ['app']);
      expect(advice?.severity).toBe('warning');
      expect(advice?.body).toMatch(/boxwarden is itself running inside a container/i);
      expect(advice?.body).toMatch(/on the host/i);
    });
  });

  /**
   * THE RULE. Plenty of dev containers have no business talking to a remote,
   * and an advisory that nags every developer who does not need SSH teaches
   * people to skip the panel that will one day matter.
   */
  it('never emits an error, on any platform, in any state', () => {
    const platforms: readonly HostPlatform[] = ['win32', 'darwin', 'linux', 'other'];
    const hosts: readonly SshAgentHostProbe[] = [
      { inContainer: false },
      { inContainer: true },
      { service: 'stopped', inContainer: false },
      { service: 'disabled', inContainer: false },
      { service: 'running', inContainer: false },
      { service: 'unknown', inContainer: false },
      { authSock: '/tmp/agent', authSockExists: false, inContainer: false },
      { authSock: '/tmp/agent', authSockExists: true, inContainer: false },
    ];

    for (const platform of platforms) {
      for (const host of hosts) {
        for (const unmountedIn of [[], ['app'], ['app', 'worker']]) {
          const advice = adviseSshAgent(platform, { host, unmountedIn });
          expect(advice?.severity).not.toBe('error');
        }
      }
    }
  });

  describe('inside the full advisory list', () => {
    it('rides along on a healthy machine without displacing anything', () => {
      const healthy = environment([connected('/var/run/docker.sock')]);
      const advice = adviseEnvironment({
        platform: 'linux',
        environment: healthy,
        selection: ALL_ENGINES,
        sshAgent: { host: { inContainer: false }, unmountedIn: [] },
      });
      expect(ids(advice)).toEqual(['ssh-agent-host']);
      expect(advice[0]?.severity).toBe('info');
    });

    /** Below the engine advisories: it is never why the app looks broken. */
    it('sorts below an engine problem', () => {
      const broken = environment(
        [failed('/var/run/docker.sock', { code: 'permission-denied', detail: 'EACCES' })],
        undefined,
      );
      const advice = adviseEnvironment({
        platform: 'linux',
        environment: broken,
        selection: ALL_ENGINES,
        sshAgent: { host: { inContainer: false }, unmountedIn: [] },
      });
      expect(ids(advice).indexOf('ssh-agent-host')).toBeGreaterThan(
        ids(advice).indexOf('socket-permission-denied'),
      );
    });

    /** Callers that do not probe must not produce advice about a machine nobody looked at. */
    it('is absent when the caller passed no probe', () => {
      const healthy = environment([connected('/var/run/docker.sock')]);
      expect(ids(advise('linux', healthy))).toEqual([]);
    });
  });
});
