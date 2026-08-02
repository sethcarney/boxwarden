import type { DevContainer, EditorId } from '../../models/index.js';
import { canStart, canStop, hostPathLabel, statusLabel } from '../format.js';
import {
  cardTitle,
  openBlockedReason,
  portLabel,
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

  return (
    <article className={`card${unresolved ? ' card-degraded' : ''}`}>
      <header className="card-head">
        <div className="card-title">
          <StatusDot runtime={container.runtime} />
          <h2>{cardTitle(container)}</h2>
        </div>
        <span className="card-status">{statusLabel(container.runtime, now)}</span>
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
