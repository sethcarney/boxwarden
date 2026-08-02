// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeGroup } from './ComposeGroup.js';
import { devContainer } from '../test-fixtures.js';
import { asContainerId } from '../../models/index.js';
import type { DevContainer } from '../../models/index.js';

const RUNNING = { state: 'running', startedAt: new Date(), ports: [] } as const;
const EXITED = { state: 'exited', exitCode: 0, finishedAt: new Date() } as const;

function member(name: string, runtime: DevContainer['runtime']): DevContainer {
  return devContainer({
    id: asContainerId(name.padEnd(64, '0')),
    name,
    runtime,
    labels: { localFolderRaw: '/home/dev/code/platform', composeProject: 'platform' },
  });
}

function renderGroup(containers: readonly DevContainer[], busy = false) {
  const onStartAll = vi.fn();
  const onStopAll = vi.fn();
  render(
    <ComposeGroup
      project="platform"
      containers={containers}
      busy={busy}
      onStartAll={onStartAll}
      onStopAll={onStopAll}
    >
      <div>cards</div>
    </ComposeGroup>,
  );
  return { onStartAll, onStopAll };
}

describe('ComposeGroup', () => {
  it('names the project once, at group level', () => {
    renderGroup([member('app', RUNNING)]);
    expect(screen.getByRole('heading', { name: 'platform' })).toBeDefined();
    expect(screen.getByText('compose')).toBeDefined();
  });

  it('reports how many of the project’s containers are up', () => {
    renderGroup([member('app', RUNNING), member('db', RUNNING), member('cache', EXITED)]);
    expect(screen.getByText('2 of 3 running')).toBeDefined();
  });

  it('renders the member cards passed as children', () => {
    renderGroup([member('app', RUNNING)]);
    expect(screen.getByText('cards')).toBeDefined();
  });

  /**
   * The whole point of grouping: stopping the workspace container alone leaves
   * the database running, which is the state this app exists to get people out
   * of. "Stop all" must hand back every member, not just the one clicked.
   */
  it('passes every member to onStopAll', async () => {
    const members = [member('app', RUNNING), member('db', RUNNING)];
    const { onStopAll } = renderGroup(members);

    await userEvent.click(screen.getByRole('button', { name: 'Stop all' }));
    expect(onStopAll).toHaveBeenCalledTimes(1);
    expect(onStopAll.mock.calls[0]?.[0]).toHaveLength(2);
  });

  describe('which actions are offered', () => {
    it('offers only Stop all when everything is already running', () => {
      renderGroup([member('app', RUNNING), member('db', RUNNING)]);
      expect(screen.getByRole('button', { name: 'Stop all' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Start all' })).toBeNull();
    });

    it('offers only Start all when everything is stopped', () => {
      renderGroup([member('app', EXITED), member('db', EXITED)]);
      expect(screen.getByRole('button', { name: 'Start all' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull();
    });

    /**
     * Partially-up is the case that matters. Offering both is deliberate:
     * disabling "Start all" because two of three are already running would
     * leave no way to finish the job except clicking into each card.
     */
    it('offers both when the project is partially up', () => {
      renderGroup([member('app', RUNNING), member('db', EXITED)]);
      expect(screen.getByRole('button', { name: 'Start all' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Stop all' })).toBeDefined();
    });
  });

  it('disables group actions while the group is busy', () => {
    renderGroup([member('app', RUNNING)], true);
    const button = screen.getByRole('button', { name: 'Working…' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
