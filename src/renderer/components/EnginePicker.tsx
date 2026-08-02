import type { EngineSelection, EngineSummary } from '../../models/index.js';
import { engineOptionLabel } from '../format.js';

/**
 * Which engine to use, when more than one answered.
 *
 * Hidden entirely below two engines. A picker with one option is furniture: it
 * cannot change anything, and it takes header space from the status chip, which
 * can. It reappears the moment a second engine shows up, which is also the
 * moment it starts to matter.
 *
 * The "all" option is first and is the default — see src/domain/engine.ts for
 * why unioning the engines is the right behaviour to start from.
 */

/** The `<option>` value for the union. Not a valid EngineId, so it cannot collide with one. */
const ALL_VALUE = '*all*';

export function EnginePicker({
  engines,
  selection,
  disabled,
  onChange,
}: {
  readonly engines: readonly EngineSummary[];
  readonly selection: EngineSelection;
  readonly disabled: boolean;
  readonly onChange: (selection: EngineSelection) => void;
}) {
  // A selection naming an engine that is not answering still has to be
  // representable, or the <select> would silently snap back to "All engines"
  // and quietly change what the user asked for. The stale id is offered as a
  // disabled option instead, and the `selected-engine-unreachable` advisory
  // explains it.
  const stale =
    selection.kind === 'only' && !engines.some((engine) => engine.id === selection.id)
      ? selection.id
      : undefined;

  if (engines.length < 2 && stale === undefined) return null;

  return (
    <label className="engine-picker">
      Engine
      <select
        value={selection.kind === 'all' ? ALL_VALUE : selection.id}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          onChange(
            value === ALL_VALUE
              ? { kind: 'all' }
              : { kind: 'only', id: value as EngineSummary['id'] },
          );
        }}
      >
        <option value={ALL_VALUE}>
          All engines{engines.length > 1 ? ` (${String(engines.length)})` : ''}
        </option>
        {engines.map((engine) => (
          <option key={engine.id} value={engine.id}>
            {engineOptionLabel(engine)}
          </option>
        ))}
        {stale !== undefined && (
          <option value={stale} disabled>
            {stale} (not answering)
          </option>
        )}
      </select>
    </label>
  );
}
