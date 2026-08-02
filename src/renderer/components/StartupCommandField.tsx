import { useId } from 'react';
import { useStartupCommandDraft } from '../viewmodels/useStartupCommandDraft.js';

interface Props {
  /** The stored value. '' when none is set — the input is controlled either way. */
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (command: string) => void;
}

/**
 * The per-container startup command, edited in place.
 *
 * A View: it renders the field and forwards events, and every rule about when
 * an edit is kept or thrown away lives in `useStartupCommandDraft`. `useId` is
 * the one hook left here, and it holds no state — it exists to tie the label to
 * the input, which is a fact about this markup and nothing else.
 *
 * Its own component rather than markup inside `ContainerCard` so that card can
 * stay a View with no hooks at all.
 */
export function StartupCommandField({ value, disabled, onCommit }: Props) {
  const fieldId = useId();
  const { draft, onFocus, onChange, onBlur, abandon } = useStartupCommandDraft(value, onCommit);

  return (
    <>
      <dt className="meta-startup">
        <label htmlFor={fieldId}>Startup</label>
      </dt>
      <dd className="meta-startup">
        <input
          id={fieldId}
          className="startup-command"
          type="text"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          value={draft}
          placeholder="Command to run when a terminal opens"
          title="Runs inside the container each time you open a terminal, before the interactive shell. Stored against the host folder, so it survives a rebuild."
          onFocus={onFocus}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            // Escape abandons the edit rather than committing it: the field is
            // one line and a half-typed command is easy to produce. `abandon`
            // must run before the blur, which is what commits.
            if (event.key === 'Escape') {
              abandon();
              event.currentTarget.blur();
            }
          }}
        />
      </dd>
    </>
  );
}
