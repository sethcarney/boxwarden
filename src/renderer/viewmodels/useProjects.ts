import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DevContainer,
  DevContainerProject,
  EditorId,
  ProjectScan,
} from '../../models/index.js';
import { partitionProjects } from '../../models/index.js';
import type { BoxwardenApi, ProjectRootsResult } from '../../shared/ipc.js';
import { summariseProjects } from '../presenters.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

export interface ProjectsViewModel {
  readonly scan: ProjectScan | undefined;
  readonly scanning: boolean;
  /** Projects on disk with no container yet — what the panel is for. */
  readonly unbuilt: readonly DevContainerProject[];
  readonly built: readonly DevContainerProject[];
  /** The one-line summary above the list. */
  readonly summary: string;
  /** The scan hit a bound, so the list may be short. */
  readonly truncated: boolean;
  /** Nothing scanned and nothing in flight — the panel stays out of the way. */
  readonly idle: boolean;
  readonly rescan: () => void;
  readonly addRoot: () => void;
  readonly removeRoot: (root: string) => void;
  readonly openProject: (project: DevContainerProject) => void;
}

/**
 * The filesystem half of the app, on its own cadence.
 *
 * Deliberately NOT folded into the discovery snapshot. That one is polled
 * every five seconds because a container's state changes without anyone
 * asking; a `devcontainer.json` appears when someone clones a repo, which is
 * not worth walking a home directory sixty times an hour to notice. So this
 * runs once on open and whenever the user asks.
 */
export function useProjects(
  api: BoxwardenApi | undefined,
  notices: NoticesViewModel,
  editorId: EditorId,
  containers: readonly DevContainer[],
): ProjectsViewModel {
  const [scan, setScan] = useState<ProjectScan | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const mounted = useMounted();

  const { showThrown, showError, showInfo, showLaunchFailure } = notices;

  const runScan = useCallback(async () => {
    if (api === undefined) return;
    setScanning(true);
    try {
      const next = await api.scanProjects();
      if (mounted.current) setScan(next);
    } catch (error) {
      if (mounted.current) showThrown(error);
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, [api, mounted, showThrown]);

  useEffect(() => {
    // One scan on open, and never on a timer. See the note on the hook.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runScan();
  }, [runScan]);

  /**
   * Add or remove a scan root, then re-read.
   *
   * The main process answers with ok/cancelled and not with the new root list:
   * a changed root list invalidates the projects too, so the rescan has to
   * happen regardless, and returning the roots would only be a second source of
   * truth to keep in step.
   */
  const changeRoots = useCallback(
    (change: () => Promise<ProjectRootsResult>) => {
      void change().then(
        (result) => {
          if (!result.ok) {
            showError(result.message);
            return;
          }
          if (result.cancelled) return;
          void runScan();
        },
        (error: unknown) => {
          showThrown(error);
        },
      );
    },
    [runScan, showError, showThrown],
  );

  const addRoot = useCallback(() => {
    if (api === undefined) return;
    changeRoots(() => api.addProjectRoot());
  }, [api, changeRoots]);

  const removeRoot = useCallback(
    (root: string) => {
      if (api === undefined) return;
      changeRoots(() => api.removeProjectRoot(root));
    },
    [api, changeRoots],
  );

  const openProject = useCallback(
    (project: DevContainerProject) => {
      if (api === undefined) return;
      void api.openProject(project.id, editorId).then(
        (result) => {
          if (result.ok) {
            // Naming the next step matters: the folder opening locally looks
            // like the wrong thing happened unless the user knows the container
            // comes from the editor's own prompt.
            showInfo(
              `Opening ${project.name} — your editor will offer to reopen it in a container.`,
            );
            return;
          }
          showLaunchFailure(
            result.message,
            result.uri === undefined ? undefined : { label: 'Copy URI', value: result.uri },
          );
        },
        (error: unknown) => {
          showThrown(error);
        },
      );
    },
    [api, editorId, showInfo, showLaunchFailure, showThrown],
  );

  /**
   * Partitioning is a pure model function given the two lists, and both change
   * on every poll — `containers` is refreshed every five seconds. Memoising
   * keeps the fold off the render path for the 99% of polls where neither list
   * actually changed.
   */
  const { unbuilt, built } = useMemo(
    () => partitionProjects(scan?.projects ?? [], containers),
    [scan, containers],
  );

  return {
    scan,
    scanning,
    unbuilt,
    built,
    summary: summariseProjects(unbuilt.length, built.length, scanning),
    truncated: scan?.truncated ?? false,
    idle: scan === undefined && !scanning,
    rescan: useCallback(() => void runScan(), [runScan]),
    addRoot,
    removeRoot,
    openProject,
  };
}
