import { useId, useRef, useState } from 'react';

interface Props {
  /** The stored value. '' when none is set — the input is controlled either way. */
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (command: string) => void;
}

/**
 * The per-container startup command, edited in place.
 *
 * ITS OWN COMPONENT, AND THE ONLY STATEFUL VIEW IN THIS DIRECTORY
 *
 * The draft is not application state. It is where the text cursor is, it lives
 * for as long as the field has focus, and nothing outside this input can act on
 * it. Hoisting it into a ViewModel would re-render every card on every
 * keystroke to hold a value only one of them can see. Keeping it here instead
 * of inside `ContainerCard` is what lets that file stay a pure View with no
 * state and no decisions.
 *
 * Committed on blur or Enter, never per keystroke: the list re-reads from
 * Docker every five seconds and the stored commands come back with it, so a
 * value written back mid-word would fight the cursor — and every character
 * would be its own write to the preferences file.
 */
export function StartupCommandField({ value, disabled, onCommit }: Props) {
  const fieldId = useId();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [lastStored, setLastStored] = useState(value);

  /**
   * Accept the stored value whenever it changes underneath: the first load
   * arrives after the first render, and a value cleared elsewhere should show.
   * Skipped while the field has focus, so a poll cannot overwrite typing.
   *
   * Adjusted DURING render rather than in an effect. React re-runs the
   * component immediately without painting the intermediate state, so there is
   * no flash of the old value and no cascading render — which is what
   * `react-hooks/set-state-in-effect` objects to when this is written the other
   * way. See https://react.dev/reference/react/useState#storing-information-from-previous-renders
   */
  if (!editing && value !== lastStored) {
    setLastStored(value);
    setDraft(value);
  }

  /**
   * A ref, not state, and that is not a style choice.
   *
   * Escape has to abandon the edit AND blur, but blurring runs `commit` before
   * React has re-rendered with the reset draft — so a `setDraft` there would be
   * read back stale and the abandoned command would save anyway. The ref is
   * visible to `commit` in the same tick.
   */
  const abandoned = useRef(false);

  function commit() {
    setEditing(false);
    if (abandoned.current) {
      abandoned.current = false;
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  }

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
          onFocus={() => {
            setEditing(true);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            // Escape abandons the edit rather than committing it: the field is
            // one line and a half-typed command is easy to produce.
            if (event.key === 'Escape') {
              abandoned.current = true;
              event.currentTarget.blur();
            }
          }}
        />
      </dd>
    </>
  );
}
