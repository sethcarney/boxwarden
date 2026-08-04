import type {
  Advice,
  ClaudeStatus,
  ContainerId,
  DevContainer,
  DockerEnvironment,
  EditorAttachment,
  EditorId,
  EngineSelection,
  EngineSummary,
  GitStatus,
  ProjectId,
  ProjectScan,
  TerminalId,
  UpdateStatus,
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

/**
 * Claude Code presence, keyed by container id.
 *
 * A plain record rather than a Map: structured clone would carry a Map, but
 * every other payload here is plain data and the renderer holds this in state,
 * where a record compares and spreads without ceremony.
 *
 * An ABSENT key means "not asked, or asked about a container the main process
 * does not recognise" — not "no session". The renderer must not collapse the
 * two: a missing entry renders no badge, `{ kind: 'none' }` renders no badge
 * *and* means the Stop button is safe.
 */
export type ClaudeStatusMap = Readonly<Record<ContainerId, ClaudeStatus>>;

/**
 * What is going on INSIDE a container, from one reading of its process table.
 *
 * Two answers in one object because they come from one `top` call: whether a
 * Claude Code session is running, and whether an editor is attached. Splitting
 * them into two verbs would double the Docker traffic of the poll to ask the
 * same engine the same question twice.
 *
 * Both are things the Stop button needs to know, and both keep `unknown`
 * distinct from `none` for the same reason — a card with no warning is a card
 * saying stopping is safe.
 */
export interface ContainerActivity {
  readonly claude: ClaudeStatus;
  readonly editor: EditorAttachment;
}

/** Keyed by container id, with an absent key meaning "not asked" — see `ClaudeStatusMap`. */
export type ContainerActivityMap = Readonly<Record<ContainerId, ContainerActivity>>;

/**
 * Which branch each container's workspace folder is on, keyed by container id.
 *
 * Same shape and the same rule as `ClaudeStatusMap`: an ABSENT key means "not
 * asked, or asked about a container the main process does not recognise", and
 * is not the same as `{ kind: 'none' }`. Both render as no chip, but only the
 * second one is a statement about the folder.
 */
export type GitStatusMap = Readonly<Record<ContainerId, GitStatus>>;

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
  containerActivity: 'boxwarden:container-activity',
  gitStatus: 'boxwarden:git-status',
  updateStatus: 'boxwarden:update-status',
  dismissUpdate: 'boxwarden:dismiss-update',
  setUpdateChecks: 'boxwarden:set-update-checks',
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

  /**
   * ---- What is running inside ----
   *
   * Whether a Claude Code session is running inside each of these containers,
   * and whether an editor is attached to them. ONE verb and one `top` per
   * container, because they are one reading of one process table — asking
   * twice would double this poll's Docker traffic to learn nothing extra.
   *
   * Its own verb, and not a field on `DiscoverySnapshot`, for the reason
   * `scanProjects` is not in there either: CADENCE. Discovery polls every five
   * seconds, and folding this in would multiply that poll's Docker traffic by
   * the number of live containers — one `top` each — to re-derive an answer
   * that changes on the timescale of a person starting an agent. The renderer
   * polls it on a slower clock of its own.
   *
   * Batched so one round trip covers the whole list. Ids are validated against
   * the main process's own last container list before use, the same rule as
   * `openInEditor` taking an id rather than a `DevContainer`. Never rejects: a
   * per-container failure comes back as `{ kind: 'unknown' }`, which the UI
   * must keep distinct from `none` — the Stop button reads it.
   */
  containerActivity(ids: readonly ContainerId[]): Promise<ContainerActivityMap>;

  /**
   * ---- Branch ----
   *
   * Which branch each container's workspace folder is checked out on, read
   * from `.git/HEAD` on the HOST — not from inside the container. See
   * src/models/git.ts for why the answer comes from there.
   *
   * A verb of its own on the same grounds as the two above: CADENCE, and this
   * time it is the filesystem's. Discovery polls every five seconds; folding
   * these reads into it would put a `stat` per container behind a poll that
   * runs seven hundred times an hour — on a path that may be a network share
   * or a UNC into a WSL distro — to re-derive an answer that changes when
   * somebody types `git switch`. It is asked on a slower clock of its own.
   *
   * Batched, ids validated against the main process's own last container list,
   * and never rejects — all three the same rules as `claudeStatus`. The
   * renderer never names a FOLDER: it sends ids, and the main process reads
   * only the paths its own last scan produced. A path arriving over the bridge
   * would be a renderer choosing which of the user's directories this process
   * opens.
   */
  gitStatus(ids: readonly ContainerId[]): Promise<GitStatusMap>;

  /**
   * ---- Self-update ----
   *
   * Three verbs, and each one clears one of the bars a new channel has to
   * clear (see CLAUDE.md):
   *
   *   - `updateStatus` is a THIRD cadence, and by far the slowest: a network
   *     call to GitHub, at most once a day. Folding it into `DiscoverySnapshot`
   *     would put an HTTP request behind a poll that runs seven hundred times
   *     an hour, to re-derive an answer that changes when somebody publishes a
   *     release.
   *   - `dismissUpdate` and `setUpdateChecks` change main-process state that
   *     OUTLIVES the call — both are written to preferences.json and read on
   *     the next launch — which is the same bar `selectEngine` cleared.
   *
   * All three answer with the whole status rather than an `ActionResult`, so
   * the UI never has to guess what a mutation did: it re-renders from the
   * value it was handed.
   */

  /**
   * What the last look found, checking first if a day has passed.
   *
   * `force` is the "Check now" button, and it is the only input the renderer
   * supplies anywhere in this feature. It cannot choose a URL — that is a
   * constant in the models layer — and it cannot turn checks on: a `force`
   * against disabled checks still answers `disabled` without touching the
   * network.
   */
  updateStatus(force: boolean): Promise<UpdateStatus>;

  /**
   * "Not now" about the version currently on offer.
   *
   * No argument, for the reason `addProjectRoot` takes none: the renderer says
   * that the user dismissed something, and the main process decides WHICH
   * version that was, from its own last status. A version number arriving over
   * the bridge could silence a release the user was never shown.
   */
  dismissUpdate(): Promise<UpdateStatus>;

  /** Turn the daily check off, or back on — persisted, and checked immediately when on. */
  setUpdateChecks(enabled: boolean): Promise<UpdateStatus>;

  /*
   * There is deliberately NO `downloadUpdate` / `installUpdate` here.
   *
   * There was, and the three verbs did clear the bar — a sandboxed renderer has
   * no filesystem, so nothing else could have expressed them. They were removed
   * for a reason that is not about this surface at all: the app cannot swap its
   * own bundle without a code-signing certificate, so an in-app download ended
   * at the same installer a browser download ends at, having first required
   * Sigstore's CDN to be reachable or else REFUSING, in words that read like an
   * accusation of tampering. See the note at the top of src/models/update.ts.
   *
   * Clearing the bar is necessary for a verb, never sufficient. If they come
   * back it should be because a certificate arrived and `electron-updater` is
   * doing the whole job, not because the shape looked re-addable.
   */
}
