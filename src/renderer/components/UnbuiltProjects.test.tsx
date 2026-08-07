// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DevContainerProject, ProjectScan } from '../../models/index.js';
import { asProjectId } from '../../models/index.js';
import { summariseProjects } from '../presenters.js';
import type { ProjectsViewModel } from '../viewmodels/index.js';
import { UnbuiltProjects } from './UnbuiltProjects.js';

/**
 * A View test: it drives the panel from a hand-built `ProjectsViewModel` and
 * asserts only on what is rendered. The partitioning that decides which
 * projects are unbuilt now lives in the ViewModel and is tested in
 * `viewmodels/useProjects.test.ts` — asserting it here as well would be testing
 * the same fold through a DOM.
 */

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

interface VmOptions {
  readonly scan?: ProjectScan | undefined;
  readonly unbuilt?: readonly DevContainerProject[];
  readonly built?: readonly DevContainerProject[];
  readonly scanning?: boolean;
  readonly rescan?: () => void;
  readonly addRoot?: () => void;
  readonly removeRoot?: (root: string) => void;
  readonly openProject?: (project: DevContainerProject) => void;
}

/** The real `summariseProjects` is used so the summary assertions stay honest. */
function projectsVm(options: VmOptions = {}): ProjectsViewModel {
  const current = 'scan' in options ? options.scan : scan();
  const unbuilt = options.unbuilt ?? [project()];
  const built = options.built ?? [];
  const scanning = options.scanning ?? false;

  return {
    scan: current,
    scanning,
    unbuilt,
    built,
    summary: summariseProjects(unbuilt.length, built.length, scanning),
    truncated: current?.truncated ?? false,
    idle: current === undefined && !scanning,
    rescan: options.rescan ?? vi.fn(),
    addRoot: options.addRoot ?? vi.fn(),
    removeRoot: options.removeRoot ?? vi.fn(),
    openProject: options.openProject ?? vi.fn(),
  };
}

function renderPanel(options: VmOptions = {}, editorAvailable = true) {
  return render(
    <UnbuiltProjects
      projects={projectsVm(options)}
      editorName="VS Code"
      editorAvailable={editorAvailable}
      now={NOW}
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
   * The panel's whole job is the gap between disk and Docker. With nothing in
   * that gap it must say so rather than rendering an empty frame — an empty
   * list and "everything is built" are indistinguishable on screen and mean
   * opposite things.
   */
  it('says so when every project on disk is already built', () => {
    renderPanel({ unbuilt: [], built: [project()] });
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
    renderPanel({}, false);
    const button = screen.getByRole('button', { name: 'Open in VS Code' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toContain('not found');
  });

  it('passes the project back on open', async () => {
    const openProject = vi.fn();
    renderPanel({ openProject });
    await userEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }));
    expect(openProject).toHaveBeenCalledWith(project());
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
    const removeRoot = vi.fn();
    renderPanel({ removeRoot });
    await userEvent.click(screen.getByRole('button', { name: 'Stop scanning /home/dev' }));
    expect(removeRoot).toHaveBeenCalledWith('/home/dev');
  });

  it('collapses a long list behind a count', async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      project({
        id: asProjectId(`/home/dev/p${String(index)}/.devcontainer/devcontainer.json`),
        name: `project ${String(index)}`,
        folder: { kind: 'posix', path: `/home/dev/p${String(index)}` },
        configPath: `/home/dev/p${String(index)}/.devcontainer/devcontainer.json`,
      }),
    );
    renderPanel({ unbuilt: many });

    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(9);
  });
});

describe('collapsing the panel', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts open, so nothing that used to be visible has quietly gone away', () => {
    renderPanel();
    expect(
      screen.getByRole('button', { name: /Not built yet/ }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('folds the body away when the heading is clicked', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Not built yet/ }));

    expect(
      screen.getByRole('button', { name: /Not built yet/ }).getAttribute('aria-expanded'),
    ).toBe('false');
    // Unmounted, not hidden: a folded panel must not leave a dozen Open buttons
    // in the tab order.
    expect(screen.queryByRole('button', { name: /Open in/ })).toBeNull();
  });

  /** Rescan stays reachable — it is what refills a panel you folded away. */
  it('keeps the Rescan button while collapsed', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Not built yet/ }));
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeDefined();
  });

  /**
   * The count follows the title into the collapsed state: folding the panel
   * must not also hide the one number that says whether it is worth opening.
   */
  it('shows the count once collapsed', async () => {
    renderPanel({
      unbuilt: [project(), project({ id: asProjectId('other'), name: 'Reporting' })],
    });
    await userEvent.click(screen.getByRole('button', { name: /Not built yet/ }));
    expect(screen.getByRole('button', { name: /Not built yet/ }).textContent).toContain('2');
  });

  /** A panel that reopened on every launch is one whose collapse button stops being used. */
  it('remembers being collapsed across a remount', async () => {
    const first = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Not built yet/ }));
    first.unmount();

    renderPanel();
    expect(
      screen.getByRole('button', { name: /Not built yet/ }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});
