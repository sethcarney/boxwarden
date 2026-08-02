// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContainerCard } from './ContainerCard.js';
import { devContainer, unresolvedContainer } from '../test-fixtures.js';
import type { DevContainer } from '../../models/index.js';
import { asContainerPath } from '../../models/index.js';

const NOW = new Date('2026-07-27T12:00:00Z').getTime();

function renderCard(
  container: DevContainer,
  props: Partial<Parameters<typeof ContainerCard>[0]> = {},
) {
  const handlers = {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onOpen: vi.fn(),
    onOpenTerminal: vi.fn(),
    onStartupCommandChange: vi.fn(),
  };
  render(
    <ContainerCard
      container={container}
      editorId="vscode"
      editorName="VS Code"
      editorAvailable
      terminalName="GNOME Terminal"
      terminalAvailable
      startupCommand=""
      busy={false}
      now={NOW}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('ContainerCard', () => {
  it('shows the project name derived from the host path, not the container name', () => {
    renderCard(devContainer());
    expect(screen.getByRole('heading', { name: 'webapp' })).toBeDefined();
  });

  /**
   * The degraded row. A container with an unparseable label must still be
   * visible: a row that explains itself is diagnosable, one that silently
   * vanishes produces a bug report nobody can act on.
   */
  describe('when the host path could not be parsed', () => {
    it('still renders the row, marked degraded', () => {
      const { container: dom } = render(
        <ContainerCard
          container={unresolvedContainer()}
          editorId="vscode"
          editorName="VS Code"
          editorAvailable
          terminalName="GNOME Terminal"
          terminalAvailable
          startupCommand=""
          busy={false}
          now={NOW}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onOpen={vi.fn()}
          onOpenTerminal={vi.fn()}
          onStartupCommandChange={vi.fn()}
        />,
      );
      expect(dom.querySelector('.card-degraded')).not.toBeNull();
    });

    it('shows the reason parsing gave up', () => {
      renderCard(unresolvedContainer('relative/not/absolute'));
      expect(screen.getByText(/Not an absolute path\./)).toBeDefined();
    });

    it('falls back to the raw label for the project name, per projectName()', () => {
      renderCard(unresolvedContainer('relative/not/absolute'));
      // Both the heading and the folder row show it — there is nothing better
      // to show, and a blank heading would be worse than an odd one.
      expect(screen.getByRole('heading', { name: 'relative/not/absolute' })).toBeDefined();
      expect(screen.getAllByText(/relative\/not\/absolute/).length).toBeGreaterThan(1);
    });
  });

  describe('the open action', () => {
    it('is enabled and fires when a workspace folder and editor are both present', async () => {
      const { onOpen } = renderCard(devContainer());
      const button = screen.getByRole('button', { name: 'Open in VS Code' });
      expect(button.hasAttribute('disabled')).toBe(false);
      await userEvent.click(button);
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('is disabled, with the reason, when the container records no workspace folder', () => {
      const noWorkspace = devContainer();
      // exactOptionalPropertyTypes forbids assigning undefined, so the key is
      // removed rather than blanked.
      const { workspaceFolder: _omitted, ...rest } = noWorkspace;
      renderCard(rest as DevContainer);

      const button = screen.getByRole('button', { name: 'Open in VS Code' });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toMatch(/does not record which folder/i);
    });

    it('is disabled, naming the editor, when that editor is not installed', () => {
      renderCard(devContainer(), { editorAvailable: false, editorName: 'Cursor' });
      const button = screen.getByRole('button', { name: 'Open in Cursor' });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toMatch(/Cursor was not found/i);
    });

    /**
     * Rows layout gives a container one line, and "Open in VS Code Insiders"
     * does not fit beside a name, a status and two more buttons. The editor's
     * name moves into the tooltip rather than being lost — a user with four
     * editors installed still has to be able to tell which one this opens.
     */
    it('drops the editor name from the label, not from the card, when dense', () => {
      renderCard(devContainer(), { dense: true, editorName: 'VS Code Insiders' });
      const button = screen.getByRole('button', { name: 'Open' });
      expect(button.getAttribute('title')).toBe('Open in VS Code Insiders');
    });
  });

  describe('the Terminal button', () => {
    it('is enabled and fires for a running container with an emulator installed', async () => {
      const { onOpenTerminal } = renderCard(devContainer());
      const button = screen.getByRole('button', { name: 'Terminal' });
      expect(button.hasAttribute('disabled')).toBe(false);
      await userEvent.click(button);
      expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    });

    it('is disabled, with the reason, for a stopped container', () => {
      // `docker exec` needs a live process namespace. Offering the button and
      // failing at the daemon would put the explanation in a notice the user
      // has to dismiss, rather than in the tooltip of the thing they clicked.
      renderCard(
        devContainer({
          runtime: { state: 'exited', exitCode: 0, finishedAt: new Date(NOW - 3_600_000) },
        }),
      );
      const button = screen.getByRole('button', { name: 'Terminal' });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toMatch(/only be opened in a running container/i);
    });

    /**
     * A paused container is the case that motivates `canExec` existing apart
     * from `canStop`: it still has a process namespace, so the exec is accepted
     * and then blocks forever against frozen processes. A terminal that opens
     * and hangs is worse than one that refuses.
     */
    it('is disabled for a paused container, even though Stop is offered', () => {
      renderCard(
        devContainer({
          runtime: { state: 'paused', startedAt: new Date(NOW - 3_600_000), ports: [] },
        }),
      );
      expect(screen.getByRole('button', { name: 'Terminal' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(false);
    });

    it('is disabled, naming the terminal, when that emulator is not installed', () => {
      renderCard(devContainer(), { terminalAvailable: false, terminalName: 'Konsole' });
      const button = screen.getByRole('button', { name: 'Terminal' });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toMatch(/Konsole was not found/i);
    });

    it('blames nobody when no emulator was found at all', () => {
      renderCard(devContainer(), { terminalAvailable: false, terminalName: undefined });
      const button = screen.getByRole('button', { name: 'Terminal' });
      expect(button.getAttribute('title')).toMatch(/No terminal emulator/i);
    });
  });

  describe('lifecycle buttons', () => {
    it('offers Stop for a running container and not Start', () => {
      renderCard(devContainer());
      expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    });

    it('offers Start for an exited container and not Stop', () => {
      renderCard(
        devContainer({
          runtime: { state: 'exited', exitCode: 0, finishedAt: new Date(NOW - 3_600_000) },
        }),
      );
      expect(screen.getByRole('button', { name: 'Start' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    it('offers neither mid-transition', () => {
      renderCard(devContainer({ runtime: { state: 'restarting' } }));
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    it('disables everything and says so while an action is in flight', () => {
      renderCard(devContainer(), { busy: true });
      const stop = screen.getByRole('button', { name: 'Stopping…' });
      expect(stop.hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Open in VS Code' }).hasAttribute('disabled')).toBe(
        true,
      );
    });
  });

  describe('ports', () => {
    it('distinguishes published from merely exposed', () => {
      renderCard(
        devContainer({
          runtime: {
            state: 'running',
            startedAt: new Date(NOW - 3_600_000),
            ports: [
              { containerPort: 5173, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 5173 },
              { containerPort: 9229, protocol: 'tcp' },
            ],
          },
        }),
      );
      expect(screen.getByText('5173 → 5173')).toBeDefined();
      // The case a user is actually trying to diagnose when localhost is dead.
      expect(screen.getByText('9229 (not published)')).toBeDefined();
    });

    it('omits the ports row entirely for a stopped container', () => {
      const { container: dom } = render(
        <ContainerCard
          container={devContainer({
            runtime: { state: 'exited', exitCode: 0, finishedAt: new Date(NOW) },
          })}
          editorId="vscode"
          editorName="VS Code"
          editorAvailable
          terminalName="GNOME Terminal"
          terminalAvailable
          startupCommand=""
          busy={false}
          now={NOW}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onOpen={vi.fn()}
          onOpenTerminal={vi.fn()}
          onStartupCommandChange={vi.fn()}
        />,
      );
      expect(dom.querySelector('.ports')).toBeNull();
    });
  });

  /**
   * Inside a compose group every member shares the project's folder, so
   * `projectName` would render three identical headings. The container name is
   * the only thing that distinguishes app from db. The project itself is named
   * once, on the group header.
   */
  it('shows the container name for a compose member, not the shared folder name', () => {
    renderCard(
      devContainer({
        name: 'platform_devcontainer-db-1',
        labels: {
          localFolderRaw: '/home/dev/code/platform',
          composeProject: 'platform_devcontainer',
        },
        localFolder: { kind: 'posix', path: '/home/dev/code/platform' },
        workspaceFolder: asContainerPath('/workspaces/platform'),
      }),
    );
    expect(screen.getByRole('heading', { name: 'platform_devcontainer-db-1' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'platform' })).toBeNull();
  });
});
