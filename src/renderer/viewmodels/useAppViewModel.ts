import { useMemo } from 'react';
import type { Advice } from '../../models/index.js';
import { getApi } from '../api.js';
import type { AdvisoriesViewModel } from './useAdvisories.js';
import { useAdvisories } from './useAdvisories.js';
import type { BranchesViewModel } from './useBranches.js';
import { useBranches } from './useBranches.js';
import type { ActivityViewModel } from './useContainerActivity.js';
import { useContainerActivity } from './useContainerActivity.js';
import { useClock } from './useClock.js';
import type { DiscoveryViewModel } from './useDiscovery.js';
import { useDiscovery } from './useDiscovery.js';
import type { EditorsViewModel } from './useEditors.js';
import { useEditors } from './useEditors.js';
import type { GitViewModel } from './useGitStatus.js';
import { useGitStatus } from './useGitStatus.js';
import type { NoticesViewModel } from './useNotices.js';
import { useNotices } from './useNotices.js';
import type { ProjectsViewModel } from './useProjects.js';
import { useProjects } from './useProjects.js';
import type { TerminalsViewModel } from './useTerminals.js';
import { useTerminals } from './useTerminals.js';
import type { ThemeViewModel } from './useTheme.js';
import { useTheme } from './useTheme.js';
import type { UpdateViewModel } from './useUpdate.js';
import { useUpdate } from './useUpdate.js';

/** Stable identity for "no advice yet", so the partition below memoises. */
const EMPTY_ADVICE: readonly Advice[] = [];

export interface AppViewModel {
  /**
   * False when `window.boxwarden` is missing, which means the preload script
   * failed to load. The View shows a specific build-error screen for it rather
   * than an empty container list, which is what it would otherwise look like.
   */
  readonly bridgeAvailable: boolean;
  readonly now: number;
  readonly notices: NoticesViewModel;
  readonly theme: ThemeViewModel;
  readonly editors: EditorsViewModel;
  readonly terminals: TerminalsViewModel;
  readonly discovery: DiscoveryViewModel;
  readonly projects: ProjectsViewModel;
  /** What is running inside each container — a Claude session, an attached editor. */
  readonly activity: ActivityViewModel;
  /** Which branch each container's workspace folder is on. */
  readonly git: GitViewModel;
  /** The open branch menu, and switching. Separate from `git` because that one is a poll. */
  readonly branches: BranchesViewModel;
  /** The setup advice, what the user has hidden of it, and which screen is showing. */
  readonly advisories: AdvisoriesViewModel;
  readonly update: UpdateViewModel;
}

/**
 * The root ViewModel: every piece of state the app renders, and every action it
 * can take, with no JSX anywhere beneath it.
 *
 * Composition rather than one large hook, because the eleven below have genuinely
 * different lifetimes — Docker is polled every five seconds, Claude Code
 * presence every fifteen, the workspace branches every thirty, GitHub is asked
 * about a new release once a day, the filesystem is scanned on demand, the
 * editor and terminal lists are read once, and the theme and the hidden advice
 * never touch the bridge at all.
 * Keeping them separate is what lets each be tested against a fake
 * `BoxwardenApi` without standing up the others.
 *
 * Every hook is called unconditionally and guards on `api` internally: a bridge
 * that failed to load must not change the number of hooks this runs.
 */
export function useAppViewModel(): AppViewModel {
  const api = useMemo(() => getApi(), []);

  const now = useClock();
  const notices = useNotices();
  const theme = useTheme();
  const editors = useEditors(api);
  // Before discovery, which needs the chosen terminal the same way it needs the
  // chosen editor.
  const terminals = useTerminals(api, notices);
  const discovery = useDiscovery(api, notices, editors.editorId, terminals.terminalId);
  const projects = useProjects(api, notices, editors.editorId, discovery.containers);
  const activity = useContainerActivity(api, notices, discovery.containers);
  const git = useGitStatus(api, notices, discovery.containers);
  // After the poll it refreshes. `git.refresh` is stable, so passing it here
  // does not restart anything — and it is the whole join between the two: a
  // switch that landed re-reads the chip immediately rather than leaving it
  // wrong for up to thirty seconds.
  const branches = useBranches(api, notices, git.refresh);
  // After discovery, which is where the advice comes from. `EMPTY_ADVICE` and
  // not a literal `[]`: the partition memoises on the array's identity, and a
  // fresh empty array every render would recompute it on every poll.
  const advisories = useAdvisories(discovery.snapshot?.advice ?? EMPTY_ADVICE);
  // Takes `now` rather than reading the clock, so "published 2 days ago" ages
  // on the same tick every other relative time in the app does.
  const update = useUpdate(api, now);

  return {
    bridgeAvailable: api !== undefined,
    now,
    notices,
    theme,
    editors,
    terminals,
    discovery,
    projects,
    activity,
    git,
    branches,
    advisories,
    update,
  };
}
