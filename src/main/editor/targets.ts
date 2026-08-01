import type { EditorDiscovery, EditorTarget, KnownEditorId } from '../../models/index.js';

/**
 * Editor definitions as DATA, per the domain's design: adding a VS Code fork
 * should be an entry in this file, not a new branch in the resolver.
 *
 * Discovery order per editor is deliberate. `code` on PATH is checked first
 * because when it is there it is unambiguous and instant. The macOS app bundle
 * comes next because "Shell Command: Install 'code' command in PATH" is a
 * manual step a large fraction of macOS users have never run — treating a
 * missing `code` as "VS Code is not installed" would be wrong for most of them.
 *
 * The Windows entries point at the GUI `.exe` and NOT at the `bin\code` /
 * `bin\code.cmd` shims sitting next to it on PATH, because neither shim can be
 * spawned without a shell — one is a bash script, the other a batch file Node
 * refuses to run directly. `Code.exe` accepts the same `--folder-uri` flag. See
 * the note on WINDOWS_SPAWNABLE_EXTENSIONS in resolve.ts.
 */

function vsCodeBundle(bundleId: string): EditorDiscovery {
  return {
    kind: 'macos-bundle',
    bundleId,
    cliRelativePath: 'Contents/Resources/app/bin/code',
  };
}

const TARGETS: Record<KnownEditorId, EditorTarget> = {
  vscode: {
    id: 'vscode',
    displayName: 'VS Code',
    discovery: [
      { kind: 'path-lookup', command: 'code' },
      vsCodeBundle('com.microsoft.VSCode'),
      {
        kind: 'well-known-dir',
        paths: [
          '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
          '/usr/share/code/bin/code',
          '/usr/bin/code',
          '/usr/local/bin/code',
          '/snap/bin/code',
          '/var/lib/flatpak/exports/bin/com.visualstudio.code',
          '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
          '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
        ],
      },
    ],
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
  },

  'vscode-insiders': {
    id: 'vscode-insiders',
    displayName: 'VS Code Insiders',
    discovery: [
      { kind: 'path-lookup', command: 'code-insiders' },
      vsCodeBundle('com.microsoft.VSCodeInsiders'),
      {
        kind: 'well-known-dir',
        paths: [
          '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
          '/usr/bin/code-insiders',
          '/snap/bin/code-insiders',
          '%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe',
          '%ProgramFiles%\\Microsoft VS Code Insiders\\Code - Insiders.exe',
        ],
      },
    ],
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
  },

  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    discovery: [
      { kind: 'path-lookup', command: 'cursor' },
      vsCodeBundle('com.todesktop.230313mzl4w4u92'),
      {
        kind: 'well-known-dir',
        paths: [
          '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
          '/usr/bin/cursor',
          '/usr/local/bin/cursor',
          '%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe',
        ],
      },
    ],
    // Unverified — Cursor is a VS Code fork and is expected to share the
    // scheme, but nobody has confirmed it against a real install. See
    // docs/roadmap.md, "Verify the forks".
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
  },

  windsurf: {
    id: 'windsurf',
    displayName: 'Windsurf',
    discovery: [
      { kind: 'path-lookup', command: 'windsurf' },
      vsCodeBundle('com.exafunction.windsurf'),
      {
        kind: 'well-known-dir',
        paths: [
          '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
          '/usr/bin/windsurf',
          '/usr/local/bin/windsurf',
          '%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe',
        ],
      },
    ],
    // Unverified, same caveat as Cursor.
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
  },
};

/** Probe order in the UI's editor list. */
export const EDITOR_ORDER: readonly KnownEditorId[] = [
  'vscode',
  'vscode-insiders',
  'cursor',
  'windsurf',
];

export const EDITOR_TARGETS: readonly EditorTarget[] = EDITOR_ORDER.map((id) => TARGETS[id]);

export function editorTarget(id: string): EditorTarget | undefined {
  return EDITOR_TARGETS.find((target) => target.id === id);
}
