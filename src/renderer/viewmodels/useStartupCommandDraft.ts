import { useCallback, useRef, useState } from 'react';

export interface StartupCommandDraftViewModel {
  /** What the input shows. Controlled either way — '' when no command is set. */
  readonly draft: string;
  readonly onFocus: () => void;
  readonly onChange: (next: string) => void;
  /** Commit, unless the edit was abandoned first. */
  readonly onBlur: () => void;
  /** Throw the edit away. Must be called BEFORE blurring — see the ref below. */
  readonly abandon: () => void;
}

/**
 * The in-progress edit of a container's startup command.
 *
 * ONE INSTANCE PER FIELD, AND THAT IS THE POINT
 *
 * This is a ViewModel hook rather than state in the shared app ViewModel. The
 * draft is where the text cursor is: it lives for as long as one field has
 * focus, and nothing outside that input can act on it. Hoisting it up to
 * `useAppViewModel` would re-render every card on every keystroke to hold a
 * value only one of them can see.
 *
 * It is also not state in the component, which is what `mvvm/no-state-in-view`
 * is there to catch — a View decides nothing, and the commit rules below are
 * decisions. Extracting them here keeps `StartupCommandField.tsx` pure JSX
 * without paying the re-render cost of lifting them any further.
 *
 * Committed on blur or Enter, never per keystroke: the list re-reads from
 * Docker every five seconds and the stored commands come back with it, so a
 * value written back mid-word would fight the cursor — and every character
 * would be its own write to the preferences file.
 *
 * Tested through `components/StartupCommandField.test.tsx` rather than with
 * `renderHook`, and deliberately not in both places. The behaviour that makes
 * the ref below necessary is an ordering between a real blur event and a React
 * re-render, which does not exist without a DOM to blur.
 */
export function useStartupCommandDraft(
  value: string,
  onCommit: (command: string) => void,
): StartupCommandDraftViewModel {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [lastStored, setLastStored] = useState(value);

  /**
   * Accept the stored value whenever it changes underneath: the first load
   * arrives after the first render, and a value cleared elsewhere should show.
   * Skipped while the field has focus, so a poll cannot overwrite typing.
   *
   * Adjusted DURING render rather than in an effect. React re-runs the hook
   * immediately without painting the intermediate state, so there is no flash
   * of the old value and no cascading render — which is what
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
   * Escape has to abandon the edit AND blur, but blurring runs the commit
   * before React has re-rendered with the reset draft — so a `setDraft` there
   * would be read back stale and the abandoned command would save anyway. The
   * ref is visible to `onBlur` in the same tick.
   */
  const abandoned = useRef(false);

  const onFocus = useCallback(() => {
    setEditing(true);
  }, []);

  const onChange = useCallback((next: string) => {
    setDraft(next);
  }, []);

  const abandon = useCallback(() => {
    abandoned.current = true;
  }, []);

  const onBlur = useCallback(() => {
    setEditing(false);
    if (abandoned.current) {
      abandoned.current = false;
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  }, [draft, value, onCommit]);

  return { draft, onFocus, onChange, onBlur, abandon };
}
