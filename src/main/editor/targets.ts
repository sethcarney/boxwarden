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
 *
 * `newWindowFlag` is `--new-window` and not `--reuse-window`, and the asymmetry
 * is the point: reusing is what the CLI already does when a window has the
 * folder open, so the flag is only ever needed to ask for the OTHER thing. See
 * `OpenInEditorMode`.
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
    devContainerSpec: 'local-folder',
    newWindowFlag: '--new-window',
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
    devContainerSpec: 'local-folder',
    newWindowFlag: '--new-window',
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
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
    // The one confirmed fork divergence, and it is not the scheme or the flag —
    // both of those match. Cursor's `dev-container` spec is a hex-encoded JSON
    // blob, not a hex-encoded folder path. From Cursor's own docs, "Opening
    // Remote Containers via the CLI".
    devContainerSpec: 'config-json',
    newWindowFlag: '--new-window',
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
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
    // Left on VS Code's spelling because there is no evidence Windsurf
    // diverges — unlike Cursor, whose docs say plainly that it does. Still
    // unverified against a real install; see docs/roadmap.md.
    devContainerSpec: 'local-folder',
    newWindowFlag: '--new-window',
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
