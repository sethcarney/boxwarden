import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContainerId, DevContainer, EditorId } from '../domain/index.js';
import type { DiscoverySnapshot, EditorOption } from '../shared/ipc.js';
import { getApi } from './api.js';
import { canStart, canStop, describeTarget, relativeTime, runtimeLabel } from './format.js';
import { groupContainers } from './grouping.js';
import { ContainerCard } from './components/ContainerCard.js';
import { ComposeGroup } from './components/ComposeGroup.js';
import { DockerUnavailable } from './components/DockerUnavailable.js';

const REFRESH_INTERVAL_MS = 5_000;
const CLOCK_INTERVAL_MS = 1_000;

interface Notice {
  readonly tone: 'error' | 'info';
  readonly message: string;
}

export function App() {
  const api = useMemo(() => getApi(), []);

  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | undefined>(undefined);
  const [editors, setEditors] = useState<readonly EditorOption[]>([]);
  const [editorId, setEditorId] = useState<EditorId>('vscode');
  const [busy, setBusy] = useState<readonly ContainerId[]>([]);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  /**
   * The URI of the last failed open, offered as a copyable fallback.
   *
   * `OpenInEditorResult` carries `uri` on its failure arm for exactly this: if
   * we could build a valid URI but could not launch the editor, the user can
   * still paste it into a browser or a shell and get where they were going.
   * Throwing that away and showing only "could not find VS Code" would be
   * withholding the one thing that still works.
   */
  const [lastFailedUri, setLastFailedUri] = useState<string | undefined>(undefined);

  /**
   * Guards the poll against overlapping with itself or with an in-flight
   * action. Without it, a slow `docker ps` on a loaded machine queues refreshes
   * faster than they complete, and a stop lands on top of a refresh that then
   * overwrites the row with pre-stop state.
   */
  const inFlight = useRef(false);

  /**
   * False once the component is gone. A discover() started before unmount
   * still resolves afterwards, and setting state on the result would be a
   * leak — the poll runs every 5s, so this is not a theoretical window.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (api === undefined || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.discover();
      if (mounted.current) setSnapshot(next);
    } catch (error) {
      if (mounted.current) {
        setNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  useEffect(() => {
    // Poll, and take one reading immediately so the first paint is not an
    // empty list for five seconds.
    //
    // react-hooks/set-state-in-effect is suppressed rather than worked around:
    // it fires because `refresh` transitively calls setState, but every one of
    // those calls happens after `await api.discover()`, so none is the
    // synchronous cascading render the rule exists to prevent. Restructuring
    // to satisfy it would mean either dropping the initial reading or
    // duplicating refresh's body inside the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
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

  /**
   * Marks every container the action touches as busy, runs it, then re-reads.
   *
   * Takes a LIST rather than one container so a compose group's "Stop all"
   * disables the whole group's controls, not just the row that was clicked —
   * otherwise the siblings look actionable while they are mid-stop.
   */
  const withBusy = useCallback(
    async (
      targets: readonly DevContainer[],
      action: () => Promise<{ ok: boolean; message?: string }>,
    ) => {
      const ids = targets.map((target) => target.id);
      setBusy((current) => [...current, ...ids]);
      inFlight.current = true;
      try {
        const result = await action();
        if (!result.ok) {
          setNotice({ tone: 'error', message: result.message ?? 'The action failed.' });
        }
      } catch (error) {
        setNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy((current) => current.filter((id) => !ids.includes(id)));
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
      void withBusy([container], () => api.start(container.id));
    },
    [api, withBusy],
  );

  const onStop = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], () => api.stop(container.id));
    },
    [api, withBusy],
  );

  /**
   * Group actions loop over the existing single-container IPC calls rather
   * than adding a `startMany` channel. Two reasons: the IPC surface stays five
   * narrow verbs (see the preload's note on not offering a generic invoke),
   * and a compose project is a handful of containers, so the round trips do
   * not matter.
   *
   * `allSettled`, not `all` — one service failing to start should not abandon
   * its siblings half-started. The failures are collected and reported
   * together.
   */
  const runOnAll = useCallback(
    (containers: readonly DevContainer[], verb: 'start' | 'stop') => {
      if (api === undefined) return;
      const eligible = containers.filter((container) =>
        verb === 'start' ? canStart(container.runtime) : canStop(container.runtime),
      );
      if (eligible.length === 0) return;

      void withBusy(eligible, async () => {
        const results = await Promise.allSettled(
          eligible.map((container) =>
            verb === 'start' ? api.start(container.id) : api.stop(container.id),
          ),
        );

        const failures = results.flatMap((result, index) => {
          const name = eligible[index]?.name ?? 'a container';
          if (result.status === 'rejected') {
            return [`${name}: ${String(result.reason)}`];
          }
          return result.value.ok ? [] : [`${name}: ${result.value.message}`];
        });

        return failures.length === 0
          ? { ok: true }
          : {
              ok: false,
              message: `Could not ${verb} ${failures.length} of ${eligible.length}: ${failures.join('; ')}`,
            };
      });
    },
    [api, withBusy],
  );

  const onStartAll = useCallback(
    (containers: readonly DevContainer[]) => {
      runOnAll(containers, 'start');
    },
    [runOnAll],
  );

  const onStopAll = useCallback(
    (containers: readonly DevContainer[]) => {
      runOnAll(containers, 'stop');
    },
    [runOnAll],
  );

  const onOpen = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], async () => {
        const result = await api.openInEditor(container.id, editorId);
        if (result.ok) {
          setNotice({ tone: 'info', message: `Opening ${container.name}…` });
          return { ok: true };
        }
        setLastFailedUri(result.uri);
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
            The usual cause is a preload built as ESM while the window has{' '}
            <code>sandbox: true</code>, which requires CommonJS. See the notes in{' '}
            <code>electron.vite.config.ts</code>.
          </p>
        </section>
      </main>
    );
  }

  const selectedEditor = editors.find((editor) => editor.id === editorId);
  const containers = snapshot?.containers ?? [];
  const groups = groupContainers(containers);
  const dockerOk = snapshot?.environment.api.ok ?? false;

  // More than one engine can answer at once — a podman machine behind a named
  // pipe plus a rootless podman inside a WSL distro is an ordinary Windows
  // setup. The chip names the primary and counts the rest, so a user seeing
  // containers from somewhere unexpected can tell that is what happened.
  const connected = (snapshot?.environment.attempts ?? []).filter((attempt) => attempt.ok);
  const engineCount = connected.length;
  const engineTitle = connected
    .map(
      (attempt) =>
        `${runtimeLabel(attempt.runtime)} ${attempt.serverVersion} — ${describeTarget(attempt.endpoint.transport)}`,
    )
    .join('\n');

  return (
    <main className="app">
      <header className="app-head">
        <h1>boxwarden</h1>
        <div className="head-right">
          {snapshot !== undefined && (
            <span className={`chip ${dockerOk ? 'chip-ok' : 'chip-fail'}`} title={engineTitle}>
              {snapshot.environment.api.ok
                ? `${runtimeLabel(snapshot.environment.api.runtime)} ${snapshot.environment.api.serverVersion}${
                    engineCount > 1 ? ` +${String(engineCount - 1)}` : ''
                  }`
                : 'No container engine'}
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
          <span className="notice-actions">
            {lastFailedUri !== undefined && notice.tone === 'error' && (
              <button
                type="button"
                className="link"
                title={lastFailedUri}
                onClick={() => {
                  void navigator.clipboard.writeText(lastFailedUri).then(
                    () => {
                      setNotice({
                        tone: 'info',
                        message: 'Copied the editor URI to the clipboard.',
                      });
                      setLastFailedUri(undefined);
                    },
                    () => {
                      setNotice({ tone: 'error', message: 'Could not write to the clipboard.' });
                    },
                  );
                }}
              >
                Copy URI
              </button>
            )}
            <button
              type="button"
              className="link"
              onClick={() => {
                setNotice(undefined);
                setLastFailedUri(undefined);
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {snapshot === undefined && <p className="empty">Looking for Docker…</p>}

      {snapshot !== undefined && !dockerOk && (
        <DockerUnavailable environment={snapshot.environment} />
      )}

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
          {groups.map((group) => {
            const card = (container: DevContainer) => (
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
            );

            if (group.kind === 'single') return card(group.container);

            return (
              <ComposeGroup
                key={group.key}
                project={group.project}
                containers={group.containers}
                busy={group.containers.some((c) => busy.includes(c.id))}
                onStartAll={onStartAll}
                onStopAll={onStopAll}
              >
                {group.containers.map(card)}
              </ComposeGroup>
            );
          })}
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
