import { useCallback, useMemo, useState } from 'react';
import type { DevContainer, DevContainerProject, ProjectScan } from '../../models/index.js';
import { partitionProjects } from '../../models/index.js';
import { devcontainerUpCommand, hostPathLabel, relativeTime } from '../format.js';

/**
 * The projects that are on disk and not in Docker.
 *
 * WHY THIS PANEL EXISTS
 *
 * Every other surface in this app is a view of the Docker daemon, and a dev
 * container only appears there once it has been built at least once. That makes
 * boxwarden useless in the situation it is most obviously wanted for: a machine
 * with fifteen repos cloned and nothing built, where the honest report is "no
 * dev containers found" and the useful one is "here are fifteen you could
 * build".
 *
 * The panel stops at OFFERING. Opening the folder in an editor is a real
 * action, because the editor's own "Reopen in Container" prompt is the
 * supported path and the user stays in control of it. Building from here is
 * not, and the copy button exists instead — see `devcontainerUpCommand`.
 */

const COLLAPSED_LIMIT = 6;

interface Props {
  /** Undefined until the first scan returns. */
  readonly scan: ProjectScan | undefined;
  /** The live list, used to hide projects that are already built. */
  readonly containers: readonly DevContainer[];
  readonly editorName: string;
  readonly editorAvailable: boolean;
  readonly scanning: boolean;
  readonly now: number;
  readonly onOpen: (project: DevContainerProject) => void;
  readonly onRescan: () => void;
  readonly onAddRoot: () => void;
  readonly onRemoveRoot: (root: string) => void;
}

export function UnbuiltProjects({
  scan,
  containers,
  editorName,
  editorAvailable,
  scanning,
  now,
  onOpen,
  onRescan,
  onAddRoot,
  onRemoveRoot,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  /**
   * Partitioning is a pure domain function given the two lists, and both change
   * on every poll — `containers` is refreshed every five seconds. Memoising
   * keeps the fold off the render path for the 99% of polls where neither list
   * actually changed.
   */
  const { unbuilt, built } = useMemo(
    () => partitionProjects(scan?.projects ?? [], containers),
    [scan, containers],
  );

  // Nothing has been scanned yet and nothing is in flight: stay out of the way
  // rather than rendering an empty frame that explains nothing.
  if (scan === undefined && !scanning) return null;

  const visible = expanded ? unbuilt : unbuilt.slice(0, COLLAPSED_LIMIT);
  const hidden = unbuilt.length - visible.length;

  return (
    <section className="panel projects" aria-label="Dev container projects not built yet">
      <header className="projects-head">
        <h2>Not built yet</h2>
        <button type="button" className="link" disabled={scanning} onClick={onRescan}>
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </header>

      <p className="lede">{summarise(unbuilt.length, built.length, scanning)}</p>

      {scan?.truncated === true && (
        <p className="note">
          The scan stopped early, so this list may be short. Narrow it by adding the folder your
          projects are actually in — a specific root is scanned far faster than a whole home
          directory.
        </p>
      )}

      {visible.length > 0 && (
        <ul className="project-list">
          {visible.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              editorName={editorName}
              editorAvailable={editorAvailable}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <button
          type="button"
          className="link"
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show {hidden} more
        </button>
      )}

      <ScanRoots scan={scan} now={now} onAddRoot={onAddRoot} onRemoveRoot={onRemoveRoot} />
    </section>
  );
}

/**
 * The one-line summary above the list.
 *
 * The "all built" case gets its own sentence rather than falling through to an
 * empty list, because the two are indistinguishable on screen and mean opposite
 * things: one says boxwarden looked and found nothing to do, the other says it
 * has not looked anywhere useful.
 */
function summarise(unbuilt: number, built: number, scanning: boolean): string {
  if (unbuilt === 0 && built === 0) {
    return scanning
      ? 'Looking for devcontainer.json files on this machine…'
      : 'No devcontainer.json files were found in the folders below.';
  }
  if (unbuilt === 0) {
    return `Every dev container project found on disk (${built}) has been built — they are in the list above.`;
  }
  const suffix =
    built === 0 ? '' : ` A further ${built} ${built === 1 ? 'is' : 'are'} already built.`;
  return `${unbuilt} folder${unbuilt === 1 ? '' : 's'} on this machine ${unbuilt === 1 ? 'has' : 'have'} a devcontainer.json and no container yet.${suffix}`;
}

function ProjectRow({
  project,
  editorName,
  editorAvailable,
  onOpen,
}: {
  readonly project: DevContainerProject;
  readonly editorName: string;
  readonly editorAvailable: boolean;
  readonly onOpen: (project: DevContainerProject) => void;
}) {
  const [copied, setCopied] = useState(false);
  const command = devcontainerUpCommand(project);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      },
      () => setCopied(false),
    );
  }, [command]);

  return (
    <li className="project">
      <div className="project-title">
        <h3>{project.name}</h3>
        {project.variant !== undefined && <span className="tag">{project.variant}</span>}
      </div>

      <p className="project-path" title={hostPathLabel(project.folder)}>
        {hostPathLabel(project.folder)}
        <span className="hint"> · {project.configLabel}</span>
      </p>

      <div className="project-actions">
        <button
          type="button"
          className="primary"
          disabled={!editorAvailable}
          title={
            editorAvailable
              ? `Opens the folder in ${editorName}, which then offers “Reopen in Container”.`
              : `${editorName} was not found on this machine.`
          }
          onClick={() => {
            onOpen(project);
          }}
        >
          Open in {editorName}
        </button>
        <button type="button" className="link" title={command} onClick={copy}>
          {copied ? 'Copied' : 'Copy devcontainer up'}
        </button>
      </div>
    </li>
  );
}

/**
 * Where boxwarden looked, and the controls to change it.
 *
 * Shown even when the scan succeeded. The defaults cover a home directory three
 * levels deep and nothing else, so a user whose code lives on `/mnt/d` or
 * `~/very/deep/nesting` gets an empty list with no indication that the fix is a
 * button away — and "it found nothing, so it must not work" is where that user
 * stops.
 */
function ScanRoots({
  scan,
  now,
  onAddRoot,
  onRemoveRoot,
}: {
  readonly scan: ProjectScan | undefined;
  readonly now: number;
  readonly onAddRoot: () => void;
  readonly onRemoveRoot: (root: string) => void;
}) {
  return (
    <div className="scan-roots">
      <span className="scan-roots-label">Looking in</span>

      <ul>
        {(scan?.roots ?? []).map((root) => (
          <li key={root.path} className={root.failure === undefined ? undefined : 'unresolved'}>
            <code title={root.path}>{root.path}</code>
            <span className="hint">
              {root.failure === 'missing'
                ? ' — no such folder'
                : root.failure === 'unreadable'
                  ? ` — unreadable${root.detail === undefined ? '' : `: ${root.detail}`}`
                  : ` — ${root.found} found`}
            </span>
            <button
              type="button"
              className="link"
              aria-label={`Stop scanning ${root.path}`}
              onClick={() => {
                onRemoveRoot(root.path);
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="scan-roots-actions">
        <button type="button" onClick={onAddRoot}>
          Add folder…
        </button>
        {scan !== undefined && (
          <span className="hint">
            scanned {relativeTime(scan.scannedAt, now)} in {scan.elapsedMs}ms
          </span>
        )}
      </div>
    </div>
  );
}
