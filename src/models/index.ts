export type { HostPath, UnresolvedPath, MaybeHostPath, ContainerPath } from './paths.js';
export { asContainerPath, projectName, formatHostPath } from './paths.js';

export type {
  ContainerId,
  DevContainer,
  DevContainerLabels,
  DevContainerRuntime,
  DisplayStatus,
  Health,
  PortBinding,
} from './devcontainer.js';
export { asContainerId, displayStatus } from './devcontainer.js';

export type {
  ContainerRuntimeKind,
  DockerCliProbe,
  DockerEndpoint,
  DockerEnvironment,
  DockerTls,
  DockerTransport,
  EndpointFailure,
  EndpointOrigin,
  EndpointProbe,
} from './docker-endpoint.js';

export type { SshAgentState } from './ssh-agent.js';
export { SSH_AUTH_SOCK, containersMissingAgentSocket, sshAgentState } from './ssh-agent.js';

export type { WslDistroReport, WslStatus } from './wsl.js';
export { distrosMissingSocat, reachableDistros } from './wsl.js';

export type { EngineId, EngineSelection, EngineSummary } from './engine.js';
export {
  ALL_ENGINES,
  engineIdFor,
  enginesFrom,
  parseEngineSelection,
  selectionIncludes,
  selectionIsReachable,
} from './engine.js';

export type { Advice, AdviceLink, AdviceSeverity, AdviceInput, HostPlatform } from './advice.js';
export { adviseEnvironment, hostPlatform } from './advice.js';

export type {
  DevContainerProject,
  PartitionedProjects,
  ProjectId,
  ProjectRoot,
  ProjectScan,
  RootFailure,
  ScannedRoot,
} from './project.js';
export {
  CONFIG_DIRECTORY,
  CONFIG_FILENAME,
  ROOT_CONFIG_FILENAME,
  asProjectId,
  comparableFolder,
  defaultProjectRoots,
  devcontainerName,
  parseProjectRoots,
  partitionProjects,
  resolveProjectRoots,
  shouldDescend,
  sortProjects,
  stripJsonc,
} from './project.js';

export type {
  DevContainerAuthority,
  EditorDiscovery,
  EditorId,
  EditorTarget,
  KnownEditorId,
  ResolvedEditor,
} from './editor.js';
