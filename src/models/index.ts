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

export type { EditorAttachment, EditorFlavour } from './editor-session.js';
export {
  attachedEditorsIn,
  classifyEditorTopFailure,
  editorDisplayName,
  parseAttachedEditors,
} from './editor-session.js';

export type {
  DesktopWindow,
  DevContainerTitle,
  EditorWindowClosure,
  EditorWindowCriteria,
} from './editor-window.js';
export {
  EDITOR_PROCESS_NAMES,
  declaredContainerName,
  editorWindowCriteria,
  flavoursOf,
  matchEditorWindows,
  namesWorkspace,
  parseDevContainerTitle,
  parseWindowTable,
  parseWmctrlLine,
  windowFlavour,
} from './editor-window.js';

export type { ClaudeCpuSample, ClaudeSession, ClaudeStatus, SessionActivity } from './claude.js';
export {
  classifyTopFailure,
  cpuSamplesOf,
  foldSessionActivity,
  isWorking,
  looksLikeClaudeCode,
  hasNoProcessTable,
  parseClaudeProcesses,
  parseCpuTime,
  readCommandLines,
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

export type {
  BranchListing,
  BranchTracking,
  GitBranch,
  GitInvocation,
  GitStatus,
  WorkingTree,
} from './git.js';
export {
  BRANCH_REF_FORMAT,
  branchSwitchBlockedReason,
  canSwitchTo,
  gitInvocation,
  parseBranchRefs,
  parseDubiousOwnership,
  parseTracking,
  parseGitDirPointer,
  parseGitHead,
  parseWorkingTree,
  readableHostFolder,
  shortCommit,
  treeBlockedReason,
} from './git.js';

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
  OpenInEditorMode,
  ResolvedEditor,
} from './editor.js';

export { parseOpenInEditorMode } from './editor.js';

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
