import type { DevContainer, EditorId } from '../../domain/index.js';
import { projectName } from '../../domain/index.js';
import { canStart, canStop, hostPathLabel, statusLabel } from '../format.js';
import { StatusDot } from './StatusDot.js';

interface Props {
  readonly container: DevContainer;
  readonly editorId: EditorId;
  readonly editorName: string;
  readonly editorAvailable: boolean;
  readonly busy: boolean;
  readonly now: number;
  readonly onStart: (container: DevContainer) => void;
  readonly onStop: (container: DevContainer) => void;
  readonly onOpen: (container: DevContainer) => void;
}

/**
 * `now` arrives as a prop rather than being read inside. The parent ticks it
 * once a second, so every "Up 3 minutes" on screen advances together off one
 * timer instead of each card owning one.
 */
export function ContainerCard({
  container,
  editorName,
  editorAvailable,
  busy,
  now,
  onStart,
  onStop,
  onOpen,
}: Props) {
  const unresolved = container.localFolder.kind === 'unresolved';
  const ports = container.runtime.state === 'running' || container.runtime.state === 'paused'
    ? container.runtime.ports
    : [];

  // Opening needs a folder inside the container to point at. Saying which
  // precondition failed beats a disabled button with no explanation.
  const openBlockedReason =
    container.workspaceFolder === undefined
      ? 'This container does not record which folder to open.'
      : !editorAvailable
        ? `${editorName} was not found on this machine.`
        : undefined;

  return (
    <article className={`card${unresolved ? ' card-degraded' : ''}`}>
      <header className="card-head">
        <div className="card-title">
          <StatusDot runtime={container.runtime} />
          <h2>{projectName(container.localFolder)}</h2>
          {container.labels.composeProject !== undefined && (
            <span className="tag" title="Part of a Docker Compose project — stopping this leaves its siblings running.">
              compose
            </span>
          )}
        </div>
        <span className="card-status">{statusLabel(container.runtime, now)}</span>
      </header>

      <dl className="card-meta">
        <dt>Folder</dt>
        <dd className={unresolved ? 'unresolved' : undefined} title={hostPathLabel(container.localFolder)}>
          {hostPathLabel(container.localFolder)}
          {unresolved && (
            <span className="hint"> — {container.localFolder.kind === 'unresolved' ? container.localFolder.reason : ''}</span>
          )}
        </dd>

        <dt>Image</dt>
        <dd title={container.image}>{container.image}</dd>

        {ports.length > 0 && (
          <>
            <dt>Ports</dt>
            <dd className="ports">
              {ports.map((port) => (
                <span
                  key={`${port.containerPort}/${port.protocol}/${port.hostPort ?? 'none'}`}
                  className={port.hostPort === undefined ? 'port port-unpublished' : 'port'}
                  title={
                    port.hostPort === undefined
                      ? 'Exposed by the image but not published to the host.'
                      : `${port.hostIp ?? '0.0.0.0'}:${port.hostPort} → ${port.containerPort}`
                  }
                >
                  {port.hostPort === undefined
                    ? `${port.containerPort} (not published)`
                    : `${port.hostPort} → ${port.containerPort}`}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      <footer className="card-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || openBlockedReason !== undefined}
          title={openBlockedReason}
          onClick={() => onOpen(container)}
        >
          Open in {editorName}
        </button>

        {canStop(container.runtime) && (
          <button type="button" disabled={busy} onClick={() => onStop(container)}>
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}

        {canStart(container.runtime) && (
          <button type="button" disabled={busy} onClick={() => onStart(container)}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        )}
      </footer>
    </article>
  );
}
