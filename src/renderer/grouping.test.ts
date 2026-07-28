import { describe, expect, it } from 'vitest';
import { groupContainers, groupMembers } from './grouping.js';
import { devContainer } from './test-fixtures.js';
import { asContainerId } from '../domain/index.js';
import type { DevContainer } from '../domain/index.js';

function named(name: string, project?: string): DevContainer {
  return devContainer({
    id: asContainerId(name.padEnd(64, '0')),
    name,
    labels: {
      localFolderRaw: '/home/dev/code/x',
      ...(project === undefined ? {} : { composeProject: project }),
    },
  });
}

describe('groupContainers', () => {
  it('leaves standalone containers as singles', () => {
    const groups = groupContainers([named('a'), named('b')]);
    expect(groups.map((g) => g.kind)).toEqual(['single', 'single']);
  });

  it('collects every member of a compose project into one group', () => {
    const groups = groupContainers([
      named('app', 'platform'),
      named('db', 'platform'),
      named('cache', 'platform'),
    ]);
    expect(groups).toHaveLength(1);
    const only = groups[0];
    expect(only?.kind).toBe('compose');
    expect(only === undefined ? [] : groupMembers(only).map((c) => c.name)).toEqual([
      'app',
      'db',
      'cache',
    ]);
  });

  it('keeps separate projects separate', () => {
    const groups = groupContainers([
      named('app', 'platform'),
      named('web', 'storefront'),
      named('db', 'platform'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => (g.kind === 'compose' ? g.project : ''))).toEqual([
      'platform',
      'storefront',
    ]);
  });

  /**
   * The caller sorts running-first. A project must take the position of its
   * FIRST member, or a project whose workspace is running would sink below
   * stopped singles because of a stopped sibling further down the list.
   */
  it('places a project where its first member appeared', () => {
    const groups = groupContainers([
      named('solo-1'),
      named('app', 'platform'),
      named('solo-2'),
      named('db', 'platform'),
    ]);
    expect(groups.map((g) => (g.kind === 'single' ? g.container.name : g.project))).toEqual([
      'solo-1',
      'platform',
      'solo-2',
    ]);
  });

  it('keeps a one-container project as a compose group, not a single', () => {
    const groups = groupContainers([named('app', 'platform')]);
    // Still compose-managed: collapsing it would hide the warning that actions
    // do not cover siblings which may appear later.
    expect(groups[0]?.kind).toBe('compose');
  });

  it('produces stable, distinct keys', () => {
    const groups = groupContainers([named('a'), named('app', 'platform'), named('db', 'platform')]);
    const keys = groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('compose:platform');
  });

  it('handles an empty list', () => {
    expect(groupContainers([])).toEqual([]);
  });
});
