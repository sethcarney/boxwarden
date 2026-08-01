// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DevContainerProject, ProjectScan } from '../../models/index.js';
import { asProjectId } from '../../models/index.js';
import { devContainer } from '../test-fixtures.js';
import { UnbuiltProjects } from './UnbuiltProjects.js';

function project(overrides: Partial<DevContainerProject> = {}): DevContainerProject {
  return {
    id: asProjectId('/home/dev/code/api/.devcontainer/devcontainer.json'),
    name: 'Payments API',
    folder: { kind: 'posix', path: '/home/dev/code/api' },
    configPath: '/home/dev/code/api/.devcontainer/devcontainer.json',
    configLabel: '.devcontainer/devcontainer.json',
    root: '/home/dev',
    ...overrides,
  };
}

function scan(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    scannedAt: new Date('2026-08-01T12:00:00Z'),
    roots: [{ path: '/home/dev', source: 'default', found: 1 }],
    projects: [project()],
    truncated: false,
    elapsedMs: 120,
    ...overrides,
  };
}

const NOW = new Date('2026-08-01T12:00:10Z').getTime();

function renderPanel(props: Partial<Parameters<typeof UnbuiltProjects>[0]> = {}) {
  return render(
    <UnbuiltProjects
      scan={scan()}
      containers={[]}
      editorName="VS Code"
      editorAvailable
      scanning={false}
      now={NOW}
      onOpen={vi.fn()}
      onRescan={vi.fn()}
      onAddRoot={vi.fn()}
      onRemoveRoot={vi.fn()}
      {...props}
    />,
  );
}

describe('UnbuiltProjects', () => {
  it('lists a project that has no container', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Payments API' })).toBeTruthy();
    expect(screen.getByText('/home/dev/code/api')).toBeTruthy();
  });

  /**
   * The panel's whole job is the gap between disk and Docker. A project that is
   * already in the list above is not in that gap, and repeating it there would
   * make "not built yet" a lie.
   */
  it('hides a project once a container claims its folder', () => {
    renderPanel({
      containers: [devContainer({ localFolder: { kind: 'posix', path: '/home/dev/code/api' } })],
    });
    expect(screen.queryByRole('heading', { name: 'Payments API' })).toBeNull();
    expect(screen.getByText(/has been built/)).toBeTruthy();
  });

  it('stays out of the way entirely before the first scan', () => {
    const { container } = renderPanel({ scan: undefined, scanning: false });
    expect(container.firstChild).toBeNull();
  });

  /** A truncated scan and a complete one look identical, and mean opposite things. */
  it('says when the scan gave up early', () => {
    renderPanel({ scan: scan({ truncated: true }) });
    expect(screen.getByText(/stopped early/)).toBeTruthy();
  });

  it('disables opening when the chosen editor is not installed, and says why', () => {
    renderPanel({ editorAvailable: false });
    const button = screen.getByRole('button', { name: 'Open in VS Code' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toContain('not found');
  });

  it('passes the project back on open', async () => {
    const onOpen = vi.fn();
    renderPanel({ onOpen });
    await userEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }));
    expect(onOpen).toHaveBeenCalledWith(project());
  });

  it('offers the devcontainer up command for the folder, rather than running it', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Copy devcontainer up' }).getAttribute('title')).toBe(
      'devcontainer up --workspace-folder /home/dev/code/api',
    );
  });

  it('names each root and what it found, so an empty list is explainable', () => {
    renderPanel({
      scan: scan({
        roots: [
          { path: '/home/dev', source: 'default', found: 1 },
          { path: '/mnt/d/work', source: 'user', found: 0, failure: 'missing' },
        ],
      }),
    });
    expect(screen.getByText(/1 found/)).toBeTruthy();
    expect(screen.getByText(/no such folder/)).toBeTruthy();
  });

  it('removes a root by its path', async () => {
    const onRemoveRoot = vi.fn();
    renderPanel({ onRemoveRoot });
    await userEvent.click(screen.getByRole('button', { name: 'Stop scanning /home/dev' }));
    expect(onRemoveRoot).toHaveBeenCalledWith('/home/dev');
  });

  it('collapses a long list behind a count', async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      project({
        id: asProjectId(`/home/dev/p${index}/.devcontainer/devcontainer.json`),
        name: `project ${index}`,
        folder: { kind: 'posix', path: `/home/dev/p${index}` },
        configPath: `/home/dev/p${index}/.devcontainer/devcontainer.json`,
      }),
    );
    renderPanel({ scan: scan({ projects: many }) });

    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(9);
  });
});
