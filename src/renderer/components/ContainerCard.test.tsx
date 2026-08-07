// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContainerCard } from './ContainerCard.js';
import { devContainer, unresolvedContainer } from '../test-fixtures.js';
import type { BranchListing, ClaudeStatus, DevContainer, GitStatus } from '../../models/index.js';
import type { BranchMenuBinding } from '../presenters.js';
import { asContainerPath } from '../../models/index.js';

const NOW = new Date('2026-07-27T12:00:00Z').getTime();

const ON_MAIN: GitStatus = { kind: 'branch', branch: 'main' };

const CLEAN: BranchListing = {
  kind: 'ready',
  tree: { kind: 'clean' },
  branches: [
    { name: 'main', current: true },
    { name: 'feature/dark-theme', current: false },
  ],
};

/**
 * A literal binding, built here rather than by running `useBranches`.
 *
 * The View-test rule: a View is driven by a hand-built ViewModel value and
 * asserted on only through what it renders. Whether a switch is ALLOWED is the
 * models layer's business and is tested there; what this file cares about is
 * that a disabled row says why and an enabled one calls back.
 */
function binding(overrides: Partial<BranchMenuBinding> = {}): BranchMenuBinding {
  return {
    open: false,
    listing: undefined,
    busy: false,
    onToggle: vi.fn(),
    onSwitch: vi.fn(),
    ...overrides,
  };
}

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
      // No <title> on any of them: an SVG title is a TOOLTIP and would win over
      // the badge's own inside the shape's box, so hovering the mark would
      // replace the explanation with a bare product name. The names live in
      // `aria-label` and `title` on the badge, asserted just below.
      expect(badge?.querySelectorAll('title')).toHaveLength(0);
      expect(badge?.getAttribute('aria-label')).toBe('VS Code, Cursor attached');
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
      sessions: [
        { pid: 412, command: 'claude', activity: { kind: 'idle' }, elapsed: '1h12m33.0s' },
      ],
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
            { pid: 412, command: 'claude', activity: { kind: 'idle' }, elapsed: '1h12m33.0s' },
            { pid: 907, command: 'claude', activity: { kind: 'idle' }, elapsed: '4m8.0s' },
          ],
        },
      });

      const badge = screen.getByText('Claude ×2');
      expect(badge.getAttribute('title')).toContain('pid 412');
      expect(badge.getAttribute('title')).toContain('pid 907');
      expect(badge.getAttribute('title')).toContain('up 1h12m33.0s');
    });

    /**
     * Rows layout is one line per container, so the word goes and the mark
     * stays — the same trade the image row and the primary button make. One
     * session leaves NO text at all: the mark already means "a session is
     * running", and a `1` beside it is the same fact twice. The full text
     * stays reachable through `title`, and the accessible name stays the long
     * one so a screen reader is not left with a bare shape.
     */
    it('shortens under dense to the mark alone, keeping the full text in title', () => {
      const { dom } = renderCard(devContainer(), { dense: true, claude: oneSession });

      const badge = screen.getByLabelText('Claude');
      expect(badge.textContent).toBe('');
      expect(dom.querySelector('.badge-claude svg')).not.toBeNull();
      expect(badge.getAttribute('title')).toContain('A Claude Code session is running');
      expect(badge.getAttribute('title')).toContain('pid 412');
    });

    it('keeps the count beside the mark when there is more than one', () => {
      renderCard(devContainer(), {
        dense: true,
        claude: {
          kind: 'running',
          sessions: [
            { pid: 412, command: 'claude', activity: { kind: 'idle' }, elapsed: '1h12m33.0s' },
            { pid: 907, command: 'claude', activity: { kind: 'idle' }, elapsed: '4m8.0s' },
          ],
        },
      });
      expect(screen.getByLabelText('Claude ×2').textContent).toBe('×2');
    });

    /**
     * The mark is drawn in EVERY layout, unlike the editor marks beside it —
     * there is only one product here, so the shape is not distinguishing
     * between several, it is the fastest way to recognise the badge. The WORD
     * stays wherever it fits, because this badge guards a destructive click
     * and a bare asterisk means nothing to somebody seeing it for the first
     * time.
     */
    it('draws the mark alongside the word where there is room', () => {
      const { dom } = renderCard(devContainer(), { claude: oneSession });
      const badge = dom.querySelector('.badge-claude');
      expect(badge?.querySelector('svg')).not.toBeNull();
      expect(badge?.textContent).toBe('Claude');
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
        claude: {
          kind: 'running',
          sessions: [{ pid: 412, command: 'claude', activity: { kind: 'idle' } }],
        },
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
      const { dom } = renderCard(devContainer(), {
        git: { kind: 'detached', commit: '4f2c1ab9d3e5f70123456789abcdef0123456789' },
      });
      // The title is on the CHIP, not on the name inside it — the name is its
      // own element only so it has something to ellipsise.
      expect(screen.getByText('4f2c1ab').className).toBe('branch-chip-name');
      expect(dom.querySelector('.branch-chip')?.getAttribute('title')).toContain(
        '4f2c1ab9d3e5f70123456789abcdef0123456789',
      );
    });

    /**
     * The name is wrapped rather than left as a bare text node, and that is not
     * cosmetic: `text-overflow` has nothing to act on inside a flex container,
     * so an unwrapped name is CLIPPED to nothing as the chip narrows — leaving
     * a lone `⎇` that reads as a rendering fault rather than as a truncation.
     */
    it('wraps the name in its own element so it can ellipsise', () => {
      const { dom } = renderCard(devContainer(), {
        git: { kind: 'branch', branch: 'claude/windows-terminal-devcontainer-niu6gp' },
      });
      const name = dom.querySelector('.branch-chip .branch-chip-name');
      expect(name?.textContent).toBe('claude/windows-terminal-devcontainer-niu6gp');
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

    /**
     * The chip is a LABEL without a binding and a CONTROL with one. A button
     * that opens nothing is a control lying about being one, so the two
     * spellings are deliberately not interchangeable.
     */
    it('is not a button when the card was given no menu to open', () => {
      const { dom } = renderCard(devContainer(), { git: ON_MAIN });
      expect(dom.querySelector('.branch-chip')?.tagName).toBe('SPAN');
    });
  });

  describe('the branch counts', () => {
    it('draws the dirty count and the divergence beside the name', () => {
      const { dom } = renderCard(devContainer(), {
        git: {
          kind: 'branch',
          branch: 'main',
          tree: { kind: 'dirty', changed: 3 },
          tracking: { ahead: 2, behind: 1 },
        },
      });

      expect(dom.querySelector('.branch-count.dirty')?.textContent).toBe('●3');
      expect(dom.querySelector('.branch-count.ahead')?.textContent).toBe('↑2');
      expect(dom.querySelector('.branch-count.behind')?.textContent).toBe('↓1');
    });

    /**
     * The chip on a machine with no git, which is the state the whole optional
     * chain exists to keep working. No counts, and no empty container either.
     */
    it('draws nothing at all when the counts were never read', () => {
      const { dom } = renderCard(devContainer(), { git: ON_MAIN });
      expect(dom.querySelector('.branch-counts')).toBeNull();
    });

    it('draws no marks for a clean tree in sync with its upstream', () => {
      const { dom } = renderCard(devContainer(), {
        git: {
          kind: 'branch',
          branch: 'main',
          tree: { kind: 'clean' },
          tracking: { ahead: 0, behind: 0 },
        },
      });
      expect(dom.querySelector('.branch-counts')).toBeNull();
    });

    /** The glyphs are decoration; the words live in the accessible name. */
    it('keeps the counts out of the accessible name as symbols and in it as words', () => {
      renderCard(devContainer(), {
        git: { kind: 'branch', branch: 'main', tree: { kind: 'dirty', changed: 1 } },
      });
      expect(screen.getByLabelText(/1 uncommitted change/)).toBeDefined();
    });
  });

  describe('the branch menu', () => {
    it('turns the chip into a button when a binding is supplied', () => {
      const { dom } = renderCard(devContainer(), { git: ON_MAIN, branchMenu: binding() });
      const chip = dom.querySelector('.branch-chip');
      expect(chip?.tagName).toBe('BUTTON');
      expect(chip?.getAttribute('aria-haspopup')).toBe('menu');
      expect(chip?.getAttribute('aria-expanded')).toBe('false');
    });

    it('asks the ViewModel to open when the chip is clicked', async () => {
      const onToggle = vi.fn();
      renderCard(devContainer(), { git: ON_MAIN, branchMenu: binding({ onToggle }) });

      await userEvent.click(screen.getByRole('button', { name: /Switch branch/ }));
      expect(onToggle).toHaveBeenCalled();
    });

    it('shows nothing until the binding says it is open', () => {
      renderCard(devContainer(), { git: ON_MAIN, branchMenu: binding() });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('says it is reading while the listing is outstanding', () => {
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: undefined }),
      });
      expect(screen.getByRole('menu')).toBeDefined();
      expect(screen.getByText('Reading branches…')).toBeDefined();
    });

    it('lists the branches, marking the current one', () => {
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: CLEAN }),
      });

      const current = screen.getByRole('menuitem', { name: /main/ });
      expect(current.className).toContain('current');
      expect(current.hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('menuitem', { name: /feature\/dark-theme/ })).toBeDefined();
    });

    it('switches to the branch that was clicked', async () => {
      const onSwitch = vi.fn();
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: CLEAN, onSwitch }),
      });

      await userEvent.click(screen.getByRole('menuitem', { name: /feature\/dark-theme/ }));
      expect(onSwitch).toHaveBeenCalledWith('feature/dark-theme');
    });

    /**
     * The chosen posture, on screen: a dirty tree refuses every row and the
     * reason is stated once, above them, rather than hidden in eight identical
     * tooltips.
     */
    it('refuses every branch on a dirty tree, and says so once', () => {
      const { dom } = renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: {
          ...binding(),
          open: true,
          listing: { ...CLEAN, tree: { kind: 'dirty', changed: 3 } },
        },
      });

      expect(dom.querySelectorAll('.branch-menu-warning')).toHaveLength(1);
      expect(screen.getByText(/3 uncommitted changes/)).toBeDefined();
      for (const item of screen.getAllByRole('menuitem')) {
        expect(item.hasAttribute('disabled')).toBe(true);
      }
    });

    it('gives every disabled row a title saying why', () => {
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: CLEAN }),
      });

      for (const item of screen.getAllByRole('menuitem')) {
        if (item.hasAttribute('disabled')) expect(item.getAttribute('title')).toBeTruthy();
      }
    });

    it('makes the rows inert while a checkout is running', () => {
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: CLEAN, busy: true }),
      });

      for (const item of screen.getAllByRole('menuitem')) {
        expect(item.hasAttribute('disabled')).toBe(true);
      }
    });

    /**
     * The chip is how the menu closes, so it must not go inert with the rows —
     * a slow checkout would otherwise trap the user in a popover they cannot
     * dismiss by the route they opened it.
     */
    it('leaves the chip itself clickable while a checkout is running', () => {
      const { dom } = renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: CLEAN, busy: true }),
      });
      expect(dom.querySelector('.branch-chip')?.hasAttribute('disabled')).toBe(false);
    });

    it('closes when the backdrop is clicked', async () => {
      const onToggle = vi.fn();
      const { dom } = renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({ open: true, listing: CLEAN, onToggle }),
      });

      const backdrop = dom.querySelector('.menu-backdrop');
      if (backdrop === null) throw new Error('expected a backdrop to catch the outside click');
      await userEvent.click(backdrop);
      expect(onToggle).toHaveBeenCalled();
    });

    it('shows the reason when there is nothing to list', () => {
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({
          open: true,
          listing: { kind: 'unavailable', reason: 'git was not found on this machine.' },
        }),
      });

      expect(screen.getByText('git was not found on this machine.')).toBeDefined();
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    });

    /**
     * The `safe.directory` case, which is what a Windows user whose code lives
     * in a WSL distro hits. boxwarden shows git's own command and a Copy
     * button; it does not run it, because writing that exception is disabling a
     * check about whether a repository can be trusted.
     */
    it('offers the fix command to copy, and does not run it', () => {
      const command =
        "git config --global --add safe.directory '%(prefix)///wsl.localhost/dev/home/s/a'";
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({
          open: true,
          listing: { kind: 'unavailable', reason: 'git does not trust this repository.', command },
        }),
      });

      expect(screen.getByText(command)).toBeDefined();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
    });

    it('shows no copy button when git named no fix', () => {
      renderCard(devContainer(), {
        git: ON_MAIN,
        branchMenu: binding({
          open: true,
          listing: { kind: 'unavailable', reason: 'fatal: not a git repository' },
        }),
      });

      expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    });
  });
});
