import { useState } from 'react';
import type { DevContainerProject, ProjectScan } from '../../models/index.js';
import { devcontainerUpCommand, hostPathLabel, relativeTime } from '../format.js';
import { scanRootHint } from '../presenters.js';
import type { ProjectsViewModel } from '../viewmodels/index.js';
import { useCopyToClipboard } from '../viewmodels/useCopyToClipboard.js';

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
 *
 * A View: it binds to `ProjectsViewModel` and computes nothing. The partition,
 * the summary sentence and the scan state all arrive already derived.
 */

const COLLAPSED_LIMIT = 6;

interface Props {
  readonly projects: ProjectsViewModel;
  readonly editorName: string;
  readonly editorAvailable: boolean;
  readonly now: number;
}

export function UnbuiltProjects({ projects, editorName, editorAvailable, now }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Nothing has been scanned yet and nothing is in flight: stay out of the way
  // rather than rendering an empty frame that explains nothing.
  if (projects.idle) return null;

  const visible = expanded ? projects.unbuilt : projects.unbuilt.slice(0, COLLAPSED_LIMIT);
  const hidden = projects.unbuilt.length - visible.length;

  return (
    <section className="panel projects" aria-label="Dev container projects not built yet">
      <header className="projects-head">
        <h2>Not built yet</h2>
        <button
          type="button"
          className="link"
          disabled={projects.scanning}
          onClick={projects.rescan}
        >
          {projects.scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </header>

      <p className="lede">{projects.summary}</p>

      {projects.truncated && (
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
              onOpen={projects.openProject}
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

      <ScanRoots
        scan={projects.scan}
        now={now}
        onAddRoot={projects.addRoot}
        onRemoveRoot={projects.removeRoot}
      />
    </section>
  );
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
  const clipboard = useCopyToClipboard();
  const command = devcontainerUpCommand(project);

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
        <button
          type="button"
          className="link"
          title={command}
          onClick={() => {
            clipboard.copy(command);
          }}
        >
          {clipboard.copied ? 'Copied' : 'Copy devcontainer up'}
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
            <span className="hint"> — {scanRootHint(root.failure, root.found, root.detail)}</span>
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
