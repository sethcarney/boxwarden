import type { ClaudeStatus, DevContainer, EditorId, GitStatus } from '../../models/index.js';
import { canStart, canStop, hostPathLabel, statusLabel } from '../format.js';
import {
  branchChip,
  cardTitle,
  claudeBadge,
  claudeStopWarning,
  openBlockedReason,
  portLabel,
  sshAgentBadge,
  terminalBlockedReason,
  visiblePorts,
} from '../presenters.js';
import { StartupCommandField } from './StartupCommandField.js';
import { StatusDot } from './StatusDot.js';

interface Props {
  readonly container: DevContainer;
  readonly editorId: EditorId;
  readonly editorName: string;
  readonly editorAvailable: boolean;
  /** Undefined when no emulator was found — a different sentence from "Konsole was not found". */
  readonly terminalName: string | undefined;
  readonly terminalAvailable: boolean;
  /** '' when none is set. */
  readonly startupCommand: string;
  readonly busy: boolean;
  readonly now: number;
  /**
   * Rows layout: one line per container. Trims the labels that do not fit on
   * one — the image, and the editor's name inside the primary button. Nothing
   * is dropped without a `title` keeping it reachable.
   */
  readonly dense?: boolean;
  /**
   * Whether Claude Code is running in this container.
   *
   * Absent while the first poll is outstanding, and for a container the main
   * process has not been asked about. Absent is NOT `{ kind: 'none' }`: one
   * means "no answer yet", the other means "asked, nothing running", and only
   * the second one makes the Stop button safe.
   *
   * Spelled `?: T | undefined` rather than `?: T` because
   * exactOptionalPropertyTypes is on and the parent passes the result of a
   * lookup — an expression that is legitimately `undefined` rather than a key
   * it can omit.
   */
  readonly claude?: ClaudeStatus | undefined;
  /**
   * Which branch the workspace folder is on.
   *
   * Absent while the first read is outstanding. Unlike `claude`, absent and
   * `{ kind: 'none' }` render identically — nothing here gates an action, so
   * there is no meaning attached to the chip being missing.
   */
  readonly git?: GitStatus | undefined;
  readonly onStart: (container: DevContainer) => void;
  readonly onStop: (container: DevContainer) => void;
  readonly onOpen: (container: DevContainer) => void;
  readonly onOpenTerminal: (container: DevContainer) => void;
  readonly onStartupCommandChange: (container: DevContainer, command: string) => void;
}

/**
 * A View. Every string it shows comes from `format.ts` or `presenters.ts`, and
 * every action is a callback — there is no decision made in this file.
 *
 * `now` arrives as a prop rather than being read inside. The ViewModel ticks it
 * once a second, so every "Up 3 minutes" on screen advances together off one
 * timer instead of each card owning one.
 */
export function ContainerCard({
  container,
  editorName,
  editorAvailable,
  terminalName,
  terminalAvailable,
  startupCommand,
  busy,
  now,
  dense = false,
  claude,
  git,
  onStart,
  onStop,
  onOpen,
  onOpenTerminal,
  onStartupCommandChange,
}: Props) {
  const unresolved = container.localFolder.kind === 'unresolved';
  const ports = visiblePorts(container);
  const blocked = openBlockedReason(container, editorAvailable, editorName);
  const terminalBlocked = terminalBlockedReason(container, terminalAvailable, terminalName);
  const agent = sshAgentBadge(container.sshAgent);
  const badge = claudeBadge(claude);
  const branch = branchChip(git);
  const stopWarning = claudeStopWarning([claude]);

  return (
    <article className={`card${unresolved ? ' card-degraded' : ''}`}>
      <header className="card-head">
        <div className="card-title">
          <StatusDot runtime={container.runtime} />
          <h2>{cardTitle(container)}</h2>
          {/* Beside the name rather than in the meta list below it: the branch
              is the second thing a person needs to identify a checkout, and the
              meta list is the part the rows layout hides. Long branch names are
              ellipsised by the stylesheet and kept whole in `title`. */}
          {branch !== undefined && (
            <span
              className={`branch-chip branch-chip-${branch.tone}`}
              title={branch.title}
              aria-label={branch.label}
            >
              <span className="branch-chip-icon" aria-hidden="true">
                ⎇
              </span>
              {branch.text}
            </span>
          )}
          {/* Nothing at all for `absent` — see the note on sshAgentBadge. */}
          {agent !== undefined && (
            <span
              className={`agent-badge${agent.warning ? ' agent-badge-warning' : ''}`}
              title={agent.title}
            >
              {dense ? agent.short : agent.text}
            </span>
          )}
        </div>
        <div className="card-head-right">
          {/* Shortened under `dense` to a bare count, with the full text kept
              in `title` — the same contract as the image row and the primary
              button. The session count, pids and uptimes are all in there. */}
          {badge !== undefined && (
            <span
              className={`badge badge-claude badge-claude-${badge.tone}`}
              title={badge.title}
              aria-label={badge.label}
            >
              {dense ? badge.denseLabel : badge.label}
            </span>
          )}
          <span className="card-status">{statusLabel(container.runtime, now)}</span>
        </div>
      </header>

      <dl className="card-meta">
        <dt className="meta-folder">Folder</dt>
        <dd
          className={`meta-folder${unresolved ? ' unresolved' : ''}`}
          title={hostPathLabel(container.localFolder)}
        >
          {hostPathLabel(container.localFolder)}
          {/* `unresolved` is a const derived from the same check, so TypeScript
              narrows localFolder here — no second guard needed. */}
          {container.localFolder.kind === 'unresolved' && (
            <span className="hint"> — {container.localFolder.reason}</span>
          )}
        </dd>

        {/* Hidden by the stylesheet in rows layout — see `.meta-image`. */}
        <dt className="meta-image">Image</dt>
        <dd className="meta-image" title={container.image}>
          {container.image}
        </dd>

        {ports.length > 0 && (
          <>
            <dt className="meta-ports">Ports</dt>
            <dd className="meta-ports ports">
              {ports.map((port) => {
                const label = portLabel(port);
                return (
                  <span
                    key={`${String(port.containerPort)}/${port.protocol}/${port.hostPort ?? 'none'}`}
                    className={port.hostPort === undefined ? 'port port-unpublished' : 'port'}
                    title={label.title}
                  >
                    {label.text}
                  </span>
                );
              })}
            </dd>
          </>
        )}

        <StartupCommandField
          value={startupCommand}
          disabled={busy}
          onCommit={(command) => {
            onStartupCommandChange(container, command);
          }}
        />
      </dl>

      <footer className="card-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || blocked !== undefined}
          title={blocked ?? `Open in ${editorName}`}
          onClick={() => {
            onOpen(container);
          }}
        >
          {dense ? 'Open' : `Open in ${editorName}`}
        </button>

        <button
          type="button"
          disabled={busy || terminalBlocked !== undefined}
          title={
            terminalBlocked ??
            `Open a shell in this container${terminalName === undefined ? '' : ` with ${terminalName}`}.`
          }
          onClick={() => {
            onOpenTerminal(container);
          }}
        >
          Terminal
        </button>

        {canStop(container.runtime) && (
          <button
            type="button"
            // Annotated, not gated. Stopping a container with a live agent in
            // it stays one click — it just stops being an uninformed one.
            className={stopWarning === undefined ? undefined : 'warn'}
            title={stopWarning}
            disabled={busy}
            onClick={() => {
              onStop(container);
            }}
          >
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}

        {canStart(container.runtime) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onStart(container);
            }}
          >
            {busy ? 'Starting…' : 'Start'}
          </button>
        )}
      </footer>
    </article>
  );
}
