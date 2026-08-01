import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ContainerId,
  DevContainer,
  DevContainerProject,
  EditorId,
  EngineSelection,
  ProjectScan,
} from '../models/index.js';
import type { DiscoverySnapshot, EditorOption } from '../shared/ipc.js';
import { getApi } from './api.js';
import { canStart, canStop, describeTarget, relativeTime, runtimeLabel } from './format.js';
import { groupContainers } from './grouping.js';
import { Advisories } from './components/Advisories.js';
import { ContainerCard } from './components/ContainerCard.js';
import { ComposeGroup } from './components/ComposeGroup.js';
import { DockerUnavailable } from './components/DockerUnavailable.js';
import { EnginePicker } from './components/EnginePicker.js';
import { UnbuiltProjects } from './components/UnbuiltProjects.js';
import { ViewPicker } from './components/ViewPicker.js';
import type { ViewPreferences } from './view.js';
import { loadView, resolveTheme, saveView } from './view.js';

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
   * Layout and theme. Read from localStorage during the first render — not in
   * an effect — so the window paints in the chosen layout instead of showing
   * the default for a frame and then reflowing.
   */
  const [view, setView] = useState<ViewPreferences>(loadView);
  const onChangeView = useCallback((next: ViewPreferences) => {
    setView(next);
    saveView(next);
  }, []);

  /**
   * The filesystem scan, on its own cadence.
   *
   * Deliberately NOT part of `snapshot`. That one is polled every five seconds
   * because a container's state changes without anyone asking; a
   * `devcontainer.json` appears when someone clones a repo, which is not
   * something worth walking a home directory sixty times an hour to notice. So
   * this runs once on open and whenever the user asks.
   */
  const [scan, setScan] = useState<ProjectScan | undefined>(undefined);
  const [scanning, setScanning] = useState(false);

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

  /**
   * `auto` is resolved here rather than with a `prefers-color-scheme` block in
   * the stylesheet, so the light palette is written once and the root attribute
   * always names a concrete theme. The listener matters on a desktop app: the
   * window outlives the OS switching to its evening theme.
   */
  const [prefersLight, setPrefersLight] = useState(
    () => window.matchMedia('(prefers-color-scheme: light)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onPreferenceChange = (event: MediaQueryListEvent) => {
      setPrefersLight(event.matches);
    };
    query.addEventListener('change', onPreferenceChange);
    return () => {
      query.removeEventListener('change', onPreferenceChange);
    };
  }, []);

  // Layout, not passive: `useEffect` would run after the first paint, so a
  // light-theme user would see one frame of the dark palette on every launch.
  useLayoutEffect(() => {
    // On <html>, not on the app element: the page background and the native
    // scrollbars (`color-scheme`) are inherited from the root.
    document.documentElement.setAttribute('data-theme', resolveTheme(view.theme, prefersLight));
  }, [view.theme, prefersLight]);

  const rescan = useCallback(async () => {
    if (api === undefined) return;
    setScanning(true);
    try {
      const next = await api.scanProjects();
      if (mounted.current) setScan(next);
    } catch (error) {
      if (mounted.current) {
        setNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, [api]);

  useEffect(() => {
    // One scan on open, and never on a timer. See the note on `scan`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void rescan();
  }, [rescan]);

  /**
   * Add or remove a scan root, then re-read.
   *
   * The main process answers with ok/cancelled and not with the new root list:
   * a changed root list invalidates the projects too, so the rescan has to
   * happen regardless and returning the roots would only be a second source of
   * truth to keep in step.
   */
  const changeRoots = useCallback(
    (change: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>) => {
      void change().then(
        (result) => {
          if (!result.ok) {
            setNotice({
              tone: 'error',
              message: result.message ?? 'Could not change the folders.',
            });
            return;
          }
          if (result.cancelled === true) return;
          void rescan();
        },
        (error: unknown) => {
          setNotice({
            tone: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    [rescan],
  );

  const onAddRoot = useCallback(() => {
    if (api === undefined) return;
    changeRoots(() => api.addProjectRoot());
  }, [api, changeRoots]);

  const onRemoveRoot = useCallback(
    (root: string) => {
      if (api === undefined) return;
      changeRoots(() => api.removeProjectRoot(root));
    },
    [api, changeRoots],
  );

  const onOpenProject = useCallback(
    (project: DevContainerProject) => {
      if (api === undefined) return;
      void api.openProject(project.id, editorId).then(
        (result) => {
          if (result.ok) {
            setNotice({
              tone: 'info',
              // Naming the next step matters: the folder opening locally looks
              // like the wrong thing happened unless the user knows the
              // container comes from the editor's own prompt.
              message: `Opening ${project.name} — your editor will offer to reopen it in a container.`,
            });
            return;
          }
          setLastFailedUri(result.uri);
          setNotice({ tone: 'error', message: result.message });
        },
        (error: unknown) => {
          setNotice({
            tone: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    [api, editorId],
  );

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

  /**
   * Switching engines re-reads immediately rather than waiting for the poll.
   *
   * The whole list is about to change, and up to five seconds of showing
   * containers from the engine the user just switched away from would read as
   * the setting having failed.
   */
  const onSelectEngine = useCallback(
    (selection: EngineSelection) => {
      if (api === undefined) return;
      // Painted optimistically so the <select> responds to the click. The next
      // snapshot carries the authoritative value from the main process, which
      // is the one that decides what the list actually contains.
      setSnapshot((current) => (current === undefined ? current : { ...current, selection }));
      void api.selectEngine(selection).then(
        (result) => {
          if (!result.ok) setNotice({ tone: 'error', message: result.message });
          void refresh();
        },
        (error: unknown) => {
          setNotice({
            tone: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    [api, refresh],
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
            <EnginePicker
              engines={snapshot.engines}
              selection={snapshot.selection}
              disabled={busy.length > 0}
              onChange={onSelectEngine}
            />
          )}
          {snapshot !== undefined && (
            <span className={`chip ${dockerOk ? 'chip-ok' : 'chip-fail'}`} title={engineTitle}>
              {snapshot.environment.api.ok
                ? `${runtimeLabel(snapshot.environment.api.runtime)} ${snapshot.environment.api.serverVersion}${
                    // The "+n" counts the OTHER engines being unioned in, so it
                    // is only true while the selection is "all". Narrowed to
                    // one engine, the chip names exactly what is in the list.
                    snapshot.selection.kind === 'all' && engineCount > 1
                      ? ` +${String(engineCount - 1)}`
                      : ''
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

      {/*
       * One scroller for everything between the header and the footer.
       *
       * The list used to be the flex child that grew, which pinned the
       * "Not built yet" panel to the bottom edge and opened a lake of empty
       * space between them on any window taller than three cards. Everything
       * scrolls together now, and the panel sits directly under the last card.
       */}
      <div className="content">
        {snapshot === undefined && <p className="empty">Looking for a container engine…</p>}

        {/*
         * Above the diagnostics and above the list, and shown even when
         * everything is working. Most of these advisories are about containers
         * the user CANNOT see — a WSL distro with no relay into it produces a
         * list that looks complete and is not — so hiding them behind a failure
         * state would hide them exactly when they matter.
         */}
        {snapshot !== undefined && <Advisories advice={snapshot.advice} />}

        {snapshot !== undefined && !dockerOk && (
          <DockerUnavailable environment={snapshot.environment} />
        )}

        {snapshot !== undefined && dockerOk && containers.length === 0 && (
          <section className="panel">
            <h2>No dev containers found</h2>
            <p className="lede">
              {snapshot.selection.kind === 'all'
                ? `${engineCount === 1 ? 'A container engine is' : `${String(engineCount)} container engines are`} reachable, but nothing on ${engineCount === 1 ? 'it' : 'them'} carries the devcontainer.local_folder label.`
                : 'The engine you selected is reachable, but nothing on it carries the devcontainer.local_folder label. Other engines may have containers — switch to “All engines” to check.'}
            </p>
            <p className="note">
              boxwarden only lists containers created by the Dev Containers extension or the
              <code> devcontainer </code> CLI. Ordinary containers are deliberately not shown.
            </p>
          </section>
        )}

        {containers.length > 0 && (
          /*
           * The layout is an attribute rather than three sets of components:
           * grid, list and rows are the same cards under different column
           * rules, and forking the markup would mean three places to fix every
           * time a card gains a field.
           */
          <div className="list" data-layout={view.layout}>
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
                  // Rows mode is one line per container, and "Open in VS Code
                  // Insiders" does not fit on it. The full label stays as the
                  // button's title.
                  dense={view.layout === 'rows'}
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

        {/*
         * Below the built containers, because a container you can open right
         * now outranks a folder you would have to build first — but on the same
         * screen, since the whole point is that "no dev containers found" is
         * not the end of the story.
         */}
        <UnbuiltProjects
          scan={scan}
          containers={containers}
          editorName={selectedEditor?.displayName ?? 'VS Code'}
          editorAvailable={selectedEditor?.available ?? false}
          scanning={scanning}
          now={now}
          onOpen={onOpenProject}
          onRescan={() => void rescan()}
          onAddRoot={onAddRoot}
          onRemoveRoot={onRemoveRoot}
        />
      </div>

      <footer className="app-foot">
        <span>
          {containers.length} dev container{containers.length === 1 ? '' : 's'}
          {snapshot !== undefined && ` · scanned ${relativeTime(snapshot.scannedAt, now)}`}
        </span>

        <div className="foot-right">
          <ViewPicker view={view} onChange={onChangeView} />

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
        </div>
      </footer>
    </main>
  );
}
