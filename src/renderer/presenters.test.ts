import { describe, expect, it } from 'vitest';
import type { ClaudeStatus, EngineId } from '../models/index.js';
import { devContainer } from './test-fixtures.js';
import {
  branchChip,
  claudeBadge,
  editorActions,
  editorBadge,
  stopWarning,
  containerCountLabel,
  emptyListMessage,
  engineChip,
  errorMessage,
  openBlockedReason,
  portLabel,
  scanRootHint,
  sshAgentBadge,
  summariseProjects,
  terminalBlockedReason,
  updatePanel,
  updateSummary,
  visiblePorts,
} from './presenters.js';
import { snapshot, unreachableSnapshot, updateAvailable } from './viewmodels/test-api.js';

/** Pure — no DOM, no bridge. This is the point of the presenters module. */

describe('errorMessage', () => {
  it('keeps a real Error message', () => {
    expect(errorMessage(new Error('socket gone'))).toBe('socket gone');
  });

  it('does not render a non-Error as [object Object]', () => {
    expect(errorMessage({ code: 'EACCES' })).toBe('[object Object]');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});

describe('engineChip', () => {
  it('names the engine and its version', () => {
    const chip = engineChip(snapshot());
    expect(chip.ok).toBe(true);
    expect(chip.label).toBe('Docker 27.1.1');
  });

  /**
   * The "+n" counts the OTHER engines being unioned in, so it is only true
   * while the selection is `all`. Narrowed to one, the chip must name exactly
   * what is in the list.
   */
  it('counts the other engines only while the selection is all', () => {
    const probe = snapshot().environment.api;
    const two = snapshot({
      environment: { ...snapshot().environment, attempts: [probe, probe] },
    });
    expect(engineChip(two).label).toBe('Docker 27.1.1 +1');

    const narrowed = snapshot({
      environment: { ...snapshot().environment, attempts: [probe, probe] },
      selection: { kind: 'only', id: 'unix:/var/run/docker.sock' as EngineId },
    });
    expect(engineChip(narrowed).label).toBe('Docker 27.1.1');
  });

  it('says plainly when nothing answered', () => {
    const chip = engineChip(unreachableSnapshot());
    expect(chip.ok).toBe(false);
    expect(chip.label).toBe('No container engine');
    expect(chip.connectedCount).toBe(0);
  });
});

describe('emptyListMessage', () => {
  it('agrees with itself about one engine', () => {
    expect(emptyListMessage({ kind: 'all' }, 1)).toContain('A container engine is');
    expect(emptyListMessage({ kind: 'all' }, 1)).toContain('on it');
  });

  it('pluralises for several', () => {
    expect(emptyListMessage({ kind: 'all' }, 3)).toContain('3 container engines are');
    expect(emptyListMessage({ kind: 'all' }, 3)).toContain('on them');
  });

  /** A narrowed selection means the others were never consulted — say so. */
  it('points a narrowed selection back at the others', () => {
    const message = emptyListMessage({ kind: 'only', id: 'unix:/x' as EngineId }, 3);
    expect(message).toContain('All engines');
  });
});

describe('openBlockedReason', () => {
  it('is undefined when opening is possible', () => {
    expect(openBlockedReason(devContainer(), true, 'VS Code')).toBeUndefined();
  });

  it('blames the container when it records no workspace folder', () => {
    const bare = devContainer();
    const without = { ...bare } as Record<string, unknown>;
    delete without['workspaceFolder'];
    expect(
      openBlockedReason(without as unknown as ReturnType<typeof devContainer>, true, 'VS Code'),
    ).toContain('does not record');
  });

  it('blames the machine when the editor is missing, and names it', () => {
    expect(openBlockedReason(devContainer(), false, 'Cursor')).toBe(
      'Cursor was not found on this machine.',
    );
  });
});

describe('terminalBlockedReason', () => {
  const running = devContainer();
  const stopped = devContainer({
    runtime: { state: 'exited', exitCode: 0, finishedAt: new Date('2026-07-27T10:00:00Z') },
  });
  const paused = devContainer({
    runtime: { state: 'paused', startedAt: new Date('2026-07-27T09:00:00Z'), ports: [] },
  });

  it('is undefined when a shell can be opened', () => {
    expect(terminalBlockedReason(running, true, 'GNOME Terminal')).toBeUndefined();
  });

  /**
   * The state comes first, and that ordering is the point: naming a missing
   * emulator for a stopped container would send the user to install something
   * that would not have helped.
   */
  it('blames the container state before the emulator', () => {
    expect(terminalBlockedReason(stopped, false, undefined)).toMatch(/running container/i);
  });

  /**
   * A paused container still holds a process namespace, so `docker exec` is
   * accepted and then blocks forever against frozen processes. Refusing beats
   * a terminal that opens and hangs.
   */
  it('refuses a paused container, which docker exec would accept', () => {
    expect(terminalBlockedReason(paused, true, 'GNOME Terminal')).toMatch(/running container/i);
  });

  it('names the emulator the user chose when it is missing', () => {
    expect(terminalBlockedReason(running, false, 'Konsole')).toBe(
      'Konsole was not found on this machine.',
    );
  });

  it('blames nobody when nothing was found at all', () => {
    // There is no name here and no install to suggest — a different sentence,
    // not a missing word in the same one.
    expect(terminalBlockedReason(running, false, undefined)).toMatch(/No terminal emulator/i);
  });
});

describe('summariseProjects', () => {
  it('distinguishes "nothing found" from "still looking"', () => {
    expect(summariseProjects(0, 0, true)).toContain('Looking for');
    expect(summariseProjects(0, 0, false)).toContain('No devcontainer.json files');
  });

  /** An empty list and "everything is built" are opposite findings. */
  it('says when every project on disk is already built', () => {
    expect(summariseProjects(0, 4, false)).toContain('(4) has been built');
  });

  it('pluralises the unbuilt count and mentions the built ones', () => {
    expect(summariseProjects(1, 0, false)).toContain('1 folder on this machine has');
    expect(summariseProjects(3, 2, false)).toContain('3 folders on this machine have');
    expect(summariseProjects(3, 2, false)).toContain('A further 2 are already built.');
  });
});

describe('containerCountLabel', () => {
  it('pluralises', () => {
    expect(containerCountLabel(1)).toBe('1 dev container');
    expect(containerCountLabel(0)).toBe('0 dev containers');
  });
});

describe('scanRootHint', () => {
  it('separates a missing folder from an unreadable one', () => {
    expect(scanRootHint('missing', 0, undefined)).toBe('no such folder');
    expect(scanRootHint('unreadable', 0, 'EACCES')).toBe('unreadable: EACCES');
    expect(scanRootHint(undefined, 2, undefined)).toBe('2 found');
  });
});

describe('ports', () => {
  it('shows nothing for a container that is not running', () => {
    const exited = devContainer({
      runtime: { state: 'exited', exitCode: 0, finishedAt: new Date() },
    });
    expect(visiblePorts(exited)).toHaveLength(0);
  });

  /** An exposed-but-unpublished port is not reachable from the host — say so. */
  it('marks an unpublished port rather than implying it is reachable', () => {
    expect(portLabel({ containerPort: 5432, protocol: 'tcp' }).text).toBe('5432 (not published)');
    expect(portLabel({ containerPort: 5432, protocol: 'tcp', hostPort: 15432 }).text).toBe(
      '15432 → 5432',
    );
  });
});

describe('sshAgentBadge', () => {
  /**
   * The important half. Most dev containers never touch a remote, and a badge
   * on every card announcing a feature nobody asked for is how an indicator
   * becomes wallpaper.
   */
  it('renders nothing when no agent is declared', () => {
    expect(sshAgentBadge({ kind: 'absent' })).toBeUndefined();
  });

  it('confirms a forwarded agent quietly, naming the socket in the tooltip', () => {
    const badge = sshAgentBadge({ kind: 'forwarded', socket: '/run/host-services/ssh-auth.sock' });
    expect(badge?.warning).toBe(false);
    expect(badge?.text).toBe('SSH agent');
    expect(badge?.title).toContain('/run/host-services/ssh-auth.sock');
  });

  /** The tooltip has to name the failure, not the symptom — see the presenter. */
  it('warns for declared-unmounted and says what will actually break', () => {
    const badge = sshAgentBadge({ kind: 'declared-unmounted', socket: '/ssh-agent' });
    expect(badge?.warning).toBe(true);
    expect(badge?.title).toContain('SSH_AUTH_SOCK=/ssh-agent');
    expect(badge?.title).toMatch(/git (fetch|push)/);
  });

  it('has a short form for the rows layout, distinguishable from the healthy one', () => {
    const ok = sshAgentBadge({ kind: 'forwarded', socket: '/ssh-agent' });
    const broken = sshAgentBadge({ kind: 'declared-unmounted', socket: '/ssh-agent' });
    expect(ok?.short).not.toBe(broken?.short);
  });
});

describe('branchChip', () => {
  it('shows the branch name', () => {
    const chip = branchChip({ kind: 'branch', branch: 'feature/rate-limiting' });
    expect(chip?.text).toBe('feature/rate-limiting');
    expect(chip?.tone).toBe('branch');
    expect(chip?.label).toContain('feature/rate-limiting');
  });

  it('abbreviates a detached HEAD and keeps the full id in the title', () => {
    const chip = branchChip({
      kind: 'detached',
      commit: '4f2c1ab9d3e5f70123456789abcdef0123456789',
    });
    expect(chip?.text).toBe('4f2c1ab');
    expect(chip?.tone).toBe('detached');
    expect(chip?.title).toContain('4f2c1ab9d3e5f70123456789abcdef0123456789');
    // "4f2c1ab" alone does not say what it is, so the accessible name does.
    expect(chip?.label).toContain('Detached HEAD');
  });

  /**
   * Unlike `claudeBadge`, `unknown` renders NOTHING. Nothing here gates a
   * click, and this arm is the ordinary state of every card on a machine where
   * the host folders are not visible — a chip on all of them, forever, on a
   * machine where nothing is wrong is how a chip stops being read.
   */
  it('shows nothing for a folder that is not a checkout, could not be read, or was not polled', () => {
    expect(branchChip({ kind: 'none' })).toBeUndefined();
    expect(branchChip({ kind: 'unknown', reason: 'EACCES' })).toBeUndefined();
    expect(branchChip(undefined)).toBeUndefined();
  });
});

describe('claudeBadge', () => {
  it('has no badge for a container with nothing running, or one not yet polled', () => {
    expect(claudeBadge({ kind: 'none' })).toBeUndefined();
    expect(claudeBadge({ kind: 'not-applicable' })).toBeUndefined();
    expect(claudeBadge(undefined)).toBeUndefined();
  });

  it('names one session without a count, and says what stopping costs', () => {
    const badge = claudeBadge({
      kind: 'running',
      sessions: [{ pid: 412, command: 'claude', elapsed: '1h12m33.0s' }],
    });
    expect(badge?.label).toBe('Claude');
    expect(badge?.tone).toBe('running');
    expect(badge?.title).toContain('A Claude Code session is running');
    expect(badge?.title).toContain('Stopping the container ends it.');
  });

  it('counts more than one, and keeps every session in the title', () => {
    const badge = claudeBadge({
      kind: 'running',
      sessions: [
        { pid: 412, command: 'claude', elapsed: '1h12m33.0s' },
        { pid: 907, command: 'claude', elapsed: '4m8.0s' },
      ],
    });
    expect(badge?.label).toBe('Claude ×2');
    expect(badge?.denseLabel).toBe('2');
    expect(badge?.title).toContain('pid 412');
    expect(badge?.title).toContain('pid 907');
    expect(badge?.title).toContain('Stopping the container ends them.');
  });

  /**
   * "up" and "since" are not interchangeable. Podman supplies an elapsed
   * duration and Docker a start time, and printing the second as the first
   * would report a session that began ten minutes ago as ten hours old.
   */
  it('says "up" for an elapsed duration and "since" for a start time', () => {
    expect(
      claudeBadge({ kind: 'running', sessions: [{ pid: 1, command: 'claude', elapsed: '4m8.0s' }] })
        ?.title,
    ).toContain('up 4m8.0s');

    expect(
      claudeBadge({
        kind: 'running',
        sessions: [{ pid: 1, command: 'claude', startTime: '10:31' }],
      })?.title,
    ).toContain('since 10:31');

    expect(
      claudeBadge({ kind: 'running', sessions: [{ pid: 1, command: 'claude' }] })?.title,
    ).toContain('uptime not reported');
  });

  /**
   * "Could not tell" must not render as "nothing running". The Stop button
   * reads this, and an absent badge is the visual language for "safe".
   */
  it('shows an uncertain badge, with the reason, when the check failed', () => {
    const badge = claudeBadge({ kind: 'unknown', reason: 'connect ENOENT /var/run/docker.sock' });
    expect(badge?.label).toBe('Claude ?');
    expect(badge?.denseLabel).toBe('?');
    expect(badge?.tone).toBe('unknown');
    expect(badge?.title).toContain('connect ENOENT');
  });
});

describe('stopWarning', () => {
  it('says nothing when nothing is running', () => {
    expect(stopWarning([])).toBeUndefined();
    expect(stopWarning([{ kind: 'none' }, undefined, { kind: 'not-applicable' }])).toBeUndefined();
  });

  /**
   * A "could not tell" is not a warning. Annotating every unreadable container
   * would train the user to ignore the annotation, which costs more than the
   * case it covers.
   */
  it('says nothing for a container it could not read', () => {
    expect(stopWarning([{ kind: 'unknown', reason: 'nope' }])).toBeUndefined();
  });

  /** The compose case: "Stop all" reaches services whose cards nobody read. */
  it('aggregates across a group and pluralises', () => {
    const one: readonly (ClaudeStatus | undefined)[] = [
      { kind: 'running', sessions: [{ pid: 1, command: 'claude' }] },
      { kind: 'none' },
    ];
    expect(stopWarning(one)).toBe('A Claude Code session is running in here. Stopping ends it.');

    const several: readonly (ClaudeStatus | undefined)[] = [
      { kind: 'running', sessions: [{ pid: 1, command: 'claude' }] },
      {
        kind: 'running',
        sessions: [
          { pid: 2, command: 'claude' },
          { pid: 3, command: 'claude' },
        ],
      },
    ];
    expect(stopWarning(several)).toBe(
      '3 Claude Code sessions are running in here. Stopping ends them.',
    );
  });
});

describe('stopWarning and the editor', () => {
  /**
   * Worded differently from the Claude sentence on purpose: an agent is ENDED
   * by stopping, an editor window is STRANDED — it survives, pointed at
   * something that no longer exists.
   */
  it('says an attached window will be left offering to reload', () => {
    const warning = stopWarning([], [{ kind: 'attached', editors: ['vscode'] }]);
    expect(warning).toContain('VS Code');
    expect(warning).toMatch(/reload/i);
  });

  it('names every attached editor', () => {
    expect(stopWarning([], [{ kind: 'attached', editors: ['cursor', 'vscode'] }])).toContain(
      'Cursor and VS Code',
    );
  });

  it('carries both warnings at once, since Stop does both things', () => {
    const warning = stopWarning(
      [{ kind: 'running', sessions: [{ pid: 1, command: 'claude' }] }],
      [{ kind: 'attached', editors: ['vscode'] }],
    );
    expect(warning).toContain('Claude Code session');
    expect(warning).toContain('VS Code');
  });

  it('is undefined when nothing is attached and nothing is running', () => {
    expect(stopWarning([{ kind: 'none' }], [{ kind: 'none' }])).toBeUndefined();
    expect(stopWarning([], [{ kind: 'not-applicable' }, undefined])).toBeUndefined();
  });

  /** "Could not tell" is not "something is attached" — it must not invent a warning. */
  it('does not warn on an unknown attachment', () => {
    expect(stopWarning([], [{ kind: 'unknown', reason: 'engine went away' }])).toBeUndefined();
  });
});

describe('editorBadge', () => {
  it('names the attached editor', () => {
    const badge = editorBadge({ kind: 'attached', editors: ['vscode'] });
    expect(badge?.label).toBe('VS Code');
    expect(badge?.tone).toBe('attached');
    // The signal is the SERVER, which outlives the window by a few minutes.
    // Saying so is what stops a lingering badge reading as a bug.
    expect(badge?.title).toMatch(/outlives the window/i);
  });

  /**
   * Shows, unlike the branch chip's `unknown`: this decorates a destructive
   * button, so "we could not tell" must not look like "nothing is attached".
   */
  it('says so when it could not tell', () => {
    expect(editorBadge({ kind: 'unknown', reason: 'x' })?.tone).toBe('unknown');
  });

  it('renders nothing for a container with no editor, or one not yet polled', () => {
    expect(editorBadge({ kind: 'none' })).toBeUndefined();
    expect(editorBadge({ kind: 'not-applicable' })).toBeUndefined();
    expect(editorBadge(undefined)).toBeUndefined();
  });
});

describe('editorActions', () => {
  /**
   * The second button appears only once there is a window to distinguish it
   * from. Before that, "Open" and "New window" would do the same thing under
   * two names — and a button that changes meaning without changing appearance
   * is worse than one that arrives when it starts to matter.
   */
  it('offers one action until an editor is attached', () => {
    for (const attachment of [
      undefined,
      { kind: 'none' } as const,
      { kind: 'not-applicable' } as const,
      { kind: 'unknown', reason: 'top failed' } as const,
    ]) {
      const actions = editorActions(attachment, 'VS Code', undefined, false);
      expect(actions.open.label).toBe('Open in VS Code');
      expect(actions.newWindow).toBeUndefined();
    }
  });

  it('splits into focus and new window once one is', () => {
    const actions = editorActions(
      { kind: 'attached', editors: ['vscode'] },
      'VS Code',
      undefined,
      false,
    );

    expect(actions.open.label).toBe('Focus VS Code');
    expect(actions.newWindow?.label).toBe('New window');
    // The primary action must say it opens NOTHING — the whole reason it is
    // worth a separate button from the one beside it.
    expect(actions.open.title).toContain('Nothing new is opened');
    expect(actions.newWindow?.title).toContain('SECOND');
  });

  it('names the attached editor, which need not be the chosen one', () => {
    // The badge reports what is running in the container; the button spawns
    // the editor the user picked in the header. A Cursor server left running
    // in a container is exactly when saying "the Cursor window" matters.
    const actions = editorActions(
      { kind: 'attached', editors: ['cursor'] },
      'VS Code',
      undefined,
      false,
    );
    expect(actions.open.title).toContain('Cursor');
    expect(actions.newWindow?.title).toContain('VS Code');
  });

  it('shortens both for the rows layout, keeping the full text in the title', () => {
    const actions = editorActions(
      { kind: 'attached', editors: ['vscode'] },
      'VS Code',
      undefined,
      true,
    );
    expect(actions.open.label).toBe('Focus');
    expect(actions.newWindow?.label).toBe('+');
    expect(actions.newWindow?.title).toContain('VS Code');
  });

  /**
   * A container with no workspace folder has nothing to open in any number of
   * windows, so the reason wins over both tooltips rather than only the first.
   */
  it('lets the blocked reason speak for both buttons', () => {
    const actions = editorActions(
      { kind: 'attached', editors: ['vscode'] },
      'VS Code',
      'This container does not record which folder to open.',
      false,
    );
    expect(actions.open.title).toBe('This container does not record which folder to open.');
    expect(actions.newWindow?.title).toBe('This container does not record which folder to open.');
  });
});

describe('updatePanel', () => {
  const NOW = new Date('2026-08-03T12:00:00Z').getTime();

  it('names both versions, the file for this machine, and its size', () => {
    const panel = updatePanel(updateAvailable(), NOW, false);

    expect(panel?.headline).toBe('boxwarden 1.2.0 is available');
    expect(panel?.detail).toContain('You are running 1.1.0.');
    expect(panel?.detail).toContain('published 2 days ago');
    expect(panel?.link).toEqual({
      label: 'boxwarden_1.2.0_amd64.deb (91 MB)',
      url: 'https://github.com/sethcarney/boxwarden/releases/download/v1.2.0/boxwarden_1.2.0_amd64.deb',
    });
  });

  /**
   * The banner promises exactly what the app can deliver, which is now more
   * than it was and still not everything: boxwarden fetches and verifies, and
   * the user installs. It must not say "unsigned" — the artefacts ARE signed
   * with cosign — and it must not imply the app fetches or installs anything,
   * because a user who waits for that stops reading the banner.
   */
  it('leaves the download and the install to the user, and does not say "unsigned"', () => {
    const detail = updatePanel(updateAvailable(), NOW, false)?.detail ?? '';
    expect(detail).toContain('your click');
    expect(detail).not.toContain('unsigned');
    expect(detail).not.toContain('boxwarden can fetch');
  });

  it('is nothing at all for every arm that is not an available update', () => {
    expect(
      updatePanel({ currentVersion: '1.1.0', outcome: { kind: 'current' } }, NOW, false),
    ).toBeUndefined();
    expect(
      updatePanel({ currentVersion: '1.1.0', outcome: { kind: 'unchecked' } }, NOW, false),
    ).toBeUndefined();
    expect(
      updatePanel({ currentVersion: '1.1.0', outcome: { kind: 'disabled' } }, NOW, false),
    ).toBeUndefined();
    expect(
      updatePanel(
        {
          currentVersion: '1.1.0',
          outcome: { kind: 'failed', message: 'offline' },
        },
        NOW,
        false,
      ),
    ).toBeUndefined();
  });

  it('stays down once dismissed, and comes back when the user asks for it', () => {
    const status = updateAvailable();
    const dismissed = {
      ...status,
      outcome: { ...status.outcome, dismissed: true },
    } as typeof status;

    expect(updatePanel(dismissed, NOW, false)).toBeUndefined();
    expect(updatePanel(dismissed, NOW, true)).toBeDefined();
  });

  it('sends the user to the release page when no single file matched', () => {
    const status = updateAvailable();
    const { asset: _dropped, ...outcome } = status.outcome as Extract<
      typeof status.outcome,
      { kind: 'available' }
    >;
    const panel = updatePanel({ ...status, outcome }, NOW, false);

    expect(panel?.link).toBeUndefined();
    expect(panel?.releaseUrl).toBe('https://github.com/sethcarney/boxwarden/releases/tag/v1.2.0');
  });
});

describe('updateSummary', () => {
  const NOW = new Date('2026-08-03T12:00:00Z').getTime();

  it('always names the running version — the app says it nowhere else', () => {
    expect(
      updateSummary({ currentVersion: '1.1.0', outcome: { kind: 'unchecked' } }, NOW).label,
    ).toBe('boxwarden 1.1.0');
  });

  /**
   * The distinction the whole feature rests on: an app that reports a check it
   * could not complete as "up to date" is worse than one that never checked.
   */
  it('never reports a failed check as up to date', () => {
    const failed = updateSummary(
      {
        currentVersion: '1.1.0',
        outcome: { kind: 'failed', message: 'GitHub answered HTTP 500.' },
      },
      NOW,
    );

    expect(failed.label).toBe('boxwarden 1.1.0 · update check failed');
    expect(failed.title).toContain('GitHub answered HTTP 500.');
  });

  it('says when checks are off, so the setting can be found again', () => {
    const off = updateSummary({ currentVersion: '1.1.0', outcome: { kind: 'disabled' } }, NOW);
    expect(off.label).toBe('boxwarden 1.1.0 · update checks off');
    expect(off.title).toContain('turn the daily check back on');
  });

  it('reports how long ago the last look was', () => {
    const current = updateSummary(
      {
        currentVersion: '1.1.0',
        checkedAt: new Date('2026-08-03T09:00:00Z'),
        outcome: { kind: 'current' },
      },
      NOW,
    );
    expect(current.label).toBe('boxwarden 1.1.0 · up to date');
    expect(current.title).toContain('Last checked 3 hours ago.');
  });

  it('still points at a dismissed update rather than going silent', () => {
    const status = updateAvailable();
    const dismissed = {
      ...status,
      outcome: { ...status.outcome, dismissed: true },
    } as typeof status;

    expect(updateSummary(dismissed, NOW).label).toBe('boxwarden 1.1.0 · 1.2.0 available');
    expect(updateSummary(dismissed, NOW).title).toContain('You said not now');
  });

  it('says a development build is one, rather than claiming to be up to date', () => {
    const dev = updateSummary(
      {
        currentVersion: '0.0.0',
        outcome: { kind: 'unsupported', reason: 'This is a development build.' },
      },
      NOW,
    );
    expect(dev.label).toBe('boxwarden 0.0.0 · development build');
  });
});
