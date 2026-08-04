import type { Mock } from 'vitest';
import { vi } from 'vitest';
import type {
  ClaudeStatus,
  ContainerId,
  EditorId,
  EngineSelection,
  ProjectId,
  ProjectScan,
  TerminalId,
} from '../../models/index.js';
import type {
  ActionResult,
  BoxwardenApi,
  ClaudeStatusMap,
  DiscoverySnapshot,
  EditorOption,
  OpenInEditorResult,
  OpenTerminalResult,
  ProjectRootsResult,
  TerminalOption,
} from '../../shared/ipc.js';

/**
 * A fake bridge for the ViewModel tests.
 *
 * The point of the ViewModel layer is that it can be driven without Electron,
 * without a Docker daemon and without rendering anything, so the tests below it
 * need exactly one seam: an object shaped like `BoxwardenApi`. Every method is
 * a `vi.fn`, so a test can assert what was called as well as what came back.
 */

const UNIX_ENDPOINT = {
  transport: { transport: 'unix', socketPath: '/var/run/docker.sock' },
  origin: { kind: 'well-known', runtime: 'docker-engine' },
} as const;

export function snapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  const api = {
    ok: true,
    endpoint: UNIX_ENDPOINT,
    serverVersion: '27.1.1',
    apiVersion: '1.46',
    runtime: 'docker-engine',
  } as const;

  return {
    scannedAt: new Date('2026-08-01T12:00:00Z'),
    environment: {
      wsl: { kind: 'not-applicable' },
      api,
      cli: { ok: true, binaryPath: '/usr/bin/docker', version: '27.1.1' },
      attempts: [api],
    },
    containers: [],
    engines: [],
    selection: { kind: 'all' },
    advice: [],
    ...overrides,
  };
}

/** A snapshot where nothing answered — the error screen's input. */
export function unreachableSnapshot(): DiscoverySnapshot {
  const failed = {
    ok: false,
    endpoint: UNIX_ENDPOINT,
    failure: { code: 'connection-refused' },
  } as const;

  return snapshot({
    environment: {
      wsl: { kind: 'not-applicable' },
      api: failed,
      cli: { ok: false, code: 'not-on-path' },
      attempts: [failed],
    },
  });
}

export function projectScan(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    scannedAt: new Date('2026-08-01T12:00:00Z'),
    roots: [{ path: '/home/dev', source: 'default', found: 0 }],
    projects: [],
    truncated: false,
    elapsedMs: 40,
    ...overrides,
  };
}

export interface FakeApi extends BoxwardenApi {
  readonly discover: Mock<() => Promise<DiscoverySnapshot>>;
  readonly start: Mock<(id: ContainerId) => Promise<ActionResult>>;
  readonly stop: Mock<(id: ContainerId) => Promise<ActionResult>>;
  readonly listEditors: Mock<() => Promise<readonly EditorOption[]>>;
  openInEditor: Mock<(id: ContainerId, editorId: EditorId) => Promise<OpenInEditorResult>>;
  readonly selectEngine: Mock<(selection: EngineSelection) => Promise<ActionResult>>;
  readonly scanProjects: Mock<() => Promise<ProjectScan>>;
  openProject: Mock<(id: ProjectId, editorId: EditorId) => Promise<OpenInEditorResult>>;
  readonly addProjectRoot: Mock<() => Promise<ProjectRootsResult>>;
  readonly removeProjectRoot: Mock<(root: string) => Promise<ProjectRootsResult>>;
  readonly listTerminals: Mock<() => Promise<readonly TerminalOption[]>>;
  openTerminal: Mock<(id: ContainerId, terminalId: TerminalId) => Promise<OpenTerminalResult>>;
  readonly getStartupCommands: Mock<() => Promise<Readonly<Record<string, string>>>>;
  setStartupCommand: Mock<(id: ContainerId, command: string) => Promise<ActionResult>>;
  readonly claudeStatus: Mock<(ids: readonly ContainerId[]) => Promise<ClaudeStatusMap>>;
}

export interface FakeApiOptions {
  readonly snapshot?: DiscoverySnapshot;
  readonly editors?: readonly EditorOption[];
  readonly scan?: ProjectScan;
  readonly terminals?: readonly TerminalOption[];
  readonly startupCommands?: Readonly<Record<string, string>>;
  /**
   * What `claudeStatus` answers for every id it is asked about. A single value
   * rather than a map because the tests care about the arm, not about which
   * container carries it — and a map would have to be kept in step with
   * whichever fixture ids the test happened to use.
   */
  readonly claude?: ClaudeStatus;
}

export function fakeApi(options: FakeApiOptions = {}): FakeApi {
  const current = options.snapshot ?? snapshot();
  const editors = options.editors ?? [{ id: 'vscode', displayName: 'VS Code', available: true }];
  const scan = options.scan ?? projectScan();
  const terminals = options.terminals ?? [
    { id: 'gnome-terminal', displayName: 'GNOME Terminal', available: true },
  ];
  const startupCommands = options.startupCommands ?? {};
  const claude = options.claude ?? { kind: 'none' };

  return {
    discover: vi.fn<() => Promise<DiscoverySnapshot>>(() => Promise.resolve(current)),
    start: vi.fn<(id: ContainerId) => Promise<ActionResult>>(() => Promise.resolve({ ok: true })),
    stop: vi.fn<(id: ContainerId) => Promise<ActionResult>>(() => Promise.resolve({ ok: true })),
    listEditors: vi.fn<() => Promise<readonly EditorOption[]>>(() => Promise.resolve(editors)),
    openInEditor: vi.fn<(id: ContainerId, editorId: EditorId) => Promise<OpenInEditorResult>>(() =>
      Promise.resolve({ ok: true, editorId: 'vscode', uri: 'vscode-remote://x' }),
    ),
    selectEngine: vi.fn<(selection: EngineSelection) => Promise<ActionResult>>(() =>
      Promise.resolve({ ok: true }),
    ),
    scanProjects: vi.fn<() => Promise<ProjectScan>>(() => Promise.resolve(scan)),
    openProject: vi.fn<(id: ProjectId, editorId: EditorId) => Promise<OpenInEditorResult>>(() =>
      Promise.resolve({ ok: true, editorId: 'vscode', uri: 'file:///x' }),
    ),
    addProjectRoot: vi.fn<() => Promise<ProjectRootsResult>>(() =>
      Promise.resolve({ ok: true, cancelled: false }),
    ),
    removeProjectRoot: vi.fn<(root: string) => Promise<ProjectRootsResult>>(() =>
      Promise.resolve({ ok: true, cancelled: false }),
    ),
    listTerminals: vi.fn<() => Promise<readonly TerminalOption[]>>(() =>
      Promise.resolve(terminals),
    ),
    openTerminal: vi.fn<(id: ContainerId, terminalId: TerminalId) => Promise<OpenTerminalResult>>(
      () => Promise.resolve({ ok: true, terminalId: 'gnome-terminal', command: "'docker' 'exec'" }),
    ),
    getStartupCommands: vi.fn<() => Promise<Readonly<Record<string, string>>>>(() =>
      Promise.resolve(startupCommands),
    ),
    setStartupCommand: vi.fn<(id: ContainerId, command: string) => Promise<ActionResult>>(() =>
      Promise.resolve({ ok: true }),
    ),
    claudeStatus: vi.fn<(ids: readonly ContainerId[]) => Promise<ClaudeStatusMap>>((ids) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, claude]))),
    ),
  };
}
