import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClaudeStatus,
  ContainerId,
  DevContainer,
  EditorAttachment,
} from '../../models/index.js';
import type { BoxwardenApi, ContainerActivity, ContainerActivityMap } from '../../shared/ipc.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

/**
 * How often to re-read. Three times slower than discovery, deliberately —
 * see the note on the hook.
 */
export const ACTIVITY_INTERVAL_MS = 15_000;

export interface ActivityViewModel {
  /**
   * By container id. A MISSING entry means "no answer yet"; it is not the same
   * as `{ kind: 'none' }`, and the Views must not treat it as such — a card
   * with no warning is a card saying stopping is safe.
   */
  readonly statuses: ContainerActivityMap;
  readonly activityFor: (id: ContainerId) => ContainerActivity | undefined;
  readonly claudeFor: (id: ContainerId) => ClaudeStatus | undefined;
  readonly editorFor: (id: ContainerId) => EditorAttachment | undefined;
  /** Every reading in a group, in the group's own order — what "Stop all" aggregates. */
  readonly claudeForAll: (
    containers: readonly DevContainer[],
  ) => readonly (ClaudeStatus | undefined)[];
  readonly editorsForAll: (
    containers: readonly DevContainer[],
  ) => readonly (EditorAttachment | undefined)[];
  readonly refresh: () => void;
}

/**
 * What is running inside each live container: a Claude Code session, an
 * attached editor, or neither.
 *
 * A ViewModel of its own, and NOT part of `useDiscovery`, for the same reason
 * `useProjects` is separate: cadence. Discovery polls every five seconds
 * because a container's state changes without anyone asking. This costs one
 * `top` per live container, and re-derives an answer that changes when a
 * person starts an agent — so it runs on a fifteen-second clock instead, and
 * folding the two together would multiply the fast poll's Docker traffic by
 * the length of the list.
 *
 * Two behaviours worth knowing:
 *
 *   - **It does not blank on failure.** A failed poll leaves the last known
 *     statuses standing. Losing a badge for a beat would make the Stop button
 *     momentarily look safe for a container with an agent in it, which is the
 *     exact failure this feature exists to prevent.
 *   - **It does not poll while the window is hidden.** Discovery does, because
 *     the container list is what a user comes back to look at. This exists to
 *     guard a click, and there are no clicks in a hidden window — but it takes
 *     a fresh reading the moment the window is shown again, which is when a
 *     stale badge is about to be acted on.
 */
export function useContainerActivity(
  api: BoxwardenApi | undefined,
  notices: NoticesViewModel,
  containers: readonly DevContainer[],
  /**
   * A parameter rather than a constant read inside, for the same reason
   * `relativeTime` takes `now`: a test that asserts on cadence would otherwise
   * need fake timers, and faking the timers React's scheduler runs on
   * deadlocks `act()` rather than failing. Callers in the app pass nothing.
   */
  intervalMs: number = ACTIVITY_INTERVAL_MS,
): ActivityViewModel {
  const [statuses, setStatuses] = useState<ContainerActivityMap>({});
  const mounted = useMounted();

  // Destructured, not held as the object: `notices` is rebuilt on every render
  // of the root ViewModel, and depending on it would restart this poll's
  // effect several times per discovery tick. The callbacks themselves are
  // stable.
  const { showError } = notices;

  /**
   * The ids to ask about, as a stable string.
   *
   * `containers` is a fresh array on every discovery poll — every five seconds
   * — so depending on it directly would restart the interval three times per
   * tick and it would never reach its own cadence. The join makes the
   * dependency the *contents* rather than the array identity.
   */
  const liveKey = containers
    .filter(
      (container) => container.runtime.state === 'running' || container.runtime.state === 'paused',
    )
    .map((container) => container.id)
    .join(',');
  const allKey = containers.map((container) => container.id).join(',');

  /** Guards against a slow batch overlapping the next tick. */
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (api === undefined || inFlight.current) return;
    const ids = liveKey === '' ? [] : (liveKey.split(',') as ContainerId[]);
    if (ids.length === 0) return;

    inFlight.current = true;
    try {
      const next = await api.containerActivity(ids);
      // Merged, not replaced — see "does not blank on failure" above.
      if (mounted.current) setStatuses((current) => ({ ...current, ...next }));
    } catch (error) {
      if (mounted.current) {
        showError(
          `Could not read what is running inside the containers: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      inFlight.current = false;
    }
  }, [api, liveKey, mounted, showError]);

  useEffect(() => {
    // Take a reading immediately so the first paint is not a card with no
    // badge for fifteen seconds — which reads as "nothing running".
    //
    // Suppressed rather than worked around, on the same grounds as the
    // discovery poll: the rule fires because `poll` transitively calls
    // setState, but every one of those calls happens after
    // `await api.claudeStatus(...)`, so none is the synchronous cascading
    // render the rule exists to prevent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll();

    const timer = setInterval(() => {
      // Checked on each tick rather than by tearing the interval down, so the
      // poll resumes on its own cadence without a visibilitychange listener
      // racing the timer.
      if (!document.hidden) void poll();
    }, intervalMs);

    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll, intervalMs]);

  /**
   * Containers that have left the list are filtered out on the way out rather
   * than pruned from state in an effect. An effect that calls setState with no
   * await in front of it IS the cascading render that
   * react-hooks/set-state-in-effect exists to catch, and deriving the answer
   * costs a pass over a list that is a handful of rows long.
   */
  const visible = useMemo(() => {
    const present = new Set(allKey === '' ? [] : allKey.split(','));
    return Object.fromEntries(Object.entries(statuses).filter(([id]) => present.has(id)));
  }, [statuses, allKey]);

  const activityFor = useCallback((id: ContainerId) => visible[id], [visible]);
  const claudeFor = useCallback((id: ContainerId) => visible[id]?.claude, [visible]);
  const editorFor = useCallback((id: ContainerId) => visible[id]?.editor, [visible]);
  const claudeForAll = useCallback(
    (group: readonly DevContainer[]) => group.map((container) => visible[container.id]?.claude),
    [visible],
  );
  const editorsForAll = useCallback(
    (group: readonly DevContainer[]) => group.map((container) => visible[container.id]?.editor),
    [visible],
  );

  return {
    statuses: visible,
    activityFor,
    claudeFor,
    editorFor,
    claudeForAll,
    editorsForAll,
    refresh: useCallback(() => void poll(), [poll]),
  };
}
