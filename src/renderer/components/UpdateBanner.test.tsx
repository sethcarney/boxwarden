// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdatePanel } from '../presenters.js';
import { UpdateBanner } from './UpdateBanner.js';

function panel(overrides: Partial<UpdatePanel> = {}): UpdatePanel {
  return {
    headline: 'boxwarden 1.2.0 is available',
    detail: 'You are running 1.1.0.',
    instructions: {
      headline: 'Download the .deb and install it over the top.',
      steps: ['Quit boxwarden first.', 'apt replaces the installed version in place.'],
      commands: ['sudo apt install ./boxwarden_1.2.0_amd64.deb'],
    },
    link: {
      label: 'boxwarden_1.2.0_amd64.deb (91 MB)',
      url: 'https://github.com/sethcarney/boxwarden/releases/download/v1.2.0/boxwarden_1.2.0_amd64.deb',
    },
    releaseUrl: 'https://github.com/sethcarney/boxwarden/releases/tag/v1.2.0',
    ...overrides,
  };
}

/** The two choices the banner reports, when a test does not care which one fired. */
function handlers() {
  return { onDismiss: vi.fn(), onDisable: vi.fn() };
}

describe('UpdateBanner', () => {
  /**
   * The steps are not behind a disclosure any more, and this is the test that
   * says so. They used to be the fallback for a download that refused; now
   * they are the only route, and a route folded away under a `<summary>` is one
   * the user has to think to open.
   */
  it('shows the version, the steps and the command to type, without being opened', () => {
    render(<UpdateBanner panel={panel()} busy={false} {...handlers()} />);

    expect(screen.getByText('boxwarden 1.2.0 is available')).toBeDefined();
    expect(screen.getByText('Download the .deb and install it over the top.')).toBeDefined();
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
    render(<UpdateBanner panel={panel()} busy={false} {...handlers()} />);

    const download = screen.getByRole('link', { name: /boxwarden_1\.2\.0_amd64\.deb/ });
    expect(download.getAttribute('target')).toBe('_blank');
    expect(download.getAttribute('href')).toContain('github.com/sethcarney/boxwarden/releases');
    expect(screen.getByRole('link', { name: 'Release notes' })).toBeDefined();
  });

  /**
   * The one thing this component must never grow back on its own.
   *
   * boxwarden does not fetch or install the artefact — see the note at the top
   * of src/models/update.ts — so every control here is a link out or a
   * preference. A button that read "Install…" would be promising something no
   * verb behind it can do.
   */
  it('offers no button that downloads or installs anything', () => {
    render(<UpdateBanner panel={panel()} busy={false} {...handlers()} />);

    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Copy', 'Not now', 'Stop checking for updates']);
  });

  it('sends the user to the whole release when no single file was identified', () => {
    render(<UpdateBanner panel={panel({ link: undefined })} busy={false} {...handlers()} />);

    expect(screen.queryByRole('link', { name: /^Download/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'All downloads and release notes' })).toBeDefined();
  });

  it('reports both choices to the ViewModel', async () => {
    const spies = handlers();
    render(<UpdateBanner panel={panel()} busy={false} {...spies} />);

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop checking for updates' }));

    expect(spies.onDismiss).toHaveBeenCalledTimes(1);
    expect(spies.onDisable).toHaveBeenCalledTimes(1);
  });

  it('disables the choices while one is in flight', () => {
    render(<UpdateBanner panel={panel()} busy {...handlers()} />);

    expect(screen.getByRole('button', { name: 'Not now' }).hasAttribute('disabled')).toBe(true);
  });
});
