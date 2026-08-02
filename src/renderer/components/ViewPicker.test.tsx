// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_VIEW } from '../view.js';
import { ViewPicker } from './ViewPicker.js';

describe('ViewPicker', () => {
  it('marks the current layout as pressed and the others as not', () => {
    render(<ViewPicker view={{ layout: 'rows', theme: 'dark' }} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Rows' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * Both controls report the WHOLE preference object. Sending only the changed
   * field would make the parent responsible for merging, and a parent that
   * forgot would reset the other setting on every click.
   */
  it('reports a layout change without disturbing the theme', async () => {
    const onChange = vi.fn();
    render(<ViewPicker view={{ layout: 'grid', theme: 'light' }} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rows' }));
    expect(onChange).toHaveBeenCalledWith({ layout: 'rows', theme: 'light' });
  });

  it('reports a theme change without disturbing the layout', async () => {
    const onChange = vi.fn();
    render(<ViewPicker view={{ layout: 'rows', theme: 'dark' }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByRole('combobox'), 'auto');
    expect(onChange).toHaveBeenCalledWith({ layout: 'rows', theme: 'auto' });
  });

  /** Every layout is reachable, including the default. */
  it('offers all three layouts', () => {
    render(<ViewPicker view={DEFAULT_VIEW} onChange={vi.fn()} />);

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .sort();
    expect(labels).toEqual(['Grid', 'List', 'Rows']);
  });
});
