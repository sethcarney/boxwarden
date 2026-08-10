import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContainerId,
  DevContainer,
  EditorId,
  EngineSelection,
  OpenInEditorMode,
  TerminalId,
} from '../../models/index.js';
import type {
  ActionResult,
  BoxwardenApi,
  DiscoverySnapshot,
  StopResult,
} from '../../shared/ipc.js';
import { canStart, canStop } from '../format.js';
import type { ContainerGroup } from '../grouping.js';
import { groupContainers } from '../grouping.js';
import type { EngineChip } from '../presenters.js';
import {
  emptyListMessage,
  engineChip,
  windowClosureEvidence,
  windowClosureNotice,
} from '../presenters.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

export const REFRESH_INTERVAL_MS = 5_000;

export interface DiscoveryViewModel {
  readonly snapshot: DiscoverySnapshot | undefined;
  /** True until the first reading arrives — the difference between "empty" and "not looked yet". */
  readonly loading: boolean;
  readonly containers: readonly DevContainer[];
  readonly groups: readonly ContainerGroup[];
  readonly dockerOk: boolean;
  readonly engine: EngineChip | undefined;
  /** Why the list is empty while the engine is fine. */
  readonly emptyMessage: string;
  readonly anyBusy: boolean;
  readonly isBusy: (id: ContainerId) => boolean;
  readonly isGroupBusy: (group: ContainerGroup) => boolean;
  readonly refresh: () => void;
  readonly start: (container: DevContainer) => void;
  readonly stop: (container: DevContainer) => void;
  readonly startAll: (containers: readonly DevContainer[]) => void;
  readonly stopAll: (containers: readonly DevContainer[]) => void;
  /**
   * Open the container's workspace folder in the chosen editor.
   *
   * `mode` defaults to `reuse`, which focuses the window this container
   * already has rather than opening a duplicate — see `OpenInEditorMode`. The
   * card only offers the choice once an editor is actually attached.
   */
  readonly open: (container: DevContainer, mode?: OpenInEditorMode) => void;
  /** Open a shell in the container. No-op when no terminal emulator was found. */
  readonly openTerminal: (container: DevContainer) => void;
  readonly selectEngine: (selection: EngineSelection) => void;
}

/**
 * The Docker half of the app: the polled snapshot, and every action that
 * changes it.
 *
 * Actions live here rather than beside the buttons that trigger them because
 * each one ends by re-reading — the poll, the busy set and the lifecycle verbs
 * are one state machine, and splitting them would mean a stop that lands on
 * top of a refresh and gets overwritten with pre-stop state.
 */
export function useDiscovery(
  api: BoxwardenApi | undefined,
  notices: NoticesViewModel,
  editorId: EditorId,
  terminalId: TerminalId | undefined,
): DiscoveryViewModel {
  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | undefined>(undefined);
  const [busy, setBusy] = useState<readonly ContainerId[]>([]);
  const mounted = useMounted();

  /**
   * Guards the poll against overlapping with itself or with an in-flight
   * action. Without it, a slow `docker ps` on a loaded machine queues refreshes
   * faster than they complete, and a stop lands on top of a refresh that then
   * overwrites the row with pre-stop state.
   */
  const inFlight = useRef(false);

  const { showThrown, showError, showInfo, rememberFallback } = notices;

  const refresh = useCallback(async () => {
    if (api === undefined || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.discover();
      if (mounted.current) setSnapshot(next);
    } catch (error) {
      if (mounted.current) showThrown(error);
    } finally {
      inFlight.current = false;
    }
  }, [api, mounted, showThrown]);

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

    const timer = setInterval(() => {
      // Skipped while the window is hidden, the same way `useClaudeStatus`
      // skips its own. This is the most expensive poll in the app — a probe of
      // every candidate endpoint, then a list and an inspect per container, and
      // on Windows a pass through WSL discovery underneath all of it — and
      // running it twelve times a minute against a minimised window is work
      // nobody can see. Checked on each tick rather than by tearing the
      // interval down, so the poll resumes on its own cadence.
      if (!document.hidden) void refresh();
    }, REFRESH_INTERVAL_MS);

    // Coming back to the window is the one moment a stale list is worth a round
    // trip out of turn: the containers were quite possibly started from a
    // terminal while boxwarden was in the background, and waiting up to five
    // seconds to notice is the difference between "it saw that" and "I had to
    // click something".
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  /**
   * Marks every container the action touches as busy, runs it, then re-reads.
   *
   * Takes a LIST rather than one container so a compose group's "Stop all"
   * disables the whole group's controls, not just the row that was clicked —
   * otherwise the siblings look actionable while they are mid-stop.
   */
  const withBusy = useCallback(
    async (targets: readonly DevContainer[], action: () => Promise<ActionResult>) => {
      const ids = targets.map((target) => target.id);
      setBusy((current) => [...current, ...ids]);
      inFlight.current = true;
      try {
        const result = await action();
        if (!result.ok) showError(result.message);
      } catch (error) {
        showThrown(error);
      } finally {
        if (mounted.current) setBusy((current) => current.filter((id) => !ids.includes(id)));
        inFlight.current = false;
        // Re-read rather than patching the row optimistically: Docker is the
        // source of truth, and a container that failed to start for its own
        // reasons should show that, not the state we hoped for.
        await refresh();
      }
    },
    [mounted, refresh, showError, showThrown],
  );

  const start = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], () => api.start(container.id));
    },
    [api, withBusy],
  );

  /**
   * Report what became of the container's editor window.
   *
   * Through `notices` like every other failure in this hook, and only on the
   * arms that have something to say — see `windowClosureNotice`. It runs INSIDE
   * `withBusy`'s action so a failed stop's own message still wins the bar:
   * `withBusy` shows that after the action returns, so anything set here is
   * overwritten by it, which is the ordering the `still-open` arm depends on.
   */
  const noteClosure = useCallback(
    (result: StopResult, container: DevContainer) => {
      const notice = windowClosureNotice(result.windows, container.name);
      if (notice === undefined) return;
      // The evidence first, so it is already in place when the message that
      // refers to it lands. `rememberFallback` and not `showLaunchFailure`:
      // the notice is set below, and setting both would render it twice.
      rememberFallback(windowClosureEvidence(result.windows));
      if (notice.tone === 'error') showError(notice.message);
      else showInfo(notice.message);
    },
    [rememberFallback, showError, showInfo],
  );

  const stop = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], async () => {
        const result = await api.stop(container.id);
        noteClosure(result, container);
        return result;
      });
    },
    [api, noteClosure, withBusy],
  );

  /**
   * Group actions loop over the existing single-container IPC calls rather
   * than adding a `startMany` channel. Two reasons: the IPC surface stays at
   * the narrow verbs it already has, and a compose project is a handful of
   * containers, so the round trips do not matter.
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

      void withBusy(eligible, async (): Promise<ActionResult> => {
        const results = await Promise.allSettled(
          eligible.map((container) =>
            verb === 'start' ? api.start(container.id) : api.stop(container.id),
          ),
        );

        // Every service in a compose project carries the same workspace folder,
        // but only the one an editor actually attached to reports anything other
        // than `none` — so in practice this speaks at most once per group. The
        // loop is not a fold for that reason: there is nothing to add up.
        if (verb === 'stop') {
          for (const [index, result] of results.entries()) {
            const container = eligible[index];
            if (result.status !== 'fulfilled' || container === undefined) continue;
            noteClosure(result.value, container);
          }
        }

        const failures = results.flatMap((result, index) => {
          const name = eligible[index]?.name ?? 'a container';
          if (result.status === 'rejected') return [`${name}: ${String(result.reason)}`];
          return result.value.ok ? [] : [`${name}: ${result.value.message}`];
        });

        return failures.length === 0
          ? { ok: true }
          : {
              ok: false,
              message: `Could not ${verb} ${String(failures.length)} of ${String(eligible.length)}: ${failures.join('; ')}`,
            };
      });
    },
    [api, noteClosure, withBusy],
  );

  const startAll = useCallback(
    (containers: readonly DevContainer[]) => {
      runOnAll(containers, 'start');
    },
    [runOnAll],
  );

  const stopAll = useCallback(
    (containers: readonly DevContainer[]) => {
      runOnAll(containers, 'stop');
    },
    [runOnAll],
  );

  const open = useCallback(
    (container: DevContainer, mode: OpenInEditorMode = 'reuse') => {
      if (api === undefined) return;
      void withBusy([container], async (): Promise<ActionResult> => {
        const result = await api.openInEditor(container.id, editorId, mode);
        if (result.ok) {
          // Worded for what was asked for: "Opening" a window that already
          // exists reads as a duplicate having been created.
          showInfo(
            mode === 'new-window'
              ? `Opening a new window on ${container.name}…`
              : `Opening ${container.name}…`,
          );
          // The URI is kept on SUCCESS too, not only on failure. "Succeeded"
          // here means the process was spawned, which is a weaker claim than it
          // looks: an editor that does not understand the authority opens an
          // empty window and exits zero, and that is indistinguishable from
          // working unless the user can see the URI that was handed over. The
          // copy button is how a fork gets verified against a real install.
          rememberFallback({ label: 'Copy URI', value: result.uri });
          return { ok: true };
        }
        // Only the fallback here — `withBusy` shows the message, and setting
        // both would render the notice twice.
        rememberFallback(
          result.uri === undefined ? undefined : { label: 'Copy URI', value: result.uri },
        );
        return { ok: false, message: result.message };
      });
    },
    [api, editorId, showInfo, rememberFallback, withBusy],
  );

  /**
   * Opening a terminal is not a lifecycle action, but it shares the busy set
   * with them — resolving an emulator and the container CLI spawns `which` a
   * few times, and a second click while that is in flight would open a second
   * window. Sharing the set is also what keeps the card's buttons agreeing with
   * each other about whether anything is happening to it.
   */
  const openTerminal = useCallback(
    (container: DevContainer) => {
      if (api === undefined || terminalId === undefined) return;
      void withBusy([container], async (): Promise<ActionResult> => {
        const result = await api.openTerminal(container.id, terminalId);
        if (result.ok) {
          showInfo(`Opening a terminal in ${container.name}…`);
          return { ok: true };
        }
        rememberFallback(
          result.command === undefined
            ? undefined
            : { label: 'Copy command', value: result.command },
        );
        return { ok: false, message: result.message };
      });
    },
    [api, terminalId, showInfo, rememberFallback, withBusy],
  );

  /**
   * Switching engines re-reads immediately rather than waiting for the poll.
   *
   * The whole list is about to change, and up to five seconds of showing
   * containers from the engine the user just switched away from would read as
   * the setting having failed.
   */
  const selectEngine = useCallback(
    (selection: EngineSelection) => {
      if (api === undefined) return;
      // Painted optimistically so the <select> responds to the click. The next
      // snapshot carries the authoritative value from the main process, which
      // is the one that decides what the list actually contains.
      setSnapshot((current) => (current === undefined ? current : { ...current, selection }));
      void api.selectEngine(selection).then(
        (result) => {
          if (!result.ok) showError(result.message);
          void refresh();
        },
        (error: unknown) => {
          showThrown(error);
        },
      );
    },
    [api, refresh, showError, showThrown],
  );

  const containers = snapshot?.containers ?? [];
  const groups = groupContainers(containers);
  const engine = snapshot === undefined ? undefined : engineChip(snapshot);

  const isBusy = useCallback((id: ContainerId) => busy.includes(id), [busy]);
  const isGroupBusy = useCallback(
    (group: ContainerGroup) =>
      group.kind === 'single'
        ? busy.includes(group.container.id)
        : group.containers.some((container) => busy.includes(container.id)),
    [busy],
  );

  return {
    snapshot,
    loading: snapshot === undefined,
    containers,
    groups,
    dockerOk: snapshot?.environment.api.ok ?? false,
    engine,
    emptyMessage:
      snapshot === undefined
        ? ''
        : emptyListMessage(snapshot.selection, engine?.connectedCount ?? 0),
    anyBusy: busy.length > 0,
    isBusy,
    isGroupBusy,
    refresh: useCallback(() => void refresh(), [refresh]),
    start,
    stop,
    startAll,
    stopAll,
    open,
    openTerminal,
    selectEngine,
  };
}
