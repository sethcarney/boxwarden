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
export { asContainerId, containerSettingsKey, displayStatus } from './devcontainer.js';

export type { ClaudeSession, ClaudeStatus } from './claude.js';
export {
  classifyTopFailure,
  looksLikeClaudeCode,
  parseClaudeProcesses,
  sessionCount,
} from './claude.js';

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

export type {
  Advice,
  AdviceLink,
  AdviceSeverity,
  AdviceInput,
  HostPlatform,
  SshAgentAdviceInput,
  SshAgentHostProbe,
  WindowsAgentService,
} from './advice.js';
export { adviseEnvironment, adviseSshAgent, hostPlatform } from './advice.js';

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

export type { BinaryDiscovery, ResolvedBinary } from './discovery.js';

export type {
  InstallKind,
  Release,
  ReleaseAsset,
  SemanticVersion,
  UpdateFacts,
  UpdateInstructions,
  UpdateOutcome,
  UpdatePreferences,
  UpdateStatus,
} from './update.js';
export {
  DEFAULT_UPDATE_PREFERENCES,
  LATEST_RELEASE_API_URL,
  RELEASE_URL_PREFIX,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_REPOSITORY,
  compareVersions,
  detectInstallKind,
  foldUpdateStatus,
  isCheckDue,
  isNewerVersion,
  normaliseVersion,
  parseRelease,
  parseStoredRelease,
  parseUpdatePreferences,
  parseVersion,
  pickAsset,
  updateInstructions,
} from './update.js';

export type {
  ApplyKind,
  DownloadEntry,
  DownloadPlan,
  DownloadProgress,
  DownloadRefusal,
  SignerIdentity,
  UpdateDownload,
} from './download.js';
export {
  CHECKSUMS_ASSET_NAME,
  DOWNLOAD_RETENTION_MS,
  MAX_DOWNLOAD_BYTES,
  SIGNING_ISSUER,
  applyKindFor,
  isRefusal,
  parseChecksums,
  planDownload,
  safeAssetFileName,
  signatureAssetName,
  signerIdentity,
  staleDownloads,
} from './download.js';

export type {
  ContainerCli,
  ContainerCliKind,
  KnownTerminalId,
  ResolvedTerminal,
  TerminalArgumentEscaping,
  TerminalId,
  TerminalInvocation,
  TerminalTarget,
} from './terminal.js';
export {
  MAX_STARTUP_COMMAND_LENGTH,
  normaliseStartupCommand,
  parseStartupCommands,
  withStartupCommand,
} from './terminal.js';
