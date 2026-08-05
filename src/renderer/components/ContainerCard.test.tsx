// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContainerCard } from './ContainerCard.js';
import { devContainer, unresolvedContainer } from '../test-fixtures.js';
import type { ClaudeStatus, DevContainer } from '../../models/index.js';
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
  const { container: dom } = render(
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
  // `dom` alongside the handlers so a test asserting on a class does not have
  // to restate the whole prop list — which is how four of them ended up
  // needing an edit when the terminal props arrived.
  return { ...handlers, dom };
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

    /**
     * With a window already attached the one action becomes two, and they mean
     * genuinely different things. Before that they would not — the CLI opens a
     * new window either way — so the card shows one button and says "Open".
     */
    describe('when an editor is already attached', () => {
      const attached = { kind: 'attached', editors: ['vscode'] } as const;

      it('offers Focus and New window, and asks for the right one', async () => {
        const container = devContainer();
        const { onOpen } = renderCard(container, { editor: attached });

        await userEvent.click(screen.getByRole('button', { name: 'Focus VS Code' }));
        // No mode argument at all: the default is to focus, decided once in
        // the ViewModel rather than restated by every caller.
        expect(onOpen.mock.calls.at(-1)).toEqual([container]);

        await userEvent.click(
          screen.getByRole('button', { name: /new VS Code window on this container/i }),
        );
        expect(onOpen.mock.calls.at(-1)).toEqual([container, 'new-window']);
      });

      it('shows only one action while nothing is attached', () => {
        renderCard(devContainer(), { editor: { kind: 'none' } });
        expect(screen.queryByRole('button', { name: /new VS Code window/i })).toBeNull();
        expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeDefined();
      });

      /** A container with nowhere to open has nowhere to open twice, either. */
      it('disables both when there is no workspace folder', () => {
        const { workspaceFolder: _omitted, ...rest } = devContainer();
        renderCard(rest as DevContainer, { editor: attached });

        expect(screen.getByRole('button', { name: 'Focus VS Code' }).hasAttribute('disabled')).toBe(
          true,
        );
        expect(
          screen.getByRole('button', { name: /new VS Code window/i }).hasAttribute('disabled'),
        ).toBe(true);
      });
    });
  });

  /**
   * The rows layout has one line per container, so the attached-editor badge
   * shortens to a mark. It used to shorten to `⧉` — the same two-window glyph
   * whatever was attached — which on a list whose purpose is telling containers
   * apart said only "an editor, some editor".
   */
  describe('the attached-editor badge in the rows layout', () => {
    it('draws a mark per attached editor rather than a generic glyph', () => {
      const { dom } = renderCard(devContainer(), {
        dense: true,
        editor: { kind: 'attached', editors: ['vscode', 'cursor'] },
      });

      const badge = dom.querySelector('.badge-editor');
      expect(badge?.querySelectorAll('svg.editor-glyph')).toHaveLength(2);
      expect(badge?.textContent).not.toContain('⧉');
      // Titled, so the shape has a name for anyone hovering it or reading it
      // through the accessibility tree.
      expect([...(badge?.querySelectorAll('title') ?? [])].map((t) => t.textContent)).toEqual([
        'VS Code',
        'Cursor',
      ]);
    });

    /** Nothing is lost to a reader who cannot see the shape. */
    it('still names the editors in the badge label', () => {
      const { dom } = renderCard(devContainer(), {
        dense: true,
        editor: { kind: 'attached', editors: ['vscode'] },
      });
      expect(dom.querySelector('.badge-editor')?.getAttribute('aria-label')).toBe(
        'VS Code attached',
      );
    });

    it('spells the editors out in the layouts that have room', () => {
      const { dom } = renderCard(devContainer(), {
        editor: { kind: 'attached', editors: ['vscode'] },
      });
      const badge = dom.querySelector('.badge-editor');
      expect(badge?.textContent).toBe('VS Code');
      expect(badge?.querySelector('svg')).toBeNull();
    });

    /** `unknown` is "could not read the process table", so there is no mark. */
    it('keeps the question mark when it could not tell', () => {
      const { dom } = renderCard(devContainer(), {
        dense: true,
        editor: { kind: 'unknown', reason: 'top failed' },
      });
      const badge = dom.querySelector('.badge-editor');
      expect(badge?.querySelector('svg')).toBeNull();
      expect(badge?.textContent).toBe('?');
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

  describe('the SSH agent indicator', () => {
    it('renders nothing at all for a container that declares no agent', () => {
      const { dom } = renderCard(devContainer({ sshAgent: { kind: 'absent' } }));
      expect(dom.querySelector('.agent-badge')).toBeNull();
    });

    it('confirms a forwarded agent without marking it a problem', () => {
      const { dom } = renderCard(
        devContainer({
          sshAgent: { kind: 'forwarded', socket: '/run/host-services/ssh-auth.sock' },
        }),
      );
      expect(dom.querySelector('.agent-badge')).not.toBeNull();
      expect(dom.querySelector('.agent-badge-warning')).toBeNull();
    });

    /**
     * The case the feature exists for. It has to look different from the
     * healthy badge, and the tooltip has to name the failure — the container
     * itself gives the user no other clue.
     */
    it('styles declared-unmounted as a warning and explains it in the title', () => {
      const { dom } = renderCard(
        devContainer({ sshAgent: { kind: 'declared-unmounted', socket: '/ssh-agent' } }),
      );
      const badge = dom.querySelector('.agent-badge-warning');
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute('title')).toContain('SSH_AUTH_SOCK=/ssh-agent');
    });

    /** Dense shortens the label and keeps the full text reachable. */
    it('shortens under dense, keeping the explanation in the title', () => {
      const { dom } = renderCard(
        devContainer({ sshAgent: { kind: 'declared-unmounted', socket: '/ssh-agent' } }),
        { dense: true },
      );
      const badge = dom.querySelector('.agent-badge');
      expect(badge?.textContent).toBe('SSH!');
      expect(badge?.getAttribute('title')).toContain('nothing is mounted there');
    });
  });

  /**
   * The badge is the whole point of the Claude Code presence feature, and its
   * ABSENCE carries meaning too: no badge is how a card says stopping is safe.
   * Both directions are pinned.
   */
  describe('the Claude Code badge', () => {
    const oneSession: ClaudeStatus = {
      kind: 'running',
      sessions: [{ pid: 412, command: 'claude', elapsed: '1h12m33.0s' }],
    };

    it('renders when a session is running', () => {
      renderCard(devContainer(), { claude: oneSession });
      expect(screen.getByText('Claude')).toBeDefined();
    });

    it('is absent when nothing is running, and while the first poll is outstanding', () => {
      // Asked, nothing running.
      renderCard(devContainer(), { claude: { kind: 'none' } });
      expect(document.querySelector('.badge-claude')).toBeNull();

      cleanup();

      // Not asked yet — a different fact, and the same rendering, because the
      // only honest thing to show before the first answer is nothing.
      renderCard(devContainer());
      expect(document.querySelector('.badge-claude')).toBeNull();
    });

    it('counts more than one session, keeping the detail in the title', () => {
      renderCard(devContainer(), {
        claude: {
          kind: 'running',
          sessions: [
            { pid: 412, command: 'claude', elapsed: '1h12m33.0s' },
            { pid: 907, command: 'claude', elapsed: '4m8.0s' },
          ],
        },
      });

      const badge = screen.getByText('Claude ×2');
      expect(badge.getAttribute('title')).toContain('pid 412');
      expect(badge.getAttribute('title')).toContain('pid 907');
      expect(badge.getAttribute('title')).toContain('up 1h12m33.0s');
    });

    /**
     * Rows layout is one line per container, so the badge shortens to a bare
     * count — the same trade the image row and the primary button make. The
     * full text stays reachable through `title`, and the accessible name stays
     * the long one so a screen reader is not left with "2".
     */
    it('shortens under dense but keeps the full text in title', () => {
      renderCard(devContainer(), { dense: true, claude: oneSession });

      const badge = screen.getByLabelText('Claude');
      expect(badge.textContent).toBe('1');
      expect(badge.getAttribute('title')).toContain('A Claude Code session is running');
      expect(badge.getAttribute('title')).toContain('pid 412');
    });

    /**
     * "Could not tell" gets its own badge rather than falling back to the
     * no-badge rendering, which means "safe to stop".
     */
    it('says so when the check could not be made', () => {
      renderCard(devContainer(), { claude: { kind: 'unknown', reason: 'socket went away' } });
      const badge = screen.getByText('Claude ?');
      expect(badge.getAttribute('title')).toContain('socket went away');
    });
  });

  /**
   * v1 annotates rather than gates: stopping a container with a live agent in
   * it stays one click, it just stops being an uninformed one.
   */
  describe('the Stop button when a session is live', () => {
    it('warns in the title and stays clickable', async () => {
      const { onStop } = renderCard(devContainer(), {
        claude: { kind: 'running', sessions: [{ pid: 412, command: 'claude' }] },
      });

      const stop = screen.getByRole('button', { name: 'Stop' });
      expect(stop.getAttribute('title')).toMatch(/Claude Code session is running/i);
      expect(stop.hasAttribute('disabled')).toBe(false);

      await userEvent.click(stop);
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('carries no warning when nothing is running', () => {
      renderCard(devContainer(), { claude: { kind: 'none' } });
      expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('title')).toBeNull();
    });
  });

  describe('the branch chip', () => {
    it('names the branch the workspace folder is on', () => {
      renderCard(devContainer(), { git: { kind: 'branch', branch: 'feature/rate-limiting' } });
      expect(screen.getByLabelText('Branch feature/rate-limiting')).toBeDefined();
      expect(screen.getByText('feature/rate-limiting')).toBeDefined();
    });

    it('abbreviates a detached HEAD and keeps the whole id in the title', () => {
      renderCard(devContainer(), {
        git: { kind: 'detached', commit: '4f2c1ab9d3e5f70123456789abcdef0123456789' },
      });
      const chip = screen.getByText('4f2c1ab');
      expect(chip.getAttribute('title')).toContain('4f2c1ab9d3e5f70123456789abcdef0123456789');
    });

    /**
     * Three arms render as nothing, and unlike the Claude badge that is the
     * whole answer for `unknown` too — see the note on `branchChip`.
     */
    it('is absent for a folder that is not a checkout, could not be read, or was not polled', () => {
      renderCard(devContainer(), { git: { kind: 'none' } });
      expect(document.querySelector('.branch-chip')).toBeNull();

      cleanup();

      renderCard(devContainer(), { git: { kind: 'unknown', reason: 'EACCES' } });
      expect(document.querySelector('.branch-chip')).toBeNull();

      cleanup();

      renderCard(devContainer());
      expect(document.querySelector('.branch-chip')).toBeNull();
    });
  });
});
