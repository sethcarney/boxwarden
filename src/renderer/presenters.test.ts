import { describe, expect, it } from 'vitest';
import type { EngineId } from '../models/index.js';
import { devContainer } from './test-fixtures.js';
import {
  containerCountLabel,
  emptyListMessage,
  engineChip,
  errorMessage,
  openBlockedReason,
  portLabel,
  scanRootHint,
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
