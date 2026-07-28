import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { ContainerId, DevContainer } from '../domain/index.js';
import { IPC } from '../shared/ipc.js';
import type {
  ActionResult,
  DiscoverySnapshot,
  EditorOption,
  OpenInEditorResult,
} from '../shared/ipc.js';
import type { DockerBackend } from './docker/backend.js';
import { EDITOR_TARGETS, editorTarget } from './editor/targets.js';
import { resolveEditor } from './editor/resolve.js';
import { launchEditor } from './editor/launch.js';
import { devContainerUri } from './editor/uri.js';

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

  ipcMain.handle(IPC.discover, async (event): Promise<DiscoverySnapshot> => {
    const scannedAt = new Date();
    if (!context.isTrustedSender(event.sender)) {
      return { scannedAt, environment: await context.backend.probe(), containers: [] };
    }

    const environment = await context.backend.probe();
    if (!environment.api.ok) {
      known.clear();
      return { scannedAt, environment, containers: [] };
    }

    try {
      const containers = await context.backend.listDevContainers();
      known.clear();
      for (const container of containers) known.set(container.id, container);
      return { scannedAt, environment, containers };
    } catch (error) {
      // Reached the daemon, then failed to list. Surface it as an endpoint
      // failure rather than an empty list, which would read as "no dev
      // containers" and send the user looking in the wrong place.
      return {
        scannedAt,
        environment: {
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
        containers: [],
      };
    }
  });

  handle<ActionResult>(
    IPC.start,
    async (id) => {
      await context.backend.start(id as ContainerId);
      return { ok: true };
    },
    (message) => ({ ok: false, message }),
  );

  handle<ActionResult>(
    IPC.stop,
    async (id) => {
      await context.backend.stop(id as ContainerId);
      return { ok: true };
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
      }));
    },
    () => [],
  );

  handle<OpenInEditorResult>(
    IPC.openInEditor,
    async (rawId, rawEditorId) => {
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

      // The RAW label, not the parsed path — see src/main/editor/uri.ts.
      const uri = devContainerUri(container.labels.localFolderRaw, container.workspaceFolder);
      if (uri === undefined) {
        return {
          ok: false,
          code: 'unresolved-host-path',
          message:
            'The devcontainer.local_folder label is empty, so there is no folder to reattach to.',
        };
      }

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
}
