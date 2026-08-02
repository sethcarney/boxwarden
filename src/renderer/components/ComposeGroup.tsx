import type { ClaudeStatus, DevContainer } from '../../models/index.js';
import { canStart, canStop } from '../format.js';
import { claudeStopWarning } from '../presenters.js';
import { groupCanStart, groupCanStop } from '../grouping.js';

interface Props {
  readonly project: string;
  readonly containers: readonly DevContainer[];
  readonly busy: boolean;
  /**
   * One entry per container in `containers`, in the same order. Aggregated for
   * "Stop all", which is where this warning matters most: that button reaches
   * every service in the project, including ones whose own card the user never
   * looked at.
   */
  readonly claude?: readonly (ClaudeStatus | undefined)[] | undefined;
  readonly onStartAll: (containers: readonly DevContainer[]) => void;
  readonly onStopAll: (containers: readonly DevContainer[]) => void;
  readonly children: React.ReactNode;
}

/**
 * Header and group-level actions for a Docker Compose project.
 *
 * The per-container cards still render inside, because the details a user
 * wants — which service is unhealthy, which port is published — are per
 * container. What changes is that "Stop all" exists at all: stopping the
 * workspace container alone leaves the database running, which is the state
 * this app is supposed to get people out of.
 *
 * Individual cards keep their own Start/Stop. Acting on one service is a real
 * thing to want; it is just not what an unqualified "Stop" should mean.
 */
export function ComposeGroup({
  project,
  containers,
  busy,
  claude = [],
  onStartAll,
  onStopAll,
  children,
}: Props) {
  const startable = groupCanStart(containers, canStart);
  const stoppable = groupCanStop(containers, canStop);
  const runningCount = containers.filter((c) => canStop(c.runtime)).length;
  const stopWarning = claudeStopWarning(claude);

  return (
    <section className="group" aria-label={`Compose project ${project}`}>
      <header className="group-head">
        <div className="group-title">
          <span className="tag">compose</span>
          <h2>{project}</h2>
          <span className="group-count">
            {runningCount} of {containers.length} running
          </span>
        </div>

        <div className="group-actions">
          {stoppable && (
            <button
              type="button"
              className={stopWarning === undefined ? undefined : 'warn'}
              title={stopWarning}
              disabled={busy}
              onClick={() => {
                onStopAll(containers);
              }}
            >
              {busy ? 'Working…' : 'Stop all'}
            </button>
          )}
          {startable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onStartAll(containers);
              }}
            >
              {busy ? 'Working…' : 'Start all'}
            </button>
          )}
        </div>
      </header>

      <div className="group-body">{children}</div>
    </section>
  );
}
