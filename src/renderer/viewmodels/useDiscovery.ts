import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContainerId,
  DevContainer,
  EditorId,
  EngineSelection,
  TerminalId,
} from '../../models/index.js';
import type { ActionResult, BoxwardenApi, DiscoverySnapshot } from '../../shared/ipc.js';
import { canStart, canStop } from '../format.js';
import type { ContainerGroup } from '../grouping.js';
import { groupContainers } from '../grouping.js';
import type { BuildGate, EngineChip } from '../presenters.js';
import { devcontainerBuildGate, emptyListMessage, engineChip } from '../presenters.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

export const REFRESH_INTERVAL_MS = 5_000;

/** Which lifecycle action holds a container's busy claim. */
export type LifecycleVerb =
  'start' | 'stop' | 'kill' | 'open' | 'terminal' | 'rebuild' | 'quit-editor';

/**
 * One in-flight action's claim on one container.
 *
 * Compared by IDENTITY when released, not by id — see `withBusy`. Two actions
 * can legitimately overlap on one container (a kill fired at a hanging stop is
 * the whole point of the kill), and the first to finish must release only its
 * own claim.
 */
interface BusyEntry {
  readonly id: ContainerId;
  readonly verb: LifecycleVerb;
}

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
  /**
   * The MOST RECENT action still holding this container, or undefined.
   *
   * What the card reads to say "Stopping…" only when a stop is what is
   * running, and to keep Force stop clickable while it is — the one moment
   * that button matters is precisely when everything else on the card is
   * disabled by the stop that hung.
   */
  readonly busyVerb: (id: ContainerId) => LifecycleVerb | undefined;
  readonly isGroupBusy: (group: ContainerGroup) => boolean;
  readonly refresh: () => void;
  readonly start: (container: DevContainer) => void;
  readonly stop: (container: DevContainer) => void;
  /**
   * SIGKILL, now. Allowed while a `stop` on the same container is still in
   * flight — that is not a race to guard against, it is the button's job.
   */
  readonly kill: (container: DevContainer) => void;
  /**
   * `devcontainer up --remove-existing-container` for this container's
   * workspace. Minutes, not seconds — the poll keeps running underneath it
   * (see `withBusy`), so the card shows the container going away and coming
   * back as the CLI works.
   */
  readonly rebuild: (container: DevContainer) => void;
  /** Whether Build and Rebuild have their tools, and why not when not. */
  readonly buildGate: BuildGate;
  readonly startAll: (containers: readonly DevContainer[]) => void;
  readonly stopAll: (containers: readonly DevContainer[]) => void;
  /**
   * Open the container's workspace folder in the chosen editor.
   *
   * One verb, no mode: an editor asked for a folder one of its windows already
   * has focuses that window, and there is no flag that makes it do otherwise —
   * see `src/models/editor.ts`.
   */
  readonly open: (container: DevContainer) => void;
  /**
   * Quit VS Code — the application, every window, which is the only per-editor
   * operation that exists (see `quitEditorAction`). The container is only the
   * card the click landed on: nothing about it crosses IPC, it just holds the
   * busy claim so the card's buttons agree something is happening.
   */
  readonly quitEditor: (container: DevContainer) => void;
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
  const [busy, setBusy] = useState<readonly BusyEntry[]>([]);
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
    async (
      targets: readonly DevContainer[],
      verb: LifecycleVerb,
      action: () => Promise<ActionResult>,
    ) => {
      const entries: readonly BusyEntry[] = targets.map((target) => ({ id: target.id, verb }));
      setBusy((current) => [...current, ...entries]);
      // A rebuild runs for MINUTES, and freezing the poll for its whole
      // duration would freeze every other card on screen too — so it alone
      // leaves the poll running, which is also what lets its own card show
      // the container going away and coming back. The short verbs keep the
      // guard: a poll landing mid-stop overwrites the row with pre-stop state.
      // Quitting the editor is the other exception, for the other reason: it
      // waits several seconds for a graceful quit and touches no container
      // state at all, so there is nothing a poll could overwrite.
      const blockPoll = verb !== 'rebuild' && verb !== 'quit-editor';
      if (blockPoll) inFlight.current = true;
      try {
        const result = await action();
        if (!result.ok) showError(result.message);
      } catch (error) {
        showThrown(error);
      } finally {
        // Released by IDENTITY, not by id. A kill fired at a hanging stop puts
        // two claims on one container, and whichever action lands first must
        // not release the other's — filtering by id here would re-enable every
        // button while the second action is still running.
        if (mounted.current)
          setBusy((current) => current.filter((entry) => !entries.includes(entry)));
        if (blockPoll) inFlight.current = false;
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
      void withBusy([container], 'start', () => api.start(container.id));
    },
    [api, withBusy],
  );

  const stop = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], 'stop', () => api.stop(container.id));
    },
    [api, withBusy],
  );

  const kill = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], 'kill', () => api.kill(container.id));
    },
    [api, withBusy],
  );

  const rebuild = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      // Said up front, because the next several minutes look like nothing
      // happening followed by the container disappearing — both of which are
      // the feature working.
      showInfo(`Rebuilding ${container.name} — this can take a few minutes…`);
      void withBusy([container], 'rebuild', () => api.rebuild(container.id));
    },
    [api, showInfo, withBusy],
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

      void withBusy(eligible, verb, async (): Promise<ActionResult> => {
        const results = await Promise.allSettled(
          eligible.map((container) =>
            verb === 'start' ? api.start(container.id) : api.stop(container.id),
          ),
        );

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
    [api, withBusy],
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
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], 'open', async (): Promise<ActionResult> => {
        const result = await api.openInEditor(container.id, editorId);
        if (result.ok) {
          showInfo(`Opening ${container.name}…`);
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

  const quitEditor = useCallback(
    (container: DevContainer) => {
      if (api === undefined) return;
      void withBusy([container], 'quit-editor', async (): Promise<ActionResult> => {
        const result = await api.quitEditor();
        // Said explicitly on success because the effect is bigger than the
        // card it was clicked on: every VS Code window on the machine.
        if (result.ok) showInfo('VS Code has quit — every window, not just this container’s.');
        return result;
      });
    },
    [api, showInfo, withBusy],
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
      void withBusy([container], 'terminal', async (): Promise<ActionResult> => {
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

  const isBusy = useCallback((id: ContainerId) => busy.some((entry) => entry.id === id), [busy]);
  // The LAST claim, not the first: a kill fired at a hanging stop is the more
  // recent statement of intent, and it is the one the buttons should reflect.
  const busyVerb = useCallback(
    (id: ContainerId) => {
      for (let index = busy.length - 1; index >= 0; index--) {
        const entry = busy[index];
        if (entry?.id === id) return entry.verb;
      }
      return undefined;
    },
    [busy],
  );
  const isGroupBusy = useCallback(
    (group: ContainerGroup) =>
      group.kind === 'single'
        ? busy.some((entry) => entry.id === group.container.id)
        : group.containers.some((container) => busy.some((entry) => entry.id === container.id)),
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
    buildGate: devcontainerBuildGate(snapshot?.environment),
    isBusy,
    busyVerb,
    isGroupBusy,
    refresh: useCallback(() => void refresh(), [refresh]),
    start,
    stop,
    kill,
    rebuild,
    startAll,
    stopAll,
    open,
    quitEditor,
    openTerminal,
    selectEngine,
  };
}
