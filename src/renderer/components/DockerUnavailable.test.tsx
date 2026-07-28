// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DockerUnavailable } from './DockerUnavailable.js';
import type { DockerEndpoint, DockerEnvironment, EndpointProbe } from '../../domain/index.js';

function unixEndpoint(socketPath: string): DockerEndpoint {
  return {
    transport: { transport: 'unix', socketPath },
    origin: { kind: 'well-known', runtime: 'docker-engine' },
  };
}

function failed(socketPath: string, code: 'not-present' | 'connection-refused'): EndpointProbe {
  return {
    ok: false,
    endpoint: unixEndpoint(socketPath),
    failure: code === 'not-present' ? { code, detail: 'ENOENT' } : { code },
  };
}

function environment(attempts: readonly EndpointProbe[]): DockerEnvironment {
  const first = attempts[0];
  if (first === undefined) throw new Error('need at least one attempt');
  return { api: first, cli: { ok: true, binaryPath: 'docker', version: '29.3.1' }, attempts };
}

describe('DockerUnavailable', () => {
  it('renders nothing when Docker is actually reachable', () => {
    const ok: EndpointProbe = {
      ok: true,
      endpoint: unixEndpoint('/var/run/docker.sock'),
      serverVersion: '29.3.1',
      apiVersion: '1.51',
    };
    const { container } = render(<DockerUnavailable environment={environment([ok])} />);
    expect(container.firstChild).toBeNull();
  });

  /**
   * The reason `DockerEnvironment.attempts` exists. Probing five sockets and
   * reporting only "couldn't connect to Docker" is what makes this class of
   * tool infuriating — the user cannot tell whether Docker is missing, stopped,
   * or listening somewhere nobody looked.
   */
  it('lists every candidate that was tried, not just the headline failure', () => {
    render(
      <DockerUnavailable
        environment={environment([
          failed('/var/run/docker.sock', 'not-present'),
          failed('/run/user/1000/docker.sock', 'connection-refused'),
          failed('/home/dev/.docker/desktop/docker.sock', 'not-present'),
        ])}
      />,
    );

    expect(screen.getByText('/var/run/docker.sock')).toBeDefined();
    expect(screen.getByText('/run/user/1000/docker.sock')).toBeDefined();
    expect(screen.getByText('/home/dev/.docker/desktop/docker.sock')).toBeDefined();
    expect(screen.getByText(/Everything boxwarden tried \(3\)/)).toBeDefined();
  });

  it('gives a fix, not just a failure, for a missing socket', () => {
    render(
      <DockerUnavailable
        environment={environment([failed('/var/run/docker.sock', 'not-present')])}
      />,
    );
    const lede = screen.getByText(/No Docker socket at/);
    expect(lede.textContent).toContain('/var/run/docker.sock');
    expect(lede.textContent).toContain('DOCKER_HOST');
  });

  it('distinguishes a socket that refuses from one that is missing', () => {
    render(
      <DockerUnavailable
        environment={environment([failed('/var/run/docker.sock', 'connection-refused')])}
      />,
    );
    // "installed and not running" — a different fix from "not installed".
    expect(screen.getByText(/not running/)).toBeDefined();
    expect(screen.getByText(/systemctl start docker/)).toBeDefined();
  });

  it('mentions the missing docker CLI only when it is actually missing', () => {
    const withCli = environment([failed('/var/run/docker.sock', 'not-present')]);
    const { unmount } = render(<DockerUnavailable environment={withCli} />);
    expect(screen.queryByText(/was also not found on your PATH/)).toBeNull();
    unmount();

    render(
      <DockerUnavailable environment={{ ...withCli, cli: { ok: false, code: 'not-on-path' } }} />,
    );
    expect(screen.getByText(/was also not found on your PATH/)).toBeDefined();
  });

  it('names the environment variable when the failing endpoint came from DOCKER_HOST', () => {
    const fromEnv: EndpointProbe = {
      ok: false,
      endpoint: {
        transport: { transport: 'tcp', host: '10.0.0.5', port: 2375 },
        origin: { kind: 'env', variable: 'DOCKER_HOST', value: 'tcp://10.0.0.5:2375' },
      },
      failure: { code: 'connection-refused' },
    };
    render(<DockerUnavailable environment={environment([fromEnv])} />);
    expect(screen.getByText('from DOCKER_HOST')).toBeDefined();
    expect(screen.getByText('tcp://10.0.0.5:2375')).toBeDefined();
  });
});
