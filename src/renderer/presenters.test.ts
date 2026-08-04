import { describe, expect, it } from 'vitest';
import type { ClaudeStatus, EngineId } from '../models/index.js';
import { devContainer } from './test-fixtures.js';
import {
  claudeBadge,
  claudeStopWarning,
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
  visiblePorts,
} from './presenters.js';
import { snapshot, unreachableSnapshot } from './viewmodels/test-api.js';

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

describe('claudeStopWarning', () => {
  it('says nothing when nothing is running', () => {
    expect(claudeStopWarning([])).toBeUndefined();
    expect(
      claudeStopWarning([{ kind: 'none' }, undefined, { kind: 'not-applicable' }]),
    ).toBeUndefined();
  });

  /**
   * A "could not tell" is not a warning. Annotating every unreadable container
   * would train the user to ignore the annotation, which costs more than the
   * case it covers.
   */
  it('says nothing for a container it could not read', () => {
    expect(claudeStopWarning([{ kind: 'unknown', reason: 'nope' }])).toBeUndefined();
  });

  /** The compose case: "Stop all" reaches services whose cards nobody read. */
  it('aggregates across a group and pluralises', () => {
    const one: readonly (ClaudeStatus | undefined)[] = [
      { kind: 'running', sessions: [{ pid: 1, command: 'claude' }] },
      { kind: 'none' },
    ];
    expect(claudeStopWarning(one)).toBe(
      'A Claude Code session is running in here. Stopping ends it.',
    );

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
    expect(claudeStopWarning(several)).toBe(
      '3 Claude Code sessions are running in here. Stopping ends them.',
    );
  });
});
