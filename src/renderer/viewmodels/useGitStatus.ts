import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContainerId, DevContainer, GitStatus } from '../../models/index.js';
import type { BoxwardenApi, GitStatusMap } from '../../shared/ipc.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

/**
 * How often to re-read. Slower than everything else that polls, because a
 * checkout changes less often than anything else on a card — see the hook.
 */
export const GIT_INTERVAL_MS = 30_000;

export interface GitViewModel {
  /**
   * Branch by container id. A MISSING entry means "no answer yet", which is
   * not `{ kind: 'none' }` — the first is a card that has not been asked
   * about, the second is a folder that is not a checkout.
   */
  readonly statuses: GitStatusMap;
  readonly statusFor: (id: ContainerId) => GitStatus | undefined;
  readonly refresh: () => void;
}

/**
 * Which branch each container's workspace is on.
 *
 * A ViewModel of its own for the reason `useClaudeStatus` is one: cadence.
 * Discovery polls every five seconds because a container's state changes
 * without anyone asking; this reads files on the host disk — potentially over a
 * network share or a UNC path into a WSL distro — to answer a question whose
 * answer changes when a person types `git switch`. Thirty seconds, then, and
 * folding it into the fast poll would put a `stat` per container behind it.
 *
 * Unlike `useClaudeStatus` it asks about EVERY container, not just the live
 * ones. There is no process table involved: the folder is on disk whether the
 * container is running or not, and "which branch was that stopped one on?" is
 * exactly the question a person has when deciding whether to start it.
 *
 * Two behaviours it shares with the Claude poll, for the same reasons:
 *
 *   - **It does not blank on failure.** A failed poll leaves the last known
 *     branches standing rather than clearing every chip for a beat.
 *   - **It does not poll while the window is hidden**, and takes a fresh
 *     reading the moment it is shown again.
 */
export function useGitStatus(
  api: BoxwardenApi | undefined,
  notices: NoticesViewModel,
  containers: readonly DevContainer[],
  /** A parameter for the same reason `useClaudeStatus` takes one — see there. */
  intervalMs: number = GIT_INTERVAL_MS,
): GitViewModel {
  const [statuses, setStatuses] = useState<GitStatusMap>({});
  const mounted = useMounted();

  // Destructured rather than held as the object: `notices` is rebuilt on every
  // render of the root ViewModel, and depending on it would restart this poll.
  const { showError } = notices;

  /**
   * The ids to ask about, as a stable string. `containers` is a fresh array on
   * every discovery poll, so depending on it directly would restart this
   * interval six times a minute and it would never reach its own cadence.
   */
  const allKey = containers.map((container) => container.id).join(',');

  /** Guards against a slow batch overlapping the next tick. */
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (api === undefined || inFlight.current) return;
    const ids = allKey === '' ? [] : (allKey.split(',') as ContainerId[]);
    if (ids.length === 0) return;

    inFlight.current = true;
    try {
      const next = await api.gitStatus(ids);
      // Merged, not replaced — see "does not blank on failure" above.
      if (mounted.current) setStatuses((current) => ({ ...current, ...next }));
    } catch (error) {
      if (mounted.current) {
        showError(
          `Could not read the workspace branches: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      inFlight.current = false;
    }
  }, [api, allKey, mounted, showError]);

  useEffect(() => {
    // Immediately, so the first paint is not a list of cards that acquire their
    // branches half a minute later.
    //
    // Suppressed on the same grounds as the other two polls: the rule fires
    // because `poll` transitively calls setState, but that call happens after
    // `await api.gitStatus(...)` and is not the synchronous cascading render
    // the rule exists to prevent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll();

    const timer = setInterval(() => {
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

  /** Containers that have left the list are filtered on the way out — see `useClaudeStatus`. */
  const visible = useMemo(() => {
    const present = new Set(allKey === '' ? [] : allKey.split(','));
    return Object.fromEntries(Object.entries(statuses).filter(([id]) => present.has(id)));
  }, [statuses, allKey]);

  const statusFor = useCallback((id: ContainerId) => visible[id], [visible]);

  return {
    statuses: visible,
    statusFor,
    refresh: useCallback(() => void poll(), [poll]),
  };
}
