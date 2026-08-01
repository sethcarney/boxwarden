import type { ContainerPath, HostPath, MaybeHostPath } from './paths.js';

export type ContainerId = string & { readonly __brand: 'ContainerId' };

export function asContainerId(id: string): ContainerId {
  return id as ContainerId;
}

/** Raw label values, kept verbatim for display and debugging. */
export interface DevContainerLabels {
  /** devcontainer.local_folder — the host path, exactly as Docker returned it. */
  readonly localFolderRaw: string;
  /** devcontainer.config_file */
  readonly configFileRaw?: string;
  /** devcontainer.metadata — shape is not stable across CLI versions, so it stays a string here. */
  readonly metadataRaw?: string;
  /**
   * com.docker.compose.project, when the devcontainer is compose-based.
   *
   * v0 acts on containers individually, which means stopping one leaves its
   * siblings running. Carrying the label now means grouping can be added
   * later without reshaping this type.
   */
  readonly composeProject?: string;
}

export type Health = 'starting' | 'healthy' | 'unhealthy' | 'none';

export interface PortBinding {
  readonly containerPort: number;
  readonly protocol: 'tcp' | 'udp';
  readonly hostIp?: string;
  /** Absent means exposed but not published to the host. */
  readonly hostPort?: number;
}

/**
 * Docker's full state machine. Fields live on the arms where they are
 * meaningful: a stopped container has no uptime and no published ports, so
 * the UI is forced to narrow before it can render either. Flat optional
 * fields would let it print "up 0 seconds" for something that exited days ago.
 *
 * `startedAt` rather than `uptime` — uptime is a function of the clock, so
 * storing it means storing a value that is stale the instant it is computed.
 */
export type DevContainerRuntime =
  | { readonly state: 'created' }
  | {
      readonly state: 'running';
      readonly startedAt: Date;
      readonly ports: readonly PortBinding[];
      readonly health?: Health;
    }
  | {
      readonly state: 'paused';
      readonly startedAt: Date;
      readonly ports: readonly PortBinding[];
    }
  | { readonly state: 'restarting'; readonly startedAt?: Date }
  | { readonly state: 'exited'; readonly exitCode: number; readonly finishedAt: Date }
  | { readonly state: 'dead' }
  | { readonly state: 'removing' };

/** Coarse bucket for list rendering, sorting, and colour. */
export type DisplayStatus = 'running' | 'stopped' | 'transitional';

/**
 * Collapses the seven Docker states to three for the UI, without discarding
 * them: callers that need `exitCode` or want to distinguish `dead` from a
 * clean exit still have `runtime.state`.
 *
 * `paused` maps to running because the container is live and holds its ports;
 * the list row can still show the precise state alongside.
 */
export function displayStatus(runtime: DevContainerRuntime): DisplayStatus {
  switch (runtime.state) {
    case 'running':
    case 'paused':
      return 'running';
    case 'created':
    case 'exited':
    case 'dead':
      return 'stopped';
    case 'restarting':
    case 'removing':
      return 'transitional';
  }
}

export interface DevContainer {
  readonly id: ContainerId;
  readonly name: string;
  readonly image: string;
  readonly createdAt: Date;

  /** Parsed from `labels.localFolderRaw`; degraded rather than dropped when unparseable. */
  readonly localFolder: MaybeHostPath;

  /**
   * Container-side path — the trailing segment of the editor URI.
   *
   * Optional because its source is not guaranteed: it may come from
   * devcontainer.metadata, the container's WorkingDir, or the
   * /workspaces/<basename> convention, and a container this app did not
   * create may expose none of them. When absent, "Open in editor" is
   * disabled with a reason rather than opening a path that may not exist.
   */
  readonly workspaceFolder?: ContainerPath;

  readonly configFile?: HostPath;

  readonly labels: DevContainerLabels;
  readonly runtime: DevContainerRuntime;
}
