/**
 * Docker connectivity is modelled as THREE independent probes.
 *
 * Socket reachability, `docker` on PATH and `devcontainer` on PATH fail
 * separately and gate different features:
 *
 *   api.ok          -> discover, start, stop, kill — everything over the socket.
 *   cli.ok          -> what @devcontainers/cli needs underneath it.
 *   devcontainer.ok -> Build and Rebuild, which shell out to that CLI.
 *
 * Collapsing them into one "Docker is ready" boolean forces a bad choice:
 * refuse to start when `docker` is missing even though the socket features
 * never need it, or report ready and fail later at the CLI call site.
 */

import type { WslStatus } from './wsl.js';

export type ContainerRuntimeKind =
  'docker-desktop' | 'orbstack' | 'colima' | 'rancher-desktop' | 'podman' | 'docker-engine';

export interface DockerTls {
  readonly caPath?: string;
  readonly certPath?: string;
  readonly keyPath?: string;
}

export type DockerTransport =
  | { readonly transport: 'unix'; readonly socketPath: string }
  | { readonly transport: 'npipe'; readonly pipeName: string }
  | {
      readonly transport: 'tcp';
      readonly host: string;
      readonly port: number;
      readonly tls?: DockerTls;
    }
  | {
      readonly transport: 'ssh';
      readonly host: string;
      readonly port?: number;
      readonly user?: string;
    }
  /**
   * A unix socket living INSIDE a WSL2 distribution, reached from Windows.
   *
   * This is its own arm rather than a `unix` socket with a funny path because
   * Windows genuinely cannot open it: WSL2 projects a distro's filesystem over
   * 9P, and 9P does not carry unix domain sockets. `\\wsl.localhost\dev\run\...`
   * is a path Windows can *see* and can never *connect to*.
   *
   * Reaching it needs a relay process that lives on the Linux side of the
   * boundary (see src/main/docker/wsl.ts). Modelling that as a distinct
   * transport keeps the "how do I get a byte stream" decision in one switch
   * instead of smeared through the client as special cases on the path string.
   */
  | {
      readonly transport: 'wsl';
      readonly distro: string;
      readonly socketPath: string;
    };

/** Where a candidate came from — drives probe order and the diagnostic text. */
export type EndpointOrigin =
  | { readonly kind: 'manual'; readonly label?: string }
  | { readonly kind: 'env'; readonly variable: 'DOCKER_HOST'; readonly value: string }
  | { readonly kind: 'well-known'; readonly runtime: ContainerRuntimeKind }
  | { readonly kind: 'wsl'; readonly distro: string; readonly runtime: ContainerRuntimeKind };

export interface DockerEndpoint {
  readonly transport: DockerTransport;
  readonly origin: EndpointOrigin;
}

/**
 * `not-present` and `connection-refused` are deliberately distinct: a missing
 * socket means the runtime is not installed, a socket that refuses means it is
 * installed and stopped. Different messages, different fixes.
 */
export type EndpointFailure =
  | { readonly code: 'not-present'; readonly detail: string }
  | { readonly code: 'permission-denied'; readonly detail: string }
  | { readonly code: 'connection-refused' }
  | { readonly code: 'timeout'; readonly ms: number }
  | { readonly code: 'tls-required' }
  | { readonly code: 'api-too-old'; readonly server: string; readonly minimum: string }
  | { readonly code: 'unknown'; readonly detail: string };

export type EndpointProbe =
  | {
      readonly ok: true;
      readonly endpoint: DockerEndpoint;
      readonly serverVersion: string;
      readonly apiVersion: string;
      /**
       * What actually answered — read back from the daemon's own /version
       * response, NOT inferred from which socket we happened to knock on.
       *
       * The two disagree more often than you would expect. Podman's
       * docker-compatible pipe on Windows is literally named
       * `\\.\pipe\docker_engine`, so guessing from the path reports "Docker
       * Desktop 5.7.0" — a product that has never had a version 5.7.0, because
       * 5.7.0 is Podman's. `endpoint.origin` keeps the guess, for the case
       * where nothing connected and there is no server to ask.
       */
      readonly runtime: ContainerRuntimeKind;
    }
  | {
      readonly ok: false;
      readonly endpoint: DockerEndpoint;
      readonly failure: EndpointFailure;
    };

/**
 * Separate from the API probe. @devcontainers/cli shells out to the `docker`
 * binary, so its presence is its own question.
 *
 * The same shape also reports the `devcontainer` binary itself (see
 * `DockerEnvironment.devcontainer`): both are "is a program on this machine,
 * and which one" questions, and giving the second its own type would only be
 * a second spelling of this one.
 */
export type DockerCliProbe =
  | { readonly ok: true; readonly binaryPath: string; readonly version: string }
  | {
      readonly ok: false;
      readonly code: 'not-on-path' | 'not-executable' | 'unparseable-version';
      readonly detail?: string;
    };

export interface DockerEnvironment {
  /**
   * What WSL looks like, on Windows. `not-applicable` everywhere else.
   *
   * Part of the environment rather than a separate probe result because on
   * Windows it IS the environment: every mainstream engine runs inside WSL2, so
   * "no socket answered" and "WSL is not installed" are the same finding at two
   * levels of detail, and the UI needs both to say anything useful.
   */
  readonly wsl: WslStatus;
  /**
   * The PRIMARY engine — the first candidate that answered, or the first
   * failure when none did. It drives the headline chip and the error screen.
   *
   * "Primary" and not "the" because a machine can run more than one engine at
   * once, and on Windows routinely does: a `podman machine` behind a named pipe
   * plus a rootless podman inside each WSL distro. boxwarden connects to every
   * one that answers and unions their container lists, so `api` being Podman
   * 5.7.0 does not mean it is the only thing that was reachable — filter
   * `attempts` on `ok` for the full set.
   */
  readonly api: EndpointProbe;
  readonly cli: DockerCliProbe;
  /**
   * The `devcontainer` binary (@devcontainers/cli), probed separately from
   * both of the above because it gates a third set of features: Build and
   * Rebuild shell out to it, and it in turn shells out to `cli`. All three
   * fail independently — a machine can have a healthy socket, a docker binary
   * and no devcontainer CLI, and the UI has to say which leg is missing
   * rather than a generic "can't build".
   */
  readonly devcontainer: DockerCliProbe;
  /**
   * Every candidate tried and rejected, in probe order. This is not logging —
   * it is the diagnostic UI. Probing five runtimes and reporting only
   * "couldn't connect" is what makes this class of tool infuriating; keeping
   * the attempts lets the error say which socket was missing and which was
   * present but denied.
   */
  readonly attempts: readonly EndpointProbe[];
}
