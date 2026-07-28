/**
 * Docker connectivity is modelled as TWO independent probes.
 *
 * Socket reachability and `docker` being on PATH fail separately and gate
 * different features:
 *
 *   api.ok -> discover, start, stop. That is all of v0.
 *   cli.ok -> anything shelling out through @devcontainers/cli.
 *
 * Collapsing them into one "Docker is ready" boolean forces a bad choice:
 * refuse to start when `docker` is missing even though v0 never needs it, or
 * report ready and fail later at the CLI call site.
 */

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
    };

/** Where a candidate came from — drives probe order and the diagnostic text. */
export type EndpointOrigin =
  | { readonly kind: 'manual'; readonly label?: string }
  | { readonly kind: 'env'; readonly variable: 'DOCKER_HOST'; readonly value: string }
  | { readonly kind: 'well-known'; readonly runtime: ContainerRuntimeKind };

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
    }
  | {
      readonly ok: false;
      readonly endpoint: DockerEndpoint;
      readonly failure: EndpointFailure;
    };

/**
 * Separate from the API probe. @devcontainers/cli shells out to the `docker`
 * binary, so its presence is its own question.
 */
export type DockerCliProbe =
  | { readonly ok: true; readonly binaryPath: string; readonly version: string }
  | {
      readonly ok: false;
      readonly code: 'not-on-path' | 'not-executable' | 'unparseable-version';
      readonly detail?: string;
    };

export interface DockerEnvironment {
  readonly api: EndpointProbe;
  readonly cli: DockerCliProbe;
  /**
   * Every candidate tried and rejected, in probe order. This is not logging —
   * it is the diagnostic UI. Probing five runtimes and reporting only
   * "couldn't connect" is what makes this class of tool infuriating; keeping
   * the attempts lets the error say which socket was missing and which was
   * present but denied.
   */
  readonly attempts: readonly EndpointProbe[];
}
