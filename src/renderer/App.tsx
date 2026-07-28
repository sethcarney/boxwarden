import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContainerId, DevContainer, EditorId } from '../domain/index.js';
import type { DiscoverySnapshot, EditorOption } from '../shared/ipc.js';
import { getApi } from './api.js';
import { relativeTime } from './format.js';
import { ContainerCard } from './components/ContainerCard.js';
import { DockerUnavailable } from './components/DockerUnavailable.js';

const REFRESH_INTERVAL_MS = 5_000;
const CLOCK_INTERVAL_MS = 1_000;

interface Notice {
  readonly tone: 'error' | 'info';
  readonly message: string;
}

export function App() {
  const api = useMemo(getApi, []);

  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | undefined>(undefined);
  const [editors, setEditors] = useState<readonly EditorOption[]>([]);
  const [editorId, setEditorId] = useState<EditorId>('vscode');
  const [busy, setBusy] = useState<readonly ContainerId[]>([]);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  /**
   * Guards the poll against overlapping with itself or with an in-flight
   * action. Without it, a slow `docker ps` on a loaded machine queues refreshes
   * faster than they complete, and a stop lands on top of a refresh that then
   * overwrites the row with pre-stop state.
   */
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (api === undefined || inFlight.current) return;
    inFlight.current = true;
    try {
      setSnapshot(await api.discover());
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // One clock for the whole list, so the relative timestamps tick together.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (api === undefined) return;
    void api.listEditors().then((found) => {
      setEditors(found);
      // Default to the first editor actually installed rather than to VS Code
      // unconditionally — on a machine with only Cursor, defaulting to VS Code
      // means every card opens with its primary action disabled.
      const firstAvailable = found.find((editor) => editor.available);
      if (firstAvailable !== undefined) setEditorId(firstAvailable.id);
    });
  }, [api]);

  const withBusy = useCallback(
    async (container: DevContainer, action: () => Promise<{ ok: boolean; message?: string }>) => {
      setBusy((current) => [...current, container.id]);
      inFlight.current = true;
      try {
        const result = await action();
        if (!result.ok) {
          setNotice({ tone: 'error', message: result.message ?? 'The action failed.' });
        }
      } catch (error) {
        setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy((current) => current.filter((id) => id !== container.id));
        inFlight.current = false;
        // Re-read rather than patching the row optimistically: Docker is the
        // source of truth, and a container that failed to start for its own
        // reasons should show that, not the state we hoped for.
        await refresh();
      }
    },
    [refresh],
  );

  const onStart = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy(container, () => api.start(container.id));
    },
    [api, withBusy],
  );

  const onStop = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy(container, () => api.stop(container.id));
    },
    [api, withBusy],
  );

  const onOpen = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy(container, async () => {
        const result = await api.openInEditor(container.id, editorId);
        if (result.ok) {
          setNotice({ tone: 'info', message: `Opening ${container.name}…` });
          return { ok: true };
        }
        return { ok: false, message: result.message };
      });
    },
    [api, editorId, withBusy],
  );

  if (api === undefined) {
    return (
      <main className="app">
        <section className="panel panel-error">
          <h2>The preload bridge did not load</h2>
          <p className="lede">
            <code>window.boxwarden</code> is undefined, so the UI has no way to reach Docker. This
            is a build problem, not a Docker problem — the preload script failed to load.
          </p>
          <p className="note">
            The usual cause is a preload built as ESM while the window has <code>sandbox: true</code>,
            which requires CommonJS. See the notes in <code>electron.vite.config.ts</code>.
          </p>
        </section>
      </main>
    );
  }

  const selectedEditor = editors.find((editor) => editor.id === editorId);
  const containers = snapshot?.containers ?? [];
  const dockerOk = snapshot?.environment.api.ok ?? false;

  return (
    <main className="app">
      <header className="app-head">
        <h1>boxwarden</h1>
        <div className="head-right">
          {snapshot !== undefined && (
            <span className={`chip ${dockerOk ? 'chip-ok' : 'chip-fail'}`}>
              {snapshot.environment.api.ok
                ? `Docker ${snapshot.environment.api.serverVersion}`
                : 'Docker unreachable'}
            </span>
          )}
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {notice !== undefined && (
        <div className={`notice notice-${notice.tone}`} role="status">
          <span>{notice.message}</span>
          <button type="button" className="link" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      {snapshot === undefined && <p className="empty">Looking for Docker…</p>}

      {snapshot !== undefined && !dockerOk && <DockerUnavailable environment={snapshot.environment} />}

      {snapshot !== undefined && dockerOk && containers.length === 0 && (
        <section className="panel">
          <h2>No dev containers found</h2>
          <p className="lede">
            Docker is reachable, but nothing on it carries the{' '}
            <code>devcontainer.local_folder</code> label.
          </p>
          <p className="note">
            boxwarden only lists containers created by the Dev Containers extension or the
            <code> devcontainer </code> CLI. Ordinary containers are deliberately not shown.
          </p>
        </section>
      )}

      {containers.length > 0 && (
        <div className="list">
          {containers.map((container) => (
            <ContainerCard
              key={container.id}
              container={container}
              editorId={editorId}
              editorName={selectedEditor?.displayName ?? 'VS Code'}
              editorAvailable={selectedEditor?.available ?? false}
              busy={busy.includes(container.id)}
              now={now}
              onStart={onStart}
              onStop={onStop}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}

      <footer className="app-foot">
        <span>
          {containers.length} dev container{containers.length === 1 ? '' : 's'}
          {snapshot !== undefined && ` · scanned ${relativeTime(snapshot.scannedAt, now)}`}
        </span>

        <label className="editor-picker">
          Open in
          <select value={editorId} onChange={(event) => setEditorId(event.target.value)}>
            {editors.map((editor) => (
              <option key={editor.id} value={editor.id}>
                {editor.displayName}
                {editor.available ? '' : ' (not found)'}
              </option>
            ))}
          </select>
        </label>
      </footer>
    </main>
  );
}
