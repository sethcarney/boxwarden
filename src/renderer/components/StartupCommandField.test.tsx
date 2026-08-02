// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StartupCommandField } from './StartupCommandField.js';

function renderField(value = '', disabled = false) {
  const onCommit = vi.fn();
  render(
    <dl>
      <StartupCommandField value={value} disabled={disabled} onCommit={onCommit} />
    </dl>,
  );
  return { onCommit, field: screen.getByLabelText('Startup') };
}

describe('StartupCommandField', () => {
  it('shows the stored command', () => {
    const { field } = renderField('bun run dev');
    expect(field.getAttribute('value')).toBe('bun run dev');
  });

  /**
   * Committed on blur rather than per keystroke: the list re-reads from Docker
   * every five seconds and the stored commands come back with it, so a value
   * written back mid-word would fight the cursor — and each character would be
   * its own write to the preferences file.
   */
  it('does not save while the user is still typing', async () => {
    const { onCommit, field } = renderField();
    await userEvent.type(field, 'make watch');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('saves on Enter', async () => {
    const { onCommit, field } = renderField();
    await userEvent.type(field, 'make watch{Enter}');
    expect(onCommit).toHaveBeenCalledWith('make watch');
  });

  it('saves on blur', async () => {
    const { onCommit, field } = renderField();
    await userEvent.type(field, 'make watch');
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith('make watch');
  });

  it('abandons the edit on Escape', async () => {
    const { onCommit, field } = renderField('bun run dev');
    await userEvent.clear(field);
    await userEvent.type(field, 'rm -rf /{Escape}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.getAttribute('value')).toBe('bun run dev');
  });

  it('saves an emptied field, which is how a command is cleared', async () => {
    const { onCommit, field } = renderField('bun run dev');
    await userEvent.clear(field);
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith('');
  });

  it('does not save when nothing changed', async () => {
    const { onCommit, field } = renderField('bun run dev');
    await userEvent.click(field);
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * The poll would otherwise write the stored value back over a half-typed
   * command every five seconds.
   */
  it('takes a new stored value only while unfocused', async () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <dl>
        <StartupCommandField value="one" disabled={false} onCommit={onCommit} />
      </dl>,
    );
    const field = screen.getByLabelText('Startup');

    rerender(
      <dl>
        <StartupCommandField value="two" disabled={false} onCommit={onCommit} />
      </dl>,
    );
    expect(field.getAttribute('value')).toBe('two');

    await userEvent.click(field);
    await userEvent.type(field, ' edited');
    rerender(
      <dl>
        <StartupCommandField value="three" disabled={false} onCommit={onCommit} />
      </dl>,
    );
    expect(field.getAttribute('value')).toBe('two edited');
  });
});
