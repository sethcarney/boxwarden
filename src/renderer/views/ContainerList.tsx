import type {
  ClaudeStatus,
  DevContainer,
  EditorAttachment,
  EditorId,
  GitStatus,
  OpenInEditorMode,
} from '../../models/index.js';
import { ComposeGroup } from '../components/ComposeGroup.js';
import { ContainerCard } from '../components/ContainerCard.js';
import type { ContainerGroup } from '../grouping.js';
import type { LayoutMode } from '../view.js';

interface Props {
  readonly groups: readonly ContainerGroup[];
  readonly layout: LayoutMode;
  readonly editorId: EditorId;
  readonly editorName: string;
  readonly editorAvailable: boolean;
  readonly terminalName: string | undefined;
  readonly terminalAvailable: boolean;
  readonly startupCommandFor: (container: DevContainer) => string;
  readonly now: number;
  readonly isBusy: (id: DevContainer['id']) => boolean;
  readonly isGroupBusy: (group: ContainerGroup) => boolean;
  /** Claude Code presence, looked up per container. Undefined means "no answer yet". */
  readonly claudeFor: (id: DevContainer['id']) => ClaudeStatus | undefined;
  readonly claudeForAll: (
    containers: readonly DevContainer[],
  ) => readonly (ClaudeStatus | undefined)[];
  /** Editor attachment per container, and per group for "Stop all". */
  readonly editorFor: (id: DevContainer['id']) => EditorAttachment | undefined;
  readonly editorsForAll: (
    containers: readonly DevContainer[],
  ) => readonly (EditorAttachment | undefined)[];
  /** The workspace branch, looked up per container. Undefined means "no answer yet". */
  readonly gitFor: (id: DevContainer['id']) => GitStatus | undefined;
  readonly onStart: (container: DevContainer) => void;
  readonly onStop: (container: DevContainer) => void;
  readonly onOpen: (container: DevContainer, mode?: OpenInEditorMode) => void;
  readonly onOpenTerminal: (container: DevContainer) => void;
  readonly onStartupCommandChange: (container: DevContainer, command: string) => void;
  readonly onStartAll: (containers: readonly DevContainer[]) => void;
  readonly onStopAll: (containers: readonly DevContainer[]) => void;
}

/**
 * The grouped card list.
 *
 * The layout is an attribute rather than three sets of components: grid, list
 * and rows are the same cards under different column rules, and forking the
 * markup would mean three places to fix every time a card gains a field.
 */
export function ContainerList({
  groups,
  layout,
  editorId,
  editorName,
  editorAvailable,
  terminalName,
  terminalAvailable,
  startupCommandFor,
  now,
  isBusy,
  isGroupBusy,
  claudeFor,
  claudeForAll,
  editorFor,
  editorsForAll,
  gitFor,
  onStart,
  onStop,
  onOpen,
  onOpenTerminal,
  onStartupCommandChange,
  onStartAll,
  onStopAll,
}: Props) {
  if (groups.length === 0) return null;

  const card = (container: DevContainer) => (
    <ContainerCard
      key={container.id}
      container={container}
      editorId={editorId}
      editorName={editorName}
      editorAvailable={editorAvailable}
      terminalName={terminalName}
      terminalAvailable={terminalAvailable}
      startupCommand={startupCommandFor(container)}
      busy={isBusy(container.id)}
      now={now}
      // Rows mode is one line per container, and "Open in VS Code Insiders"
      // does not fit on it. The full label stays as the button's title.
      dense={layout === 'rows'}
      claude={claudeFor(container.id)}
      editor={editorFor(container.id)}
      git={gitFor(container.id)}
      onStart={onStart}
      onStop={onStop}
      onOpen={onOpen}
      onOpenTerminal={onOpenTerminal}
      onStartupCommandChange={onStartupCommandChange}
    />
  );

  return (
    <div className="list" data-layout={layout}>
      {groups.map((group) => {
        if (group.kind === 'single') return card(group.container);

        return (
          <ComposeGroup
            key={group.key}
            project={group.project}
            containers={group.containers}
            busy={isGroupBusy(group)}
            claude={claudeForAll(group.containers)}
            editors={editorsForAll(group.containers)}
            onStartAll={onStartAll}
            onStopAll={onStopAll}
          >
            {group.containers.map(card)}
          </ComposeGroup>
        );
      })}
    </div>
  );
}
