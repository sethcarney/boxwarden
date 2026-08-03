// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Advice } from '../../models/index.js';
import { Advisories } from './Advisories.js';

function advice(overrides: Partial<Advice> = {}): Advice {
  return {
    id: 'wsl-not-installed',
    severity: 'error',
    title: 'WSL is not installed',
    body: 'Dev containers are Linux containers.',
    commands: ['wsl --install'],
    links: [
      { label: 'Install WSL (Microsoft)', url: 'https://learn.microsoft.com/windows/wsl/install' },
    ],
    ...overrides,
  };
}

describe('Advisories', () => {
  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<Advisories advice={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the fix, not only the problem', () => {
    render(<Advisories advice={[advice()]} />);
    expect(screen.getByText('WSL is not installed')).toBeDefined();
    expect(screen.getByText('wsl --install')).toBeDefined();
  });

  /**
   * Severity is carried by colour, and colour alone is not a distinction every
   * user can make. The badge is the text that says the same thing.
   */
  it('states the severity in words as well as in colour', () => {
    render(
      <Advisories
        advice={[
          advice({ id: 'a', severity: 'error' }),
          advice({ id: 'b', severity: 'warning' }),
          advice({ id: 'c', severity: 'info' }),
        ]}
      />,
    );
    expect(screen.getByText('Blocking')).toBeDefined();
    expect(screen.getByText('Warning')).toBeDefined();
    expect(screen.getByText('Note')).toBeDefined();
  });

  /**
   * target="_blank" is what routes a link through the main process's
   * setWindowOpenHandler and out to the system browser. Without it the
   * will-navigate handler blocks the click and the link silently does nothing,
   * which is a hard failure to notice by eye — hence a test.
   */
  it('opens documentation links out of the app, never inside it', () => {
    render(<Advisories advice={[advice()]} />);
    const link = screen.getByText('Install WSL (Microsoft)');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe('https://learn.microsoft.com/windows/wsl/install');
  });

  it('offers no copy button when there is nothing to type', () => {
    render(<Advisories advice={[advice({ commands: [] })]} />);
    expect(screen.queryByText('Copy')).toBeNull();
  });

  /**
   * boxwarden shows commands and does not run them. These reboot machines,
   * install system components and use sudo; an app that fires them from a
   * button press is not one to trust with a Docker socket.
   *
   * Pinned as the exact list rather than "no button says Run", so that a
   * future control added next to a command has to be looked at.
   */
  it('never offers to run a command for the user', () => {
    render(<Advisories advice={[advice()]} onHide={vi.fn()} />);
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['WSL is not installed', 'Hide', 'Copy']);
  });

  describe('collapsing', () => {
    /**
     * A blocking error is why the user is looking at this window; folding it
     * shut would put the fix behind a click. A note is true, worth having, and
     * not why anyone opened the app.
     */
    it('opens what is blocking and folds away what is merely a note', () => {
      render(
        <Advisories
          advice={[
            advice({ id: 'a', severity: 'error', body: 'The blocking body.' }),
            advice({ id: 'b', severity: 'info', body: 'The note body.' }),
          ]}
        />,
      );
      expect(screen.getByText('The blocking body.')).toBeDefined();
      expect(screen.queryByText('The note body.')).toBeNull();
    });

    it('shows a folded body when the title is clicked, and folds it back', () => {
      render(<Advisories advice={[advice({ severity: 'info', body: 'The note body.' })]} />);
      const toggle = screen.getByRole('button', { name: 'WSL is not installed' });

      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(screen.getByText('The note body.')).toBeDefined();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(toggle);
      expect(screen.queryByText('The note body.')).toBeNull();
    });

    /**
     * Unmounted, not hidden with CSS. A collapsed advisory whose three copy
     * buttons were still in the tab order would let a keyboard user land on
     * controls nobody can see.
     */
    it('takes a folded advisory’s controls out of the tab order entirely', () => {
      render(<Advisories advice={[advice({ severity: 'info' })]} />);
      expect(screen.queryByText('Copy')).toBeNull();
      expect(screen.queryByText('Install WSL (Microsoft)')).toBeNull();
    });
  });

  describe('hiding', () => {
    /**
     * Hiding is only offered where the advisory survives it. The main screen
     * passes `onHide` because the setup page is the other copy; the setup
     * page's own hidden list passes `onRestore` instead.
     */
    it('offers no way to hide unless the caller says there is somewhere else to read it', () => {
      render(<Advisories advice={[advice()]} />);
      expect(screen.queryByText('Hide')).toBeNull();
      expect(screen.queryByText('Show again')).toBeNull();
    });

    it('reports the id of the advisory the user put away', () => {
      const onHide = vi.fn();
      render(<Advisories advice={[advice({ id: 'docker-cli-missing' })]} onHide={onHide} />);
      fireEvent.click(screen.getByText('Hide'));
      expect(onHide).toHaveBeenCalledWith('docker-cli-missing');
    });

    it('offers to put a hidden advisory back', () => {
      const onRestore = vi.fn();
      render(<Advisories advice={[advice({ id: 'wsl-socat-missing' })]} onRestore={onRestore} />);
      fireEvent.click(screen.getByText('Show again'));
      expect(onRestore).toHaveBeenCalledWith('wsl-socat-missing');
    });

    /**
     * Two lists of advice on one page (active and hidden) are two regions, and
     * a screen reader user needs them told apart.
     */
    it('takes a name for the region so two lists can share a page', () => {
      render(<Advisories advice={[advice()]} label="Advice hidden from the main screen" />);
      expect(screen.getByLabelText('Advice hidden from the main screen')).toBeDefined();
    });
  });
});
