import type { DevContainer, EditorId } from '../../models/index.js';
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
  readonly now: number;
  readonly isBusy: (id: DevContainer['id']) => boolean;
  readonly isGroupBusy: (group: ContainerGroup) => boolean;
  readonly onStart: (container: DevContainer) => void;
  readonly onStop: (container: DevContainer) => void;
  readonly onOpen: (container: DevContainer) => void;
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
  now,
  isBusy,
  isGroupBusy,
  onStart,
  onStop,
  onOpen,
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
      busy={isBusy(container.id)}
      now={now}
      // Rows mode is one line per container, and "Open in VS Code Insiders"
      // does not fit on it. The full label stays as the button's title.
      dense={layout === 'rows'}
      onStart={onStart}
      onStop={onStop}
      onOpen={onOpen}
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
