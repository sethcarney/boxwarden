import { describe, expect, it } from 'vitest';
import type { DesktopWindow, DevContainer } from './index.js';
import {
  asContainerId,
  asContainerPath,
  declaredContainerName,
  editorWindowCriteria,
  flavoursOf,
  matchEditorWindows,
  namesWorkspace,
  parseDevContainerTitle,
  parseWindowTable,
  parseWmctrlLine,
  windowFlavour,
} from './index.js';

function container(overrides: Partial<DevContainer> = {}): DevContainer {
  return {
    id: asContainerId('abc123'),
    name: 'boxwarden_devcontainer-app-1',
    image: 'mcr.microsoft.com/devcontainers/typescript-node',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    localFolder: { kind: 'posix', path: '/Users/seth/code/boxwarden' },
    workspaceFolder: asContainerPath('/workspaces/boxwarden'),
    sshAgent: { kind: 'absent' },
    labels: { localFolderRaw: '/Users/seth/code/boxwarden' },
    runtime: { state: 'running', startedAt: new Date('2026-01-01T00:00:00Z'), ports: [] },
    ...overrides,
  };
}

function window(process: string, title: string, handle = '1'): DesktopWindow {
  return { handle, process, title };
}

describe('windowFlavour', () => {
  it('recognises each editor by its process name', () => {
    expect(windowFlavour('Code')).toBe('vscode');
    expect(windowFlavour('Code - Insiders')).toBe('vscode-insiders');
    expect(windowFlavour('Cursor')).toBe('cursor');
    expect(windowFlavour('Windsurf')).toBe('windsurf');
  });

  it('strips the Windows executable extension', () => {
    expect(windowFlavour('Code.exe')).toBe('vscode');
  });

  // The reason PROCESS_NAMES is matched by equality rather than by prefix:
  // `code` is a prefix of `code - insiders`, which is the same trap
  // SERVER_DIRECTORIES has to order around.
  it('does not let stable claim the Insiders process, or the reverse', () => {
    expect(windowFlavour('code-insiders')).toBe('vscode-insiders');
    expect(windowFlavour('codex')).toBeUndefined();
  });

  it('answers undefined for anything that is not an editor we know', () => {
    expect(windowFlavour('firefox')).toBeUndefined();
    expect(windowFlavour('')).toBeUndefined();
  });
});

describe('parseDevContainerTitle', () => {
  it('answers undefined for an ordinary window', () => {
    expect(parseDevContainerTitle('index.ts - boxwarden - Visual Studio Code')).toBeUndefined();
    expect(parseDevContainerTitle('Slack')).toBeUndefined();
  });

  it('splits at the remote marker and reads the declared name', () => {
    const parsed = parseDevContainerTitle(
      'ContainerCard.tsx - boxwarden [Dev Container: boxwarden] - Visual Studio Code',
    );
    expect(parsed).toEqual({ beforeMarker: 'ContainerCard.tsx - boxwarden', label: 'boxwarden' });
  });

  it('handles a window with no editor open', () => {
    expect(parseDevContainerTitle('boxwarden [Dev Container: bw] - Cursor')).toEqual({
      beforeMarker: 'boxwarden',
      label: 'bw',
    });
  });

  // The older spelling, and the reason the marker matched is the opening
  // bracket rather than the whole indicator.
  it('reads a marker that names no container', () => {
    expect(parseDevContainerTitle('boxwarden [Dev Container] - Visual Studio Code')).toEqual({
      beforeMarker: 'boxwarden',
    });
  });
});

describe('namesWorkspace', () => {
  it('matches the whole title when nothing else is in it', () => {
    expect(namesWorkspace('boxwarden', 'boxwarden')).toBe(true);
  });

  it('matches the workspace name after a separator', () => {
    expect(namesWorkspace('ContainerCard.tsx - boxwarden', 'boxwarden')).toBe(true);
    expect(namesWorkspace('README.md — boxwarden', 'boxwarden')).toBe(true);
  });

  // The one that matters: a substring test here closes somebody else's editor.
  it('refuses a name that is only a suffix of a longer word', () => {
    expect(namesWorkspace('boxwarden', 'warden')).toBe(false);
    expect(namesWorkspace('file.ts - myboxwarden', 'boxwarden')).toBe(false);
  });

  // Why the boundary is whitespace and not "any non-letter": `-`, `_` and `.`
  // are all ordinary characters INSIDE a folder name, and only a separator with
  // spaces around it is evidence the name started here.
  it('refuses a longer folder name that ends in the shorter one behind punctuation', () => {
    expect(namesWorkspace('not-boxwarden', 'boxwarden')).toBe(false);
    expect(namesWorkspace('x.ts - old_boxwarden', 'boxwarden')).toBe(false);
    expect(namesWorkspace('x.ts - fork.boxwarden', 'boxwarden')).toBe(false);
  });

  it('refuses a name that is not at the end', () => {
    expect(namesWorkspace('boxwarden - other', 'boxwarden')).toBe(false);
  });

  it('ignores case, because two of the three platforms do', () => {
    expect(namesWorkspace('file.ts - BoxWarden', 'boxwarden')).toBe(true);
  });

  it('refuses an empty name rather than matching everything', () => {
    expect(namesWorkspace('anything at all', '')).toBe(false);
  });
});

describe('declaredContainerName', () => {
  it('answers undefined when there is no metadata', () => {
    expect(declaredContainerName(undefined)).toBeUndefined();
  });

  it('answers undefined for metadata that is not JSON', () => {
    expect(declaredContainerName('{not json')).toBeUndefined();
  });

  // Same rule as resolveRemoteUser, and for the same reason: the label is
  // ordered image → features → devcontainer.json, and later entries override.
  it('takes the LAST name, so devcontainer.json beats a feature', () => {
    const raw = JSON.stringify([{ name: 'base image' }, { id: 'node' }, { name: 'boxwarden' }]);
    expect(declaredContainerName(raw)).toBe('boxwarden');
  });

  it('reads a single object as well as an array', () => {
    expect(declaredContainerName(JSON.stringify({ name: 'solo' }))).toBe('solo');
  });

  it('ignores a name that is not a string, or is blank', () => {
    expect(declaredContainerName(JSON.stringify([{ name: 7 }]))).toBeUndefined();
    expect(declaredContainerName(JSON.stringify([{ name: '   ' }]))).toBeUndefined();
  });
});

describe('editorWindowCriteria', () => {
  it('carries both spellings of the workspace name', () => {
    const criteria = editorWindowCriteria(
      container({
        localFolder: { kind: 'posix', path: '/Users/seth/code/bw-checkout' },
        labels: { localFolderRaw: '/Users/seth/code/bw-checkout' },
      }),
      ['vscode'],
    );
    expect(criteria.names).toEqual(['boxwarden', 'bw-checkout']);
  });

  it('drops the `unknown` flavour rather than trying to match a process for it', () => {
    expect(editorWindowCriteria(container(), ['unknown']).editors).toEqual([]);
  });

  it('carries the declared name when the metadata label has one', () => {
    const criteria = editorWindowCriteria(
      container({
        labels: {
          localFolderRaw: '/Users/seth/code/boxwarden',
          metadataRaw: JSON.stringify([{ name: 'boxwarden dev' }]),
        },
      }),
      [],
    );
    expect(criteria.label).toBe('boxwarden dev');
  });
});

describe('matchEditorWindows', () => {
  const criteria = editorWindowCriteria(container(), ['vscode']);

  it('matches the container’s own window', () => {
    const target = window(
      'Code',
      'ContainerCard.tsx - boxwarden [Dev Container: boxwarden] - Visual Studio Code',
    );
    expect(matchEditorWindows([target], criteria)).toEqual([target]);
  });

  it('ignores a window with no dev container marker', () => {
    expect(
      matchEditorWindows([window('Code', 'boxwarden - Visual Studio Code')], criteria),
    ).toEqual([]);
  });

  it('ignores a process that is not an editor', () => {
    expect(
      matchEditorWindows(
        [window('firefox', 'boxwarden [Dev Container: boxwarden] — Mozilla Firefox')],
        criteria,
      ),
    ).toEqual([]);
  });

  it('ignores an editor other than the one attached to this container', () => {
    expect(
      matchEditorWindows(
        [window('Cursor', 'boxwarden [Dev Container: boxwarden] - Cursor')],
        criteria,
      ),
    ).toEqual([]);
  });

  // `unknown` attachment: we could not read the process table, so any editor is
  // a candidate. Narrowing to none there would strand a window over one failed
  // `top`.
  it('matches any known editor when no flavour was reported', () => {
    const anyEditor = editorWindowCriteria(container(), []);
    const target = window('Cursor', 'boxwarden [Dev Container: boxwarden] - Cursor');
    expect(matchEditorWindows([target], anyEditor)).toEqual([target]);
  });

  it('ignores another container whose folder merely ends in a similar word', () => {
    expect(
      matchEditorWindows(
        [window('Code', 'x.ts - not-boxwarden [Dev Container: other] - Visual Studio Code')],
        criteria,
      ),
    ).toEqual([]);
  });

  it('refuses a same-named folder whose declared container name disagrees', () => {
    const named = editorWindowCriteria(
      container({
        labels: {
          localFolderRaw: '/Users/seth/code/boxwarden',
          metadataRaw: JSON.stringify([{ name: 'boxwarden' }]),
        },
      }),
      ['vscode'],
    );
    expect(
      matchEditorWindows(
        [window('Code', 'boxwarden [Dev Container: someone elses] - Visual Studio Code')],
        named,
      ),
    ).toEqual([]);
  });

  it('matches every window on the container, not just the first', () => {
    const windows = [
      window('Code', 'a.ts - boxwarden [Dev Container: boxwarden] - Visual Studio Code', '1'),
      window('Code', 'b.ts - boxwarden [Dev Container: boxwarden] - Visual Studio Code', '2'),
    ];
    expect(matchEditorWindows(windows, criteria)).toHaveLength(2);
  });

  /**
   * The failure this file is written to reach: a container that says nothing
   * about its own folder must match NOTHING, rather than falling back to
   * something looser. `exactOptionalPropertyTypes` will not let
   * `workspaceFolder: undefined` be spread in, so the key is deleted — which is
   * exactly the shape `mapContainer` produces for a container with no workspace.
   */
  it('matches nothing when the container named no folder at all', () => {
    const bare = {
      ...container({
        localFolder: { kind: 'unresolved', raw: '', reason: 'empty label' },
        labels: { localFolderRaw: '' },
      }),
    } as Record<string, unknown>;
    delete bare['workspaceFolder'];

    const nameless = editorWindowCriteria(bare as unknown as DevContainer, ['vscode']);
    expect(
      matchEditorWindows(
        [window('Code', 'boxwarden [Dev Container: boxwarden] - Visual Studio Code')],
        nameless,
      ),
    ).toEqual([]);
  });
});

describe('flavoursOf', () => {
  it('deduplicates, because one container can have several windows', () => {
    expect(
      flavoursOf([window('Code', 'a', '1'), window('Code', 'b', '2'), window('Cursor', 'c', '3')]),
    ).toEqual(['vscode', 'cursor']);
  });
});

describe('parseWindowTable', () => {
  it('reads handle, process and title', () => {
    expect(
      parseWindowTable('123\tCode\tboxwarden [Dev Container: bw] - Visual Studio Code\n'),
    ).toEqual([
      {
        handle: '123',
        process: 'Code',
        title: 'boxwarden [Dev Container: bw] - Visual Studio Code',
      },
    ]);
  });

  it('keeps a title that contains a tab rather than truncating it', () => {
    expect(parseWindowTable('7\tCode\tone\ttwo')[0]?.title).toBe('one\ttwo');
  });

  it('skips blank lines and rows with no title', () => {
    expect(parseWindowTable('\n1\tCode\n\n2\tCode\t\n')).toEqual([]);
  });
});

describe('parseWmctrlLine', () => {
  it('reads the id, the pid and the whole title', () => {
    expect(
      parseWmctrlLine('0x04600007  0 3821   seth-box boxwarden [Dev Container: bw] - Code'),
    ).toEqual({ handle: '0x04600007', pid: 3821, title: 'boxwarden [Dev Container: bw] - Code' });
  });

  it('skips a sticky window with no title', () => {
    expect(parseWmctrlLine('0x03400003 -1 0      seth-box ')).toBeUndefined();
  });

  it('skips anything that is not a wmctrl row', () => {
    expect(parseWmctrlLine('wmctrl: command not found')).toBeUndefined();
  });
});
