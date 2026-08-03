// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdatePanel } from '../presenters.js';
import { UpdateBanner } from './UpdateBanner.js';

function panel(overrides: Partial<UpdatePanel> = {}): UpdatePanel {
  return {
    headline: 'boxwarden 1.2.0 is available',
    detail: 'You are running 1.1.0. boxwarden does not update itself.',
    instructions: {
      headline: 'Download the .deb and install it over the top.',
      steps: ['Quit boxwarden first.', 'apt replaces the installed version in place.'],
      commands: ['sudo apt install ./boxwarden_1.2.0_amd64.deb'],
    },
    download: {
      label: 'boxwarden_1.2.0_amd64.deb (91 MB)',
      url: 'https://github.com/sethcarney/boxwarden/releases/download/v1.2.0/boxwarden_1.2.0_amd64.deb',
    },
    releaseUrl: 'https://github.com/sethcarney/boxwarden/releases/tag/v1.2.0',
    ...overrides,
  };
}

describe('UpdateBanner', () => {
  it('shows the version, the steps and the command to type', () => {
    render(<UpdateBanner panel={panel()} busy={false} onDismiss={vi.fn()} onDisable={vi.fn()} />);

    expect(screen.getByText('boxwarden 1.2.0 is available')).toBeDefined();
    expect(screen.getByText('Quit boxwarden first.')).toBeDefined();
    expect(screen.getByText('sudo apt install ./boxwarden_1.2.0_amd64.deb')).toBeDefined();
  });

  /**
   * The links have to be `target="_blank"`: that is what routes them through
   * the main process's window-open handler and into the system browser. A
   * same-window navigation is blocked outright, so a link without it renders
   * and does nothing.
   */
  it('opens the download and the release notes outside the app', () => {
    render(<UpdateBanner panel={panel()} busy={false} onDismiss={vi.fn()} onDisable={vi.fn()} />);

    const download = screen.getByRole('link', { name: /boxwarden_1\.2\.0_amd64\.deb/ });
    expect(download.getAttribute('target')).toBe('_blank');
    expect(download.getAttribute('href')).toContain('github.com/sethcarney/boxwarden/releases');
    expect(screen.getByRole('link', { name: 'Release notes' })).toBeDefined();
  });

  it('sends the user to the whole release when no single file was identified', () => {
    render(
      <UpdateBanner
        panel={panel({ download: undefined })}
        busy={false}
        onDismiss={vi.fn()}
        onDisable={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'All downloads and release notes' })).toBeDefined();
  });

  /**
   * There is no Install button, and there must not be one: the builds are
   * unsigned, so the app cannot verify what it would be replacing itself with.
   */
  it('offers no button that installs anything', () => {
    render(<UpdateBanner panel={panel()} busy={false} onDismiss={vi.fn()} onDisable={vi.fn()} />);

    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Copy', 'Not now', 'Stop checking for updates']);
  });

  it('reports both choices to the ViewModel', async () => {
    const onDismiss = vi.fn();
    const onDisable = vi.fn();
    render(
      <UpdateBanner panel={panel()} busy={false} onDismiss={onDismiss} onDisable={onDisable} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop checking for updates' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDisable).toHaveBeenCalledTimes(1);
  });

  it('disables the choices while one is in flight', () => {
    render(<UpdateBanner panel={panel()} busy onDismiss={vi.fn()} onDisable={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Not now' }).hasAttribute('disabled')).toBe(true);
  });
});
