import type {
  Advice,
  ContainerId,
  DevContainer,
  DockerEnvironment,
  EditorId,
  EngineSelection,
  EngineSummary,
  ProjectId,
  ProjectScan,
  TerminalId,
} from '../models/index.js';

/**
 * The main <-> renderer contract.
 *
 * Domain types cross the boundary unchanged. Electron's IPC uses the
 * structured clone algorithm, which preserves `Date` — so `startedAt` arrives
 * in the renderer as a real Date, not a string, and the branded string types
 * (`ContainerId`, `ContainerPath`) survive as their underlying strings. That
 * is why there is no parallel set of "wire" types here: a second copy of
 * `DevContainer` that had to be kept in sync with the first would be a
 * standing invitation for the two to drift.
 *
 * The one thing that does NOT survive is a class instance or a function, so
 * everything below is plain data.
 */

/**
 * One complete look at the world: what Docker looked like, and what was found
 * there. Both halves travel together deliberately — a container list with no
 * environment attached cannot distinguish "Docker is up and you have no dev
 * containers" from "we never reached Docker", and those need very different
 * screens. The renderer narrows on `environment.api.ok` to tell them apart.
 */
export interface DiscoverySnapshot {
  readonly scannedAt: Date;
  readonly environment: DockerEnvironment;
  /** Always empty when `environment.api.ok` is false. */
  readonly containers: readonly DevContainer[];
  /** Every engine that answered this scan — what the engine picker offers. */
  readonly engines: readonly EngineSummary[];
  /** Which of them is in use. `all` unions them, and is the default. */
  readonly selection: EngineSelection;
  /**
   * What to tell the user about this environment, computed in the main process.
   *
   * Computed there and not in the renderer because the inputs are things only
   * the main process knows — the platform, whether WSL is installed, whether a
   * distro has socat. Sending the advice rather than the raw facts also keeps
   * the wording in one pure, tested function (src/domain/advice.ts) instead of
   * spread across JSX.
   */
  readonly advice: readonly Advice[];
}

/**
 * Lifecycle actions report failure as data rather than throwing across IPC.
 * An exception thrown in a main-process handler reaches the renderer as an
 * opaque "Error invoking remote method" string with the real message buried,
 * which is precisely the information the UI needs to show.
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type OpenInEditorFailure =
  /** The container exposed no workspace path, so there is nothing to open. */
  | 'no-workspace-folder'
  /** devcontainer.local_folder could not be parsed into a host path. */
  | 'unresolved-host-path'
  /** No binary found for the requested editor. */
  | 'editor-not-found'
  /** The binary was found but the spawn failed. */
  | 'launch-failed';

export type OpenInEditorResult =
  | { readonly ok: true; readonly editorId: EditorId; readonly uri: string }
  | {
      readonly ok: false;
      readonly code: OpenInEditorFailure;
      readonly message: string;
      /** Present when the URI was built but launching it failed — useful for "copy URI" fallback. */
      readonly uri?: string;
    };

/** An editor offered in the UI, with whether it was actually found on this machine. */
export interface EditorOption {
  readonly id: EditorId;
  readonly displayName: string;
  readonly available: boolean;
}

/**
 * The result of adding or removing a scan root.
 *
 * Carries the new list rather than an `ok` alone so the UI does not have to
 * guess what happened: "Add folder…" opens a native dialog the renderer cannot
 * see, and `cancelled` is the answer for the user who thought better of it —
 * distinct from a failure, and distinct from a root that was added. The new
 * root list is not returned, because a changed root list means the projects are
 * stale too and the renderer rescans regardless.
 */
export type ProjectRootsResult =
  | { readonly ok: true; readonly cancelled: boolean }
  | { readonly ok: false; readonly message: string };

/** Same shape as `EditorOption`, for the terminal emulators found on this machine. */
export interface TerminalOption {
  readonly id: TerminalId;
  readonly displayName: string;
  readonly available: boolean;
}

export type OpenTerminalFailure =
  /** `docker exec` needs a live container; a stopped one has no process namespace to enter. */
  | 'not-running'
  /** Neither `docker` nor `podman` is on PATH, so there is nothing to exec with. */
  | 'container-cli-not-found'
  /** No terminal emulator found for the requested id. */
  | 'terminal-not-found'
  /** The emulator was found but the spawn failed. */
  | 'launch-failed';

export type OpenTerminalResult =
  | { readonly ok: true; readonly terminalId: TerminalId; readonly command: string }
  | {
      readonly ok: false;
      readonly code: OpenTerminalFailure;
      readonly message: string;
      /**
       * The exec command line, when one could be built. Serves the same purpose
       * as `uri` above: if the terminal could not be opened but the command is
       * sound, the user can paste it into a shell they already have and get
       * where they were going.
       */
      readonly command?: string;
    };

export const IPC = {
  discover: 'boxwarden:discover',
  start: 'boxwarden:start',
  stop: 'boxwarden:stop',
  listEditors: 'boxwarden:list-editors',
  openInEditor: 'boxwarden:open-in-editor',
  selectEngine: 'boxwarden:select-engine',
  scanProjects: 'boxwarden:scan-projects',
  openProject: 'boxwarden:open-project',
  addProjectRoot: 'boxwarden:add-project-root',
  removeProjectRoot: 'boxwarden:remove-project-root',
  listTerminals: 'boxwarden:list-terminals',
  openTerminal: 'boxwarden:open-terminal',
  getStartupCommands: 'boxwarden:get-startup-commands',
  setStartupCommand: 'boxwarden:set-startup-command',
} as const;

/**
 * The surface exposed on `window.boxwarden`. Declared here rather than in the
 * preload so the renderer can import the type without importing preload code,
 * which would drag Electron into the browser bundle.
 */
export interface BoxwardenApi {
  discover(): Promise<DiscoverySnapshot>;
  start(id: ContainerId): Promise<ActionResult>;
  stop(id: ContainerId): Promise<ActionResult>;
  listEditors(): Promise<readonly EditorOption[]>;
  openInEditor(id: ContainerId, editorId: EditorId): Promise<OpenInEditorResult>;
  /**
   * The sixth verb, and the only one added since the surface was fixed at five.
   * It earns the channel rather than looping over an existing one because it
   * changes main-process state that outlives the call — every subsequent
   * discover, start and stop reads it — which no combination of the others can
   * express.
   */
  selectEngine(selection: EngineSelection): Promise<ActionResult>;

  /**
   * ---- Unbuilt projects ----
   *
   * Four verbs, added together, and the reason they are not folded into the
   * six above is latency. Everything above answers from a Docker socket in
   * milliseconds and is polled every five seconds; `scanProjects` walks the
   * filesystem and is allowed up to ten. Putting the projects in
   * `DiscoverySnapshot` would make the poll pay for the walk sixty times an
   * hour to re-derive an answer that changes when someone clones a repo.
   *
   * So this is a second, slower cadence, driven by the user: on open, and on
   * demand.
   */

  /** Walk the configured roots for `devcontainer.json` files. Slow — do not poll. */
  scanProjects(): Promise<ProjectScan>;

  /**
   * Open an unbuilt project's folder locally, so the editor can offer
   * "Reopen in Container".
   *
   * Takes a `ProjectId` and not a path, for the same reason `openInEditor`
   * takes a container id: the main process looks up its own copy from the last
   * scan rather than spawning an editor at a path the renderer supplied.
   */
  openProject(id: ProjectId, editorId: EditorId): Promise<OpenInEditorResult>;

  /**
   * Add a scan root, chosen in the OS folder picker.
   *
   * No argument — deliberately. The renderer never names a directory for the
   * main process to walk; the user names it, in a dialog the renderer cannot
   * see or drive.
   */
  addProjectRoot(): Promise<ProjectRootsResult>;

  /** Remove a root by path. Safe to accept a string: it can only ever narrow what is scanned. */
  removeProjectRoot(root: string): Promise<ProjectRootsResult>;

  /**
   * ---- Terminals ----
   *
   * Read once, like `listEditors`: the set of terminal emulators on a machine
   * does not change while the app is open.
   */
  listTerminals(): Promise<readonly TerminalOption[]>;

  /**
   * Open a shell in a running container.
   *
   * The startup command is deliberately NOT a parameter. The renderer sends an
   * id; the main process looks up its own copy of the container and its own
   * copy of the command, exactly as `openInEditor` refuses to accept a host
   * path and `openProject` refuses to accept a folder. What gets spawned is
   * then a function of what the main process already trusted, not of what the
   * message contained.
   */
  openTerminal(id: ContainerId, terminalId: TerminalId): Promise<OpenTerminalResult>;

  /** Keyed by `containerSettingsKey`, so the renderer can look one up per card. */
  getStartupCommands(): Promise<Readonly<Record<string, string>>>;

  /**
   * Set or clear one container's startup command. An empty command clears it.
   *
   * The container is named by id and the KEY is derived in the main process, so
   * a renderer cannot file a startup command against a folder it invented.
   */
  setStartupCommand(id: ContainerId, command: string): Promise<ActionResult>;
}
