// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SetupBadge } from '../advisories.js';
import { AppHeader } from './AppHeader.js';
import type { AppPage } from '../viewmodels/index.js';

function renderHeader(
  page: AppPage = 'containers',
  setup: SetupBadge = { count: 0, tone: 'none', title: 'Setup and diagnostics.' },
  onNavigate = vi.fn(),
) {
  render(
    <AppHeader
      engines={undefined}
      selection={undefined}
      engine={undefined}
      pickerDisabled={false}
      page={page}
      setup={setup}
      onNavigate={onNavigate}
      onSelectEngine={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  return onNavigate;
}

describe('AppHeader', () => {
  /**
   * A page you can only reach when something is broken is no use to the user
   * working out why an engine they know is running is missing — and it is
   * where every hidden advisory lives, so it must never be a dead end.
   */
  it('offers the setup page even when nothing is wrong', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Setup' })).toBeDefined();
  });

  it('navigates between the two screens', () => {
    const onNavigate = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('marks which screen is showing, for a reader that cannot see the highlight', () => {
    renderHeader('setup');
    expect(screen.getByRole('button', { name: /Setup/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Containers' }).getAttribute('aria-current')).toBe(
      null,
    );
  });

  it('counts what still needs attention, and says so in words as well', () => {
    renderHeader('containers', {
      count: 2,
      tone: 'warning',
      title: '2 things about this machine’s setup are worth reading.',
    });
    const tab = screen.getByRole('button', { name: /Setup/ });
    expect(tab.textContent).toBe('Setup2');
    expect(tab.getAttribute('title')).toContain('worth reading');
  });

  it('shows no count when nothing is active', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Setup' }).textContent).toBe('Setup');
  });
});
