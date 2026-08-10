import { describe, expect, it } from 'vitest';
import type { DevContainer } from '../../models/index.js';
import { asContainerId, asContainerPath } from '../../models/index.js';
import { closeAttachedEditorWindows, desktopBackend } from './close.js';
import { isWaylandSession } from './linux.js';
import { isAccessibilityRefusal } from './macos.js';

describe('isWaylandSession', () => {
  it('believes XDG_SESSION_TYPE', () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'x11' })).toBe(false);
  });

  // XWayland: both variables set means there IS an X server and wmctrl can
  // reach whatever is running under it, so this is not the Wayland answer.
  it('does not call an XWayland session Wayland', () => {
    expect(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(false);
  });

  it('calls a Wayland display with no X display Wayland', () => {
    expect(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });

  it('says no when neither variable is set', () => {
    expect(isWaylandSession({})).toBe(false);
  });
});

describe('isAccessibilityRefusal', () => {
  // Matched on the numbers as well as the words, because the words are
  // localised and the numbers are not.
  it('recognises the refusal by its error number', () => {
    expect(isAccessibilityRefusal('execution error: … (-1719)')).toBe(true);
    expect(isAccessibilityRefusal('L’application n’est pas autorisée (-25211)')).toBe(true);
  });

  it('recognises the English wording', () => {
    expect(isAccessibilityRefusal('osascript is not allowed assistive access. (-1728)')).toBe(true);
  });

  it('does not claim an ordinary script error is a permission problem', () => {
    expect(isAccessibilityRefusal('execution error: Expected end of line but found “tell”.')).toBe(
      false,
    );
  });
});

describe('desktopBackend', () => {
  it('offers a backend on the three platforms that have one', async () => {
    await expect(desktopBackend('win32', {})).resolves.toMatchObject({ ok: true });
    await expect(desktopBackend('darwin', {})).resolves.toMatchObject({ ok: true });
  });

  // Not a failure and not a silent no-op: an arm that says what this machine
  // cannot do, so the message bar can say it too.
  it('declines on a platform with no window manager we can ask', async () => {
    const result = await desktopBackend('freebsd', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unsupported.reason).toContain('freebsd');
  });

  it('names Wayland as the reason on a Wayland session', async () => {
    const result = await desktopBackend('linux', { XDG_SESSION_TYPE: 'wayland', PATH: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unsupported.reason).toContain('Wayland');
  });

  it('names wmctrl as the reason on an X11 session without it', async () => {
    const result = await desktopBackend('linux', { XDG_SESSION_TYPE: 'x11', PATH: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unsupported.reason).toContain('wmctrl');
  });
});

describe('closeAttachedEditorWindows', () => {
  const container: DevContainer = {
    id: asContainerId('abc'),
    name: 'web-app',
    image: 'node',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    localFolder: { kind: 'posix', path: '/Users/dev/projects/web-app' },
    workspaceFolder: asContainerPath('/workspaces/web-app'),
    sshAgent: { kind: 'absent' },
    labels: { localFolderRaw: '/Users/dev/projects/web-app' },
    runtime: { state: 'running', startedAt: new Date('2026-01-01T00:00:00Z'), ports: [] },
  };

  it('does nothing, and spawns nothing, when no editor is attached', async () => {
    await expect(
      closeAttachedEditorWindows(container, { kind: 'none' }, 'linux', {}),
    ).resolves.toEqual({ kind: 'none' });
    await expect(
      closeAttachedEditorWindows(container, { kind: 'not-applicable' }, 'linux', {}),
    ).resolves.toEqual({ kind: 'none' });
  });

  /**
   * The fixtures are fabricated and this is the one action that reaches outside
   * the app. A developer running `dev:fake` can easily have a REAL container
   * open on a folder whose basename matches a fixture's, so this is refused
   * rather than made careful.
   */
  it('refuses to touch a real desktop while the container list is fixtures', async () => {
    const result = await closeAttachedEditorWindows(
      container,
      { kind: 'attached', editors: ['vscode'] },
      'linux',
      { BOXWARDEN_FAKE_DOCKER: '1' },
    );
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('BOXWARDEN_FAKE_DOCKER');
  });

  it('reports the desktop it cannot ask, rather than failing silently', async () => {
    const result = await closeAttachedEditorWindows(
      container,
      { kind: 'attached', editors: ['vscode'] },
      'linux',
      { XDG_SESSION_TYPE: 'wayland', PATH: '' },
    );
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('Wayland');
  });
});
