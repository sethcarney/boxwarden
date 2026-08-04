// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EngineId, EngineSummary } from '../../models/index.js';
import { EnginePicker } from './EnginePicker.js';

const dockerEngine: EngineSummary = {
  id: 'unix:/var/run/docker.sock' as EngineId,
  runtime: 'docker-engine',
  serverVersion: '29.3.1',
  transport: { transport: 'unix', socketPath: '/var/run/docker.sock' },
  origin: { kind: 'well-known', runtime: 'docker-engine' },
};

const podmanInWsl: EngineSummary = {
  id: 'wsl:dev:/run/user/1000/podman/podman.sock' as EngineId,
  runtime: 'podman',
  serverVersion: '5.7.0',
  transport: { transport: 'wsl', distro: 'dev', socketPath: '/run/user/1000/podman/podman.sock' },
  origin: { kind: 'wsl', distro: 'dev', runtime: 'podman' },
};

describe('EnginePicker', () => {
  /** A control with one option cannot change anything, and the header is short. */
  it('stays hidden until there is a choice to make', () => {
    const { container } = render(
      <EnginePicker
        engines={[dockerEngine]}
        selection={{ kind: 'all' }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('offers the union first, then each engine', () => {
    render(
      <EnginePicker
        engines={[dockerEngine, podmanInWsl]}
        selection={{ kind: 'all' }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options[0]).toBe('All engines (2)');
    expect(options).toHaveLength(3);
  });

  /**
   * A Windows machine running podman answers as "Podman 5.7.0" on both a named
   * pipe and a WSL relay. Two options reading identically is worse than no
   * picker at all, so the qualifier is not decoration.
   */
  it('distinguishes engines that would otherwise read the same', () => {
    render(
      <EnginePicker
        engines={[dockerEngine, podmanInWsl]}
        selection={{ kind: 'all' }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Podman 5.7.0 (WSL: dev)')).toBeDefined();
    expect(screen.getByText('Docker 29.3.1 (/var/run/docker.sock)')).toBeDefined();
  });

  it('reports the chosen engine by id', async () => {
    const onChange = vi.fn();
    render(
      <EnginePicker
        engines={[dockerEngine, podmanInWsl]}
        selection={{ kind: 'all' }}
        disabled={false}
        onChange={onChange}
      />,
    );

    await userEvent.selectOptions(screen.getByRole('combobox'), podmanInWsl.id);
    expect(onChange).toHaveBeenCalledWith({ kind: 'only', id: podmanInWsl.id });
  });

  /**
   * A selection naming an engine that stopped answering must stay visible. If
   * the <select> fell back to "All engines" it would silently change what the
   * user asked for, on a scan where the honest answer is "the thing you picked
   * is not there" — which the accompanying advisory says.
   */
  it('keeps showing a selected engine that has stopped answering', () => {
    render(
      <EnginePicker
        engines={[dockerEngine]}
        selection={{ kind: 'only', id: podmanInWsl.id }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    const stale = screen.getByText(`${podmanInWsl.id} (not answering)`);
    expect(stale).toBeDefined();
    expect(screen.getByRole('combobox')).toHaveProperty('value', podmanInWsl.id);
  });
});
