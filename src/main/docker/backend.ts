import type {
  ContainerId,
  DevContainer,
  DockerEndpoint,
  DockerEnvironment,
  EngineSelection,
} from '../../models/index.js';

/**
 * Everything the app needs from a container runtime, and nothing more.
 *
 * The interface exists so the fake backend (src/main/docker/fake.ts) is a peer
 * of the real one rather than a special case threaded through it with `if`s.
 * That matters for a tool whose entire job is talking to Docker: without a
 * substitutable backend, no part of the UI can be developed or demonstrated on
 * a machine where Docker is unavailable — including this project's own CI.
 */
export interface DockerBackend {
  /** Never rejects. Connection failure is data, since it is the thing the UI has to explain. */
  probe(): Promise<DockerEnvironment>;
  listDevContainers(): Promise<readonly DevContainer[]>;
  start(id: ContainerId): Promise<void>;
  stop(id: ContainerId): Promise<void>;

  /**
   * Which engine to use when several answer.
   *
   * Set on the backend rather than passed to `listDevContainers`, because
   * `start` and `stop` have to agree with the list the user is looking at — a
   * selection that applied only to listing would leave the buttons acting on an
   * engine the UI is not showing.
   */
  selection(): EngineSelection;
  select(selection: EngineSelection): void;

  /**
   * Which endpoint the container was last seen on, or undefined if it was not
   * in the last scan.
   *
   * Needed because opening a terminal shells out to the `docker` CLI, and the
   * CLI has its own idea of which daemon to talk to. Selection narrows what
   * this app lists, but it does not reach the CLI — so on a machine with two
   * engines the exec would be a coin flip, and losing it means "no such
   * container" for one that is plainly on screen. Everything else here reuses
   * the dockerode connection and never has to ask.
   */
  endpointFor(id: ContainerId): DockerEndpoint | undefined;
}
