import { useMemo } from 'react';
import { getApi } from '../api.js';
import type { ClaudeViewModel } from './useClaudeStatus.js';
import { useClaudeStatus } from './useClaudeStatus.js';
import { useClock } from './useClock.js';
import type { DiscoveryViewModel } from './useDiscovery.js';
import { useDiscovery } from './useDiscovery.js';
import type { EditorsViewModel } from './useEditors.js';
import { useEditors } from './useEditors.js';
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
  readonly claude: ClaudeViewModel;
  readonly update: UpdateViewModel;
}

/**
 * The root ViewModel: every piece of state the app renders, and every action it
 * can take, with no JSX anywhere beneath it.
 *
 * Composition rather than one large hook, because the eight below have
 * genuinely different lifetimes — Docker is polled every five seconds, Claude
 * Code presence every fifteen, GitHub is asked about a new release once a day,
 * the filesystem is scanned on demand, the editor and terminal lists are read
 * once, and the theme never touches the bridge at
 * all. Keeping them separate is what lets each be tested against a fake
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
  const claude = useClaudeStatus(api, notices, discovery.containers);
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
    claude,
    update,
  };
}
