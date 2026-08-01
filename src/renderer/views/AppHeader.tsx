import type { EngineSelection, EngineSummary } from '../../models/index.js';
import { EnginePicker } from '../components/EnginePicker.js';
import type { EngineChip } from '../presenters.js';

interface Props {
  /** Undefined until the first reading arrives; the picker and chip wait for it. */
  readonly engines: readonly EngineSummary[] | undefined;
  readonly selection: EngineSelection | undefined;
  readonly engine: EngineChip | undefined;
  readonly pickerDisabled: boolean;
  readonly onSelectEngine: (selection: EngineSelection) => void;
  readonly onRefresh: () => void;
}

export function AppHeader({
  engines,
  selection,
  engine,
  pickerDisabled,
  onSelectEngine,
  onRefresh,
}: Props) {
  return (
    <header className="app-head">
      <h1>boxwarden</h1>
      <div className="head-right">
        {engines !== undefined && selection !== undefined && (
          <EnginePicker
            engines={engines}
            selection={selection}
            disabled={pickerDisabled}
            onChange={onSelectEngine}
          />
        )}
        {engine !== undefined && (
          <span className={`chip ${engine.ok ? 'chip-ok' : 'chip-fail'}`} title={engine.title}>
            {engine.label}
          </span>
        )}
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </header>
  );
}
