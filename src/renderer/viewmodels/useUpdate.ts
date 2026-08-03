import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../../models/index.js';
import type { BoxwardenApi } from '../../shared/ipc.js';
import { errorMessage, updatePanel, updateSummary } from '../presenters.js';
import type { UpdatePanel, UpdateSummary } from '../presenters.js';
import { useMounted } from './useMounted.js';

/**
 * How often the renderer ASKS. It is not how often GitHub is asked.
 *
 * The daily gate lives in the main process, where the timestamp is persisted,
 * so this poll costs one IPC round trip an hour and answers from memory
 * twenty-three times out of twenty-four. It exists for the app that is left
 * open for days: without it, "daily" would mean "whenever you next launch".
 */
export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** Before the first answer. The version fills in as soon as one arrives. */
const INITIAL: UpdateStatus = { currentVersion: '', outcome: { kind: 'unchecked' } };

export interface UpdateViewModel {
  readonly status: UpdateStatus;
  /** The banner, or undefined — which is the answer most of the time. */
  readonly panel: UpdatePanel | undefined;
  /** The footer line, on every arm. */
  readonly summary: UpdateSummary;
  readonly busy: boolean;
  /**
   * The footer line's click: look now, turning checks back on first if they
   * were off, and bring back a banner the user dismissed.
   */
  readonly act: () => void;
  /** "Not now" — hides the banner for this version only. */
  readonly dismiss: () => void;
  /** "Stop checking" — persisted, and reversible from the footer. */
  readonly disable: () => void;
}

/**
 * Whether a newer boxwarden has been published.
 *
 * A ViewModel of its own, on the slowest cadence in the app, for the reason
 * `useProjects` and `useClaudeStatus` are separate: what it costs and how
 * often the answer changes. Discovery polls a socket every five seconds; this
 * is an HTTP request whose answer changes when somebody publishes a release.
 *
 * **It does not report through `useNotices`, and that is deliberate.** Every
 * other ViewModel does, because every other failure follows something the user
 * clicked. This one runs on its own, in the background, and a failed check
 * that seized the message bar would push aside a notice about the thing the
 * user was actually doing — hourly, forever, on a machine that is simply
 * offline. The failure has a home of its own instead: it is an arm of the
 * status, so it appears exactly where the answer would have, in the footer
 * line and under the "Check now" button that asked for it.
 */
export function useUpdate(
  api: BoxwardenApi | undefined,
  now: number,
  /** A parameter for the same reason `useClaudeStatus` takes one: tests. */
  intervalMs: number = UPDATE_INTERVAL_MS,
): UpdateViewModel {
  const [status, setStatus] = useState<UpdateStatus>(INITIAL);
  const [busy, setBusy] = useState(false);
  /**
   * The user asked to see a banner they had already dismissed. Renderer-local
   * on purpose: it is about this window right now, not a preference, and
   * persisting it would un-dismiss the update on the next launch.
   */
  const [revealed, setRevealed] = useState(false);
  const mounted = useMounted();

  const run = useCallback(
    async (call: (bridge: BoxwardenApi) => Promise<UpdateStatus>) => {
      if (api === undefined) return;
      setBusy(true);
      try {
        const next = await call(api);
        if (mounted.current) setStatus(next);
      } catch (error) {
        // The handlers answer failure as data, so reaching here means the
        // bridge itself broke. Reported in the same place a failed check is,
        // rather than in the message bar — see the note on the hook.
        if (mounted.current) {
          setStatus((current) => ({
            ...current,
            outcome: { kind: 'failed', message: errorMessage(error) },
          }));
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [api, mounted],
  );

  /** Kept in a ref so the poll effect does not restart when `run` changes. */
  const poll = useRef(run);
  poll.current = run;

  useEffect(() => {
    // Asked once on open. The main process answers from its own memory unless
    // a day has passed, so this is not a check on every launch — it is how the
    // window finds out about one that already happened.
    //
    // Every setState this reaches happens after an await, so none of them is
    // the synchronous cascading render `react-hooks/set-state-in-effect`
    // exists to prevent.
    void poll.current((bridge) => bridge.updateStatus(false));

    const timer = setInterval(() => {
      void poll.current((bridge) => bridge.updateStatus(false));
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [api, intervalMs]);

  const act = useCallback(() => {
    setRevealed(true);
    void run((bridge) =>
      // Turning checks back on looks immediately, so one click answers the
      // question the user was asking by clicking.
      status.outcome.kind === 'disabled' ? bridge.setUpdateChecks(true) : bridge.updateStatus(true),
    );
  }, [run, status.outcome.kind]);

  const dismiss = useCallback(() => {
    setRevealed(false);
    void run((bridge) => bridge.dismissUpdate());
  }, [run]);

  const disable = useCallback(() => {
    setRevealed(false);
    void run((bridge) => bridge.setUpdateChecks(false));
  }, [run]);

  return {
    status,
    panel: updatePanel(status, now, revealed),
    summary: updateSummary(status, now),
    busy,
    act,
    dismiss,
    disable,
  };
}
