/**
 * The ViewModel layer.
 *
 * Everything the Views bind to is exported here: state, derived presentation
 * values, and the commands that change them. No module in this directory
 * imports React DOM or renders JSX — that boundary is what makes the layer
 * testable with `renderHook` against a fake `BoxwardenApi`.
 */

export type { AppViewModel } from './useAppViewModel.js';
export { useAppViewModel } from './useAppViewModel.js';

export type { DiscoveryViewModel } from './useDiscovery.js';
export { REFRESH_INTERVAL_MS, useDiscovery } from './useDiscovery.js';

export type { ProjectsViewModel } from './useProjects.js';
export { useProjects } from './useProjects.js';

export type { EditorsViewModel } from './useEditors.js';
export { useEditors } from './useEditors.js';

export type { TerminalsViewModel } from './useTerminals.js';
export { useTerminals } from './useTerminals.js';

export type { CopyableFallback, Notice, NoticesViewModel } from './useNotices.js';
export { useNotices } from './useNotices.js';

export type { ThemeViewModel } from './useTheme.js';
export { useTheme } from './useTheme.js';

export type { StartupCommandDraftViewModel } from './useStartupCommandDraft.js';
export { useStartupCommandDraft } from './useStartupCommandDraft.js';

export { CLOCK_INTERVAL_MS, useClock } from './useClock.js';
