import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type {
  BranchListing,
  ContainerCli,
  ContainerId,
  DevContainer,
  DevContainerProject,
  BranchTracking,
  DockerEnvironment,
  EditorAttachment,
  EditorWindowClosure,
  EngineSelection,
  GitStatus,
  HostPath,
  WorkingTree,
  ProjectId,
  ProjectRoot,
  ProjectScan,
  UpdateStatus,
} from '../models/index.js';
import {
  adviseEnvironment,
  containerSettingsKey,
  containersMissingAgentSocket,
  enginesFrom,
  hostPlatform,
  parseEngineSelection,
  parseOpenInEditorMode,
  readableHostFolder,
} from '../models/index.js';
import { IPC } from '../shared/ipc.js';
import type {
  ActionResult,
  ContainerActivity,
  ContainerActivityMap,
  DiscoverySnapshot,
  EditorOption,
  GitStatusMap,
  OpenInEditorResult,
  OpenTerminalResult,
  ProjectRootsResult,
  StopResult,
  TerminalOption,
} from '../shared/ipc.js';
import type { DockerBackend } from './docker/backend.js';
import { EDITOR_TARGETS, editorTarget } from './editor/targets.js';
import { resolveEditor } from './editor/resolve.js';
import { launchEditor } from './editor/launch.js';
import { cursorDevContainerUri, devContainerUri, folderUri } from './editor/uri.js';
import { scanForProjects } from './projects/scan.js';
import { probeSshAgent } from './ssh-agent.js';
import {
  containerExecArgv,
  containerShellScript,
  posixQuote,
  terminalLaunch,
} from './terminal/command.js';
import { launchTerminal } from './terminal/launch.js';
import { resolveContainerCli, resolveTerminal } from './terminal/resolve.js';
import { terminalsFor, terminalTarget } from './terminal/targets.js';
import { closeAttachedEditorWindows } from './window/close.js';
import type { UpdatesContext } from './update/check.js';

/**
 * Registering the handlers needs the backend and a way to recognise our own
 * renderer, both of which are decided in index.ts. Passing them in keeps this
 * module free of Electron app lifecycle concerns and testable in principle.
 */
export interface IpcContext {
  readonly backend: DockerBackend;
  /**
   * Item 17 of Electron's security checklist: validate the sender of every IPC
   * message. `ipcMain.handle` will answer ANY frame in the app, including one
   * that a compromised or hijacked renderer navigated to. Checking identity in
   * one place here means a future second window cannot silently acquire the
   * ability to start containers.
   *
   * See https://www.electronjs.org/docs/latest/tutorial/security
   */
  isTrustedSender(contents: WebContents): boolean;

  /**
   * Persist the engine choice. Optional so tests and the fake backend can skip
   * it; a run without it simply forgets the selection on quit.
   */
  onSelectionChanged?(selection: EngineSelection): void;

  /** Everything the project scan needs from outside this module. */
  readonly projects: ProjectsContext;

  /** Where the per-container startup commands are read from and written to. */
  readonly terminals: TerminalsContext;

  /** How a workspace folder's checkout is read. A seam so the fixtures can fake it. */
  readonly git: GitContext;

  /**
   * The daily release check.
   *
   * Reached through the same kind of seam as the folder picker: this module
   * knows nothing about `net.fetch`, `app.getVersion()` or where preferences
   * live, and the checker knows nothing about IPC.
   */
  readonly updates: UpdatesContext;
}

/**
 * The startup commands, reached through a seam for the same reason the project
 * roots are: this module knows nothing about where preferences live on disk,
 * and index.ts owns that along with the window and the trusted sender.
 */
export interface TerminalsContext {
  startupCommands(): Readonly<Record<string, string>>;
  /** `key` is a `containerSettingsKey` derived here, never a renderer-supplied string. */
  setStartupCommand(key: string, command: string): void;
}

/** What `workingTree` answers with — the two counts the chip can show. */
export interface GitWorkingTree {
  readonly tree: WorkingTree;
  readonly tracking?: BranchTracking;
}

/**
 * Reading a checkout, behind a seam for the same reason the folder picker is:
 * so that the fixture run can answer without touching the disk, and so this
 * module holds no filesystem code of its own.
 */
export interface GitContext {
  /** `process.platform`. Passed in for the same reason `ProjectsContext` takes it. */
  readonly platform: string;
  /**
   * Never rejects; every failure is a `GitStatus` arm.
   *
   * A STRING, unlike the two below, and the difference is the point. This only
   * opens files, so it wants the spelling the host OS can open — which for a
   * WSL workspace is the `\\wsl.localhost\…` UNC form `readableHostFolder`
   * produces.
   */
  status(folder: string): Promise<GitStatus>;
  /**
   * Never rejects; every failure is the `unavailable` arm of `BranchListing`.
   *
   * A `HostPath` and not a string, because this SPAWNS git and the two
   * questions have different answers: a WSL workspace is opened through a UNC
   * path and reasoned about through the distro plus a Linux path. Flattening it
   * to a string here is exactly the bug `gitInvocation` exists to prevent —
   * Windows git against a `\\wsl.localhost\…` path refuses on ownership.
   */
  branches(folder: HostPath): Promise<BranchListing>;
  /**
   * The dirty count and the divergence for one workspace, or undefined.
   *
   * Never rejects, and silent about WHY it could not answer: this decorates a
   * chip that must keep working on a machine with no git installed, so a
   * missing count has to read as an ordinary absence rather than a fault. The
   * branch MENU is where a git failure gets explained, because that is where
   * the user asked for something git had to do.
   *
   * `key` is the same folder string the branch read is deduplicated by, and it
   * is what the implementation caches against — this is the expensive half of
   * the poll and it is deliberately allowed to be stale.
   */
  workingTree(folder: HostPath, key: string): Promise<GitWorkingTree | undefined>;
  /**
   * Check a branch out. Never rejects — a refusal is `{ ok: false, message }`,
   * and the refusal is decided behind this seam rather than in front of it, so
   * the fixture run enforces the same rules the real one does.
   */
  switchBranch(folder: HostPath, branch: string): Promise<ActionResult>;
}

/**
 * The seams the unbuilt-project verbs reach the world through.
 *
 * `chooseFolder` is a function rather than a call to `dialog.showOpenDialog`
 * inline for one reason worth stating: the folder picker must be parented to
 * the app's own window, and this module deliberately knows nothing about
 * windows — index.ts owns that, the same way it owns `isTrustedSender`.
 */
export interface ProjectsContext {
  /** `process.platform`. Passed in, never read, so the path flavour is decided in one place. */
  readonly platform: string;
  /** The roots to walk, already resolved from preferences and platform defaults. */
  roots(): readonly ProjectRoot[];
  /** Persist a new root list. */
  setRoots(roots: readonly string[]): void;
  /** Ask the user for a folder. Resolves undefined when they cancel. */
  chooseFolder(): Promise<string | undefined>;
}

export function registerIpcHandlers(context: IpcContext): void {
  /**
   * The last discovery, keyed by id.
   *
   * `openInEditor` needs the container's label and workspace folder, and the
   * renderer holds a copy already. It still sends only the id: accepting a
   * whole DevContainer from the renderer would mean acting on a host path the
   * renderer supplied, which is precisely the kind of trust inversion the
   * sender check above exists to prevent. The main process looks up its own
   * copy instead.
   */
  const known = new Map<ContainerId, DevContainer>();

  /**
   * The last project scan, keyed by id — the filesystem's counterpart to
   * `known`, and kept for exactly the same reason. `openProject` spawns an
   * editor at a folder on disk; that folder has to be one boxwarden found
   * itself, not a path that arrived over IPC.
   */
  const knownProjects = new Map<ProjectId, DevContainerProject>();

  /** Wraps a handler with the sender check and turns throws into typed failures. */
  function handle<T>(
    channel: string,
    fn: (...args: unknown[]) => Promise<T>,
    onError: (message: string) => T,
  ): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
      if (!context.isTrustedSender(event.sender)) {
        return onError('Rejected an IPC message from an unrecognised frame.');
      }
      try {
        return await fn(...args);
      } catch (error) {
        return onError(error instanceof Error ? error.message : String(error));
      }
    });
  }

  /**
   * Everything derived from an environment, in one place.
   *
   * A helper rather than three inline copies because `discover` has three
   * return paths — untrusted sender, unreachable engine, listing failed — and
   * an advisory or an engine list missing from one of them would show up as a
   * panel that flickers away on the exact scan where it mattered most.
   */
  async function snapshotOf(
    scannedAt: Date,
    environment: DockerEnvironment,
    containers: readonly DevContainer[],
  ): Promise<DiscoverySnapshot> {
    const selection = context.backend.selection();
    return {
      scannedAt,
      environment,
      containers,
      engines: enginesFrom(environment),
      selection,
      advice: adviseEnvironment({
        platform: hostPlatform(process.platform),
        environment,
        selection,
        sshAgent: {
          // Cached for 30s inside the probe — see the note there. Awaited
          // rather than read from a background refresh so the advisory is
          // right on the FIRST scan; an advisory that appears one poll late is
          // an advisory the user has already scrolled past.
          host: await probeSshAgent(),
          // Names, not containers: the advisory only ever prints them, and a
          // pure function that could reach into a DevContainer is a pure
          // function that could start printing host paths.
          unmountedIn: containersMissingAgentSocket(containers).map((container) => container.name),
        },
      }),
    };
  }

  ipcMain.handle(IPC.discover, async (event): Promise<DiscoverySnapshot> => {
    const scannedAt = new Date();
    if (!context.isTrustedSender(event.sender)) {
      return await snapshotOf(scannedAt, await context.backend.probe(), []);
    }

    const environment = await context.backend.probe();
    if (!environment.api.ok) {
      known.clear();
      return await snapshotOf(scannedAt, environment, []);
    }

    try {
      const containers = await context.backend.listDevContainers();
      known.clear();
      for (const container of containers) known.set(container.id, container);
      return await snapshotOf(scannedAt, environment, containers);
    } catch (error) {
      // Reached the daemon, then failed to list. Surface it as an endpoint
      // failure rather than an empty list, which would read as "no dev
      // containers" and send the user looking in the wrong place.
      return await snapshotOf(
        scannedAt,
        {
          ...environment,
          api: {
            ok: false,
            endpoint: environment.api.endpoint,
            failure: {
              code: 'unknown',
              detail: error instanceof Error ? error.message : String(error),
            },
          },
        },
        [],
      );
    }
  });

  handle<ActionResult>(
    IPC.selectEngine,
    (raw) => {
      // Parsed, never trusted. This value arrives from the renderer and is
      // matched against endpoint identities in the backend; `parseEngineSelection`
      // reduces anything unrecognised to "all engines" rather than letting an
      // arbitrary string through to be compared.
      const selection = parseEngineSelection(raw);
      context.backend.select(selection);
      context.onSelectionChanged?.(selection);
      // The container-to-engine map was just dropped, so the ids the renderer
      // holds are stale until it refreshes. It does that immediately.
      known.clear();
      return Promise.resolve({ ok: true });
    },
    (message) => ({ ok: false, message }),
  );

  handle<ActionResult>(
    IPC.start,
    async (id) => {
      await context.backend.start(id as ContainerId);
      return { ok: true };
    },
    (message) => ({ ok: false, message }),
  );

  /**
   * What is attached to a container right now, for the stop below.
   *
   * Asked here rather than taken from the renderer's poll for the usual reason
   * — the renderer does not get to say what is running in a container — and one
   * `top` on a click is a cost the 15s poll already pays sixty times an hour.
   * Never rejects: a container that has gone away answers `unknown`, which
   * `closeAttachedEditorWindows` treats as "look anyway".
   */
  async function attachedEditors(id: ContainerId): Promise<EditorAttachment> {
    try {
      const activity = await context.backend.containerActivity([id]);
      return activity.get(id)?.editor ?? { kind: 'unknown', reason: 'Not in the last reading.' };
    } catch (error) {
      return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  handle<StopResult>(
    IPC.stop,
    async (id) => {
      const containerId = id as ContainerId;
      const container = known.get(containerId);

      // A container that is not in the last scan is still stopped — the id is
      // handed to the backend either way — but nothing is closed for it. The
      // window match needs the container's folder and labels, and inventing
      // them from a bare id is exactly the trust inversion `known` exists to
      // prevent.
      const windows: EditorWindowClosure =
        container === undefined
          ? { kind: 'none' }
          : await closeAttachedEditorWindows(container, await attachedEditors(containerId));

      if (windows.kind === 'still-open') {
        return {
          ok: false,
          windows,
          message:
            windows.windows === 1
              ? 'The editor window would not close — it is probably asking about unsaved changes. Deal with that, then stop the container.'
              : `${String(windows.windows)} editor windows would not close — they are probably asking about unsaved changes. Deal with that, then stop the container.`,
        };
      }

      await context.backend.stop(containerId);
      return { ok: true, windows };
    },
    (message) => ({ ok: false, message }),
  );

  handle<readonly EditorOption[]>(
    IPC.listEditors,
    async () => {
      const resolved = await Promise.all(EDITOR_TARGETS.map((target) => resolveEditor(target)));
      return resolved.map((entry) => ({
        id: entry.target.id,
        displayName: entry.target.displayName,
        available: entry.ok,
        // The resolver already knows both of these and used to drop them on the
        // floor here. Carrying them is what lets the setup page say WHICH
        // `cursor` it found — see the note on EditorOption.
        ...(entry.ok ? { binaryPath: entry.binaryPath, via: entry.via } : {}),
      }));
    },
    () => [],
  );

  handle<OpenInEditorResult>(
    IPC.openInEditor,
    async (rawId, rawEditorId, rawMode) => {
      const container = known.get(rawId as ContainerId);
      if (container === undefined) {
        return {
          ok: false,
          code: 'launch-failed',
          message: 'That container is no longer in the last scan. Refresh and try again.',
        };
      }

      if (container.workspaceFolder === undefined) {
        return {
          ok: false,
          code: 'no-workspace-folder',
          message:
            'This container does not say which folder to open. It was probably not created by the Dev Containers extension.',
        };
      }

      // The EDITOR is resolved before the URI, and that ordering is the fix for
      // a real bug: the two VS Code-family forks do not agree on how the
      // `dev-container` authority is spelled, so a URI built before the target
      // was known was VS Code's spelling handed to everyone. See
      // `EditorTarget.devContainerSpec`.
      const target = editorTarget(String(rawEditorId));
      if (target === undefined) {
        return {
          ok: false,
          code: 'editor-not-found',
          message: `Unknown editor: ${String(rawEditorId)}`,
        };
      }

      let uri: string | undefined;
      if (target.devContainerSpec === 'config-json') {
        // Cursor resolves the container from its CONFIG, so it needs the
        // devcontainer.json path as well as the workspace. Both labels are
        // written side by side by the same extension, but a container built
        // some other way may carry only the first.
        const devcontainerPath = container.labels.configFileRaw;
        if (devcontainerPath === undefined || devcontainerPath.trim() === '') {
          return {
            ok: false,
            code: 'unresolved-host-path',
            message: `${target.displayName} needs the path of this container's devcontainer.json, and it carries no devcontainer.config_file label. VS Code does not need it, so opening in VS Code still works.`,
          };
        }

        uri = cursorDevContainerUri(
          {
            workspacePath: container.labels.localFolderRaw,
            devcontainerPath,
            // A workspace inside a distro needs the nested `@wsl+<distro>`
            // authority — the paths in the spec are Linux paths.
            ...(container.localFolder.kind === 'wsl'
              ? { distro: container.localFolder.distro }
              : {}),
          },
          container.workspaceFolder,
        );
      } else {
        // The RAW label, not the parsed path — see src/main/editor/uri.ts.
        uri = devContainerUri(container.labels.localFolderRaw, container.workspaceFolder);
      }

      if (uri === undefined) {
        return {
          ok: false,
          code: 'unresolved-host-path',
          message:
            'The devcontainer.local_folder label is empty, so there is no folder to reattach to.',
        };
      }

      const resolved = await resolveEditor(target);
      if (!resolved.ok) {
        return {
          ok: false,
          code: 'editor-not-found',
          message: `Could not find ${target.displayName} on this machine.`,
          uri,
        };
      }

      try {
        // Parsed rather than trusted: anything that is not the string
        // 'new-window' is the default, so a malformed message can only ever
        // ask for the less destructive of the two.
        await launchEditor(resolved.binaryPath, target, uri, parseOpenInEditorMode(rawMode));
        return { ok: true, editorId: target.id, uri };
      } catch (error) {
        return {
          ok: false,
          code: 'launch-failed',
          message: error instanceof Error ? error.message : String(error),
          uri,
        };
      }
    },
    (message) => ({ ok: false, code: 'launch-failed', message }),
  );

  // ---- Unbuilt projects ----

  handle<ProjectScan>(
    IPC.scanProjects,
    async () => {
      const scan = await scanForProjects({
        roots: context.projects.roots(),
        platform: context.projects.platform,
      });
      knownProjects.clear();
      for (const project of scan.projects) knownProjects.set(project.id, project);
      return scan;
    },
    // A failed scan reports its roots as unreadable rather than throwing, so
    // reaching here means something unexpected. An empty scan still has to be a
    // well-formed one: the renderer renders `roots` and `truncated`
    // unconditionally, and a half-built object would break the panel that is
    // supposed to explain the failure.
    () => ({ scannedAt: new Date(), roots: [], projects: [], truncated: false, elapsedMs: 0 }),
  );

  handle<OpenInEditorResult>(
    IPC.openProject,
    async (rawId, rawEditorId) => {
      const project = knownProjects.get(rawId as ProjectId);
      if (project === undefined) {
        return {
          ok: false,
          code: 'launch-failed',
          message: 'That project is no longer in the last scan. Rescan and try again.',
        };
      }

      // Unlike a built container there is no label to round-trip, so this is
      // built from the parsed path — see `folderUri` for why that is sound here
      // and emphatically not in `devContainerUri`.
      const uri = folderUri(project.folder);

      const target = editorTarget(String(rawEditorId));
      if (target === undefined) {
        return {
          ok: false,
          code: 'editor-not-found',
          message: `Unknown editor: ${String(rawEditorId)}`,
          uri,
        };
      }

      const resolved = await resolveEditor(target);
      if (!resolved.ok) {
        return {
          ok: false,
          code: 'editor-not-found',
          message: `Could not find ${target.displayName} on this machine.`,
          uri,
        };
      }

      try {
        // No mode here, and no argument for one. An unbuilt project has no
        // container and therefore no attached window to focus or duplicate —
        // the whole point of this verb is that the folder is opened LOCALLY so
        // the editor can offer "Reopen in Container".
        await launchEditor(resolved.binaryPath, target, uri);
        return { ok: true, editorId: target.id, uri };
      } catch (error) {
        return {
          ok: false,
          code: 'launch-failed',
          message: error instanceof Error ? error.message : String(error),
          uri,
        };
      }
    },
    (message) => ({ ok: false, code: 'launch-failed', message }),
  );

  handle<ProjectRootsResult>(
    IPC.addProjectRoot,
    async () => {
      const chosen = await context.projects.chooseFolder();
      if (chosen === undefined) return { ok: true, cancelled: true };
      // `roots()` is already the materialised list — defaults included — so
      // appending to it is what stops a first customisation from silently
      // replacing the defaults and losing the user every project they had.
      // The chosen path comes from the OS picker, not from the renderer.
      context.projects.setRoots([
        ...new Set([...context.projects.roots().map((root) => root.path), chosen]),
      ]);
      return { ok: true, cancelled: false };
    },
    (message) => ({ ok: false, message }),
  );

  // ---- Terminals ----

  handle<readonly TerminalOption[]>(
    IPC.listTerminals,
    async () => {
      // Platform-filtered BEFORE probing: an mdfind per Linux terminal on a Mac
      // would be a dozen processes spawned to learn nothing.
      const targets = terminalsFor(hostPlatform(process.platform));
      const resolved = await Promise.all(targets.map((target) => resolveTerminal(target)));
      return resolved.map((entry) => ({
        id: entry.target.id,
        displayName: entry.target.displayName,
        available: entry.ok,
      }));
    },
    () => [],
  );

  handle<OpenTerminalResult>(
    IPC.openTerminal,
    async (rawId, rawTerminalId) => {
      const container = known.get(rawId as ContainerId);
      if (container === undefined) {
        return {
          ok: false,
          code: 'launch-failed',
          message: 'That container is no longer in the last scan. Refresh and try again.',
        };
      }

      // `docker exec` needs a live process namespace to enter. A paused
      // container has one but it is frozen, so the exec would hang rather than
      // fail — worse than refusing.
      if (container.runtime.state !== 'running') {
        return {
          ok: false,
          code: 'not-running',
          message: `${container.name} is not running, so there is no shell to open. Start it first.`,
        };
      }

      const endpoint = context.backend.endpointFor(container.id);
      const transport = endpoint?.transport;

      // A socket inside a WSL distro is reached by running the CLI in there, so
      // what matters is which CLI that distro has — not what is on the Windows
      // PATH, which may well be nothing. `origin.runtime` is the probe's own
      // record of which engine answered on that socket.
      const cli: ContainerCli | undefined =
        transport?.transport === 'wsl'
          ? {
              kind:
                endpoint?.origin.kind === 'wsl' && endpoint.origin.runtime === 'podman'
                  ? 'podman'
                  : 'docker',
              binaryPath: '',
            }
          : await resolveContainerCli();

      if (cli === undefined) {
        return {
          ok: false,
          code: 'container-cli-not-found',
          message:
            'Neither docker nor podman is on PATH. Opening a terminal shells out to the CLI, which is a separate install from the daemon boxwarden talks to.',
        };
      }

      // The main process reads its OWN copy of the startup command, keyed off
      // its own copy of the container, and its own copy of the workspace
      // folder. The renderer never gets to say what runs, or where.
      const startupCommand = context.terminals.startupCommands()[containerSettingsKey(container)];
      const script = containerShellScript({
        // exactOptionalPropertyTypes: an absent value is an absent key.
        ...(container.workspaceFolder === undefined
          ? {}
          : { workspaceFolder: container.workspaceFolder }),
        ...(startupCommand === undefined ? {} : { startupCommand }),
      });
      const exec = containerExecArgv({
        cli,
        containerId: container.id,
        ...(transport === undefined ? {} : { transport }),
        // The main process's own copy again, like the startup command and the
        // workspace folder: the renderer never says who to become.
        ...(container.remoteUser === undefined ? {} : { user: container.remoteUser }),
        script,
      });
      // Shown to the user on failure, so they can run it themselves. Quoted
      // because that is the form they would paste into a shell.
      const command = posixQuote(exec);

      const target = terminalTarget(String(rawTerminalId));
      if (target === undefined) {
        return {
          ok: false,
          code: 'terminal-not-found',
          message: `Unknown terminal: ${String(rawTerminalId)}`,
          command,
        };
      }

      const resolved = await resolveTerminal(target);
      if (!resolved.ok) {
        return {
          ok: false,
          code: 'terminal-not-found',
          message: `Could not find ${target.displayName} on this machine.`,
          command,
        };
      }

      try {
        await launchTerminal(terminalLaunch(target, resolved.binaryPath, exec));
        return { ok: true, terminalId: target.id, command };
      } catch (error) {
        return {
          ok: false,
          code: 'launch-failed',
          message: error instanceof Error ? error.message : String(error),
          command,
        };
      }
    },
    (message) => ({ ok: false, code: 'launch-failed', message }),
  );

  handle<Readonly<Record<string, string>>>(
    IPC.getStartupCommands,
    () => Promise.resolve(context.terminals.startupCommands()),
    () => ({}),
  );

  handle<ActionResult>(
    IPC.setStartupCommand,
    (rawId, rawCommand) => {
      const container = known.get(rawId as ContainerId);
      if (container === undefined) {
        return Promise.resolve({
          ok: false,
          message: 'That container is no longer in the last scan.',
        });
      }
      // The KEY comes from the main process's own copy of the container; only
      // the command text crosses the bridge. A renderer cannot write a startup
      // command against a folder it invented.
      context.terminals.setStartupCommand(
        containerSettingsKey(container),
        typeof rawCommand === 'string' ? rawCommand : '',
      );
      return Promise.resolve({ ok: true });
    },
    (message) => ({ ok: false, message }),
  );

  handle<ProjectRootsResult>(
    IPC.removeProjectRoot,
    (raw) => {
      const path = String(raw);
      context.projects.setRoots(
        context.projects
          .roots()
          .map((root) => root.path)
          .filter((existing) => existing !== path),
      );
      return Promise.resolve({ ok: true, cancelled: false });
    },
    (message) => ({ ok: false, message }),
  );

  handle<ContainerActivityMap>(
    IPC.containerActivity,
    async (rawIds) => {
      // Ids are validated against the main process's OWN last container list,
      // for the same reason openInEditor takes an id rather than a
      // DevContainer: acting on identifiers the renderer supplied would let a
      // compromised renderer aim a Docker call at any container on the daemon,
      // dev container or not. Anything not in `known` is simply dropped.
      const requested = Array.isArray(rawIds) ? rawIds : [];
      const containers = requested
        .filter((id): id is ContainerId => typeof id === 'string')
        .map((id) => known.get(id))
        .filter((container): container is DevContainer => container !== undefined);

      const statuses: Record<ContainerId, ContainerActivity> = {};

      // A container that is not live has no process table, and asking anyway
      // would spend a Docker round trip to be told so. Its state is already in
      // hand from the last discovery, so answer it here.
      const live = containers.filter(
        (container) =>
          container.runtime.state === 'running' || container.runtime.state === 'paused',
      );
      const liveIds = new Set(live.map((container) => container.id));
      for (const container of containers) {
        if (!liveIds.has(container.id)) {
          statuses[container.id] = {
            claude: { kind: 'not-applicable' },
            editor: { kind: 'not-applicable' },
          };
        }
      }

      try {
        const found = await context.backend.containerActivity([...liveIds]);
        for (const id of liveIds) {
          const reason = 'The container engine did not answer for this container.';
          statuses[id] = found.get(id) ?? {
            claude: { kind: 'unknown', reason },
            editor: { kind: 'unknown', reason },
          };
        }
      } catch (error) {
        // The backend is not supposed to reject. If it does, every live
        // container gets "could not tell" rather than the silent "nothing
        // running" an empty map would render as — the difference matters,
        // because the Stop button reads both of these.
        const reason = error instanceof Error ? error.message : String(error);
        for (const id of liveIds) {
          statuses[id] = {
            claude: { kind: 'unknown', reason },
            editor: { kind: 'unknown', reason },
          };
        }
      }

      return statuses;
    },
    () => ({}),
  );

  // ---- Branch ----

  handle<GitStatusMap>(
    IPC.gitStatus,
    async (rawIds) => {
      // Same validation as containerActivity, and here it is load-bearing in a
      // different way: the thing being resolved from an id is a PATH ON THE
      // USER'S DISK that this process then opens. Ids not in `known` are
      // dropped, and no folder ever arrives over the bridge.
      const requested = Array.isArray(rawIds) ? rawIds : [];
      const containers = requested
        .filter((id): id is ContainerId => typeof id === 'string')
        .map((id) => known.get(id))
        .filter((container): container is DevContainer => container !== undefined);

      const platform = hostPlatform(context.git.platform);
      const statuses: Record<ContainerId, GitStatus> = {};

      // One read per FOLDER, not per container. Every service in a compose
      // project carries the same `devcontainer.local_folder`, so a five-service
      // workspace would otherwise stat the same `.git` five times a poll to
      // arrive at one answer.
      const pending = new Map<string, Promise<GitStatus>>();
      const trees = new Map<string, Promise<GitWorkingTree | undefined>>();
      const folders = new Map<ContainerId, string>();

      for (const container of containers) {
        const localFolder = container.localFolder;
        const folder =
          localFolder.kind === 'unresolved' ? undefined : readableHostFolder(localFolder, platform);
        if (folder === undefined || localFolder.kind === 'unresolved') {
          statuses[container.id] =
            localFolder.kind === 'unresolved'
              ? {
                  kind: 'unknown',
                  reason:
                    'The devcontainer.local_folder label could not be parsed, so there is no folder to read a branch from.',
                }
              : {
                  kind: 'unknown',
                  reason:
                    'That folder is on a different operating system from the one boxwarden is running on, so its checkout cannot be read from here.',
                };
          continue;
        }
        folders.set(container.id, folder);
        if (!pending.has(folder)) {
          pending.set(folder, context.git.status(folder));
          // Alongside the branch read, keyed by the same folder so a compose
          // project's five services still cost one of each. This one is cached
          // behind the seam on a clock of its own — it spawns git, where the
          // branch read opens two files.
          trees.set(
            folder,
            context.git
              .workingTree(localFolder, folder)
              // Never lets one folder's failure reach the batch: the branch is
              // the feature, and the counts are decoration on it.
              .catch(() => undefined),
          );
        }
      }

      const read = new Map(
        await Promise.all(
          [...pending].map(async ([folder, work]): Promise<readonly [string, GitStatus]> => {
            try {
              return [folder, await work];
            } catch (error) {
              // The seam is not supposed to reject. If it does, this is one
              // folder's "could not tell" rather than a failed batch — the
              // other cards' branches are still good.
              return [
                folder,
                { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) },
              ];
            }
          }),
        ),
      );

      const readTrees = new Map(
        await Promise.all(
          [...trees].map(
            async ([folder, work]): Promise<readonly [string, GitWorkingTree | undefined]> => [
              folder,
              await work,
            ],
          ),
        ),
      );

      for (const [id, folder] of folders) {
        const status = read.get(folder) ?? {
          kind: 'unknown',
          reason: 'That folder was not read this time round.',
        };

        // The counts ride along on the two arms that have a checkout to count
        // in. `none` and `unknown` get nothing: a folder that is not a
        // repository has no dirty count, and one we could not read has no
        // answer — putting a `0` on either would be inventing one.
        const extra = readTrees.get(folder);
        statuses[id] =
          extra === undefined || (status.kind !== 'branch' && status.kind !== 'detached')
            ? status
            : status.kind === 'branch'
              ? {
                  ...status,
                  tree: extra.tree,
                  ...(extra.tracking === undefined ? {} : { tracking: extra.tracking }),
                }
              : { ...status, tree: extra.tree };
      }

      return statuses;
    },
    () => ({}),
  );

  /**
   * A container id to a folder on THIS machine, or the sentence saying why not.
   *
   * The same resolution the batch above does per container, factored out
   * because the two branch verbs need it one at a time — and because it is the
   * single place where an id becomes a path this process reads and writes. A
   * folder never arrives over the bridge; it is always looked up here, from the
   * main process's own last scan.
   */
  function workspaceFolder(
    rawId: unknown,
  ):
    | { readonly ok: true; readonly folder: HostPath }
    | { readonly ok: false; readonly message: string } {
    const container = typeof rawId === 'string' ? known.get(rawId as ContainerId) : undefined;
    if (container === undefined) {
      return {
        ok: false,
        message: 'That container was not in the last scan, so its workspace folder is not known.',
      };
    }

    // `readableHostFolder` is the GATE here, not the answer. What it decides is
    // whether this folder belongs to the machine boxwarden is running on — the
    // check that keeps a Windows label from being read off a Linux root. What
    // it RETURNS is the spelling for opening a file, and running git is a
    // different question, so the structured path travels on and
    // `gitInvocation` decides how to address it. Flattening to the string here
    // is precisely the bug that makes Windows git refuse a WSL workspace.
    const readable = readableHostFolder(container.localFolder, hostPlatform(context.git.platform));
    const folder = container.localFolder;
    if (readable === undefined || folder.kind === 'unresolved') {
      return {
        ok: false,
        message:
          folder.kind === 'unresolved'
            ? 'The devcontainer.local_folder label could not be parsed, so there is no folder to switch a branch in.'
            : 'That folder is on a different operating system from the one boxwarden is running on, so its checkout cannot be changed from here.',
      };
    }

    return { ok: true, folder };
  }

  handle<BranchListing>(
    IPC.listBranches,
    async (rawId) => {
      const resolved = workspaceFolder(rawId);
      return resolved.ok
        ? await context.git.branches(resolved.folder)
        : { kind: 'unavailable', reason: resolved.message };
    },
    (reason) => ({ kind: 'unavailable', reason }),
  );

  handle<ActionResult>(
    IPC.switchBranch,
    async (rawId, rawBranch) => {
      const resolved = workspaceFolder(rawId);
      if (!resolved.ok) return { ok: false, message: resolved.message };

      // Type only. Whether this string is ALLOWED is not decided here and
      // cannot be: `switchBranch` re-lists the branches itself and refuses
      // anything git did not just print. Checking a shape here and trusting it
      // downstream is the pattern that rule exists to avoid.
      if (typeof rawBranch !== 'string' || rawBranch === '') {
        return { ok: false, message: 'No branch was named.' };
      }

      return await context.git.switchBranch(resolved.folder, rawBranch);
    },
    (message) => ({ ok: false, message }),
  );

  // ---- Self-update ----

  /**
   * Every one of the three answers with a whole `UpdateStatus`, including the
   * failure path: a status that named no version would blank the footer, which
   * is the only place the app says which boxwarden this is.
   */
  const updateFailure = (message: string): UpdateStatus => ({
    currentVersion: context.updates.currentVersion,
    outcome: { kind: 'failed', message },
  });

  handle<UpdateStatus>(
    IPC.updateStatus,
    // The single boolean the renderer supplies in this feature. It skips a
    // timestamp comparison on a URL that is a constant in the models layer —
    // it cannot name a host, and it cannot re-enable a check the user turned
    // off.
    (force) => context.updates.status(force === true),
    updateFailure,
  );

  handle<UpdateStatus>(
    IPC.dismissUpdate,
    // No argument: which version was dismissed is the main process's own last
    // answer, not something the renderer gets to name.
    () => context.updates.dismiss(),
    updateFailure,
  );

  handle<UpdateStatus>(
    IPC.setUpdateChecks,
    (enabled) => context.updates.setEnabled(enabled === true),
    updateFailure,
  );
}
