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
    fetch: { kind: 'offer', label: 'Download boxwarden_1.2.0_amd64.deb (91 MB)' },
    releaseUrl: 'https://github.com/sethcarney/boxwarden/releases/tag/v1.2.0',
    ...overrides,
  };
}

/** The three download handlers, when a test does not care which one fired. */
function handlers() {
  return {
    onDismiss: vi.fn(),
    onDisable: vi.fn(),
    onDownload: vi.fn(),
    onCancelDownload: vi.fn(),
    onInstall: vi.fn(),
  };
}

describe('UpdateBanner', () => {
  it('shows the version, the steps and the command to type', () => {
    render(<UpdateBanner panel={panel()} busy={false} {...handlers()} />);

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
  it('opens the manual download and the release notes outside the app', () => {
    render(<UpdateBanner panel={panel()} busy={false} {...handlers()} />);

    const download = screen.getByRole('link', { name: /boxwarden_1\.2\.0_amd64\.deb/ });
    expect(download.getAttribute('target')).toBe('_blank');
    expect(download.getAttribute('href')).toContain('github.com/sethcarney/boxwarden/releases');
    expect(screen.getByRole('link', { name: 'Release notes' })).toBeDefined();
  });

  it('sends the user to the whole release when no single file was identified', () => {
    render(
      <UpdateBanner
        panel={panel({ link: undefined, fetch: { kind: 'unavailable' } })}
        busy={false}
        {...handlers()}
      />,
    );

    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'All downloads and release notes' })).toBeDefined();
  });

  it('asks the ViewModel to fetch when the download is offered', async () => {
    const spies = handlers();
    render(<UpdateBanner panel={panel()} busy={false} {...spies} />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Download boxwarden_1.2.0_amd64.deb (91 MB)' }),
    );
    expect(spies.onDownload).toHaveBeenCalledTimes(1);
  });

  it('shows progress and a way out while bytes are arriving', async () => {
    const spies = handlers();
    render(
      <UpdateBanner
        panel={panel({ fetch: { kind: 'progress', label: '12.0 MB of 91.0 MB', percent: 13 } })}
        busy={false}
        {...spies}
      />,
    );

    expect(screen.getByText('12.0 MB of 91.0 MB')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(spies.onCancelDownload).toHaveBeenCalledTimes(1);
  });

  /**
   * The invariant this whole feature rests on.
   *
   * `verifying` is the window in which the complete file is sitting on disk
   * and nothing has yet vouched for it. A file boxwarden downloaded itself
   * carries no quarantine attribute, so the operating system will not
   * second-guess an install — which makes an Install button rendered one state
   * early the only gate that ever mattered, missing.
   */
  it('offers nothing to install while the download is still being verified', () => {
    render(
      <UpdateBanner
        panel={panel({ fetch: { kind: 'verifying', label: 'Checking the signature…' } })}
        busy={false}
        {...handlers()}
      />,
    );

    expect(screen.getByText('Checking the signature…')).toBeDefined();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).not.toContain('Install boxwarden_1.2.0_amd64.deb');
  });

  it('offers the install only once the file is verified, and says what was checked', async () => {
    const spies = handlers();
    render(
      <UpdateBanner
        panel={panel({
          fetch: {
            kind: 'ready',
            label: 'Install boxwarden_1.2.0_amd64.deb',
            detail: 'Verified against this release’s checksums and its Sigstore signature.',
          },
        })}
        busy={false}
        {...spies}
      />,
    );

    expect(screen.getByText(/Verified against this release/)).toBeDefined();
    await userEvent.click(
      screen.getByRole('button', { name: 'Install boxwarden_1.2.0_amd64.deb' }),
    );
    expect(spies.onInstall).toHaveBeenCalledTimes(1);
  });

  /**
   * A refusal is not a dead end. Every arm of `planDownload`'s refusal — no
   * signature, an ambiguous artefact, a filename that will not be written —
   * still leaves the browser link on screen, which is the route that always
   * works.
   */
  it('reports a refusal and leaves the manual route in place', () => {
    render(
      <UpdateBanner
        panel={panel({
          fetch: { kind: 'failed', message: 'This release has no signature for it.' },
        })}
        busy={false}
        {...handlers()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toBe('This release has no signature for it.');
    expect(screen.getByRole('link', { name: /boxwarden_1\.2\.0_amd64\.deb/ })).toBeDefined();
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
