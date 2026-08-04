import type { ContainerPath, HostPath, MaybeHostPath } from './paths.js';
import type { SshAgentState } from './ssh-agent.js';

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

  /**
   * The account to enter the container as — what VS Code calls `remoteUser`.
   *
   * Optional, and absent means "let the daemon use the image's own user",
   * which is what `docker exec` does unasked. It is not a display field: the
   * one thing it is for is the terminal, where entering as root instead of the
   * developer's account gives a shell with none of the dev container's tools
   * on PATH — same container, different world.
   *
   * A string rather than a parsed type because it is passed straight to
   * `docker exec -u`, which accepts a name, a uid, or `uid:gid`, and inventing
   * a narrower model would mean rejecting forms the daemon accepts.
   */
  readonly remoteUser?: string;

  /**
   * Whether an SSH agent socket is usable in here.
   *
   * Required, not optional, and with an `absent` arm rather than `undefined`:
   * it is derived from the same inspect response as everything else on this
   * type, so "we did not look" is not a state that can occur. Under
   * `exactOptionalPropertyTypes` an optional field would invite exactly that
   * ambiguity at every call site.
   */
  readonly sshAgent: SshAgentState;

  readonly labels: DevContainerLabels;
  readonly runtime: DevContainerRuntime;
}

/**
 * Stable identity for per-container SETTINGS, which is not the container id.
 *
 * The id is the wrong key for anything the user typed: rebuilding a dev
 * container — the single most common thing to do to one — destroys and
 * recreates it under a new id, and a startup command that evaporates on
 * rebuild is worse than no startup command at all. The host folder survives
 * that, because it is what the container was built FROM.
 *
 * The folder alone is not enough for compose, where every service in a project
 * carries the same `devcontainer.local_folder` and would otherwise share one
 * setting. The container name disambiguates them and is itself stable across
 * `compose up` — it is derived from the project and service names, not from
 * the id.
 */
export function containerSettingsKey(container: DevContainer): string {
  const folder = container.labels.localFolderRaw;
  return container.labels.composeProject === undefined ? folder : `${folder}::${container.name}`;
}
