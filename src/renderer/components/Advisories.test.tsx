// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
   */
  it('never offers to run a command for the user', () => {
    render(<Advisories advice={[advice()]} />);
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Copy']);
  });
});
