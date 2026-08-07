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

/**
 * Cursor's bundle ships its CLI as `bin/cursor`, not `bin/code`.
 *
 * `vsCodeBundle` hardcodes the latter, which is right for the two Microsoft
 * builds and wrong here — a Cursor installed outside /Applications would fail
 * the bundle strategy and then miss the hardcoded /Applications path below it,
 * so it would not be found at all.
 */
function cursorBundle(): EditorDiscovery {
  return {
    kind: 'macos-bundle',
    bundleId: 'com.todesktop.230313mzl4w4u92',
    cliRelativePath: 'Contents/Resources/app/bin/cursor',
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
    newWindowFlag: '--new-window',
  },

  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    discovery: [
      { kind: 'path-lookup', command: 'cursor' },
      cursorBundle(),
      {
        kind: 'well-known-dir',
        paths: [
          '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
          '/usr/bin/cursor',
          '/usr/local/bin/cursor',
          // The CLI shim, BEFORE the executable beside it, and that order is
          // the fix for a real bug rather than a preference: Cursor.exe no
          // longer opens the IDE — it opens the agents surface, with a button
          // to get from there to an editor — so resolving to it produces a
          // window with no workspace in it. The shim is the documented way to
          // open a folder and lands in the IDE directly.
          //
          // A `.cmd`, which needs `cmd.exe /c` to run at all; see
          // src/models/windows-launch.ts. Costless to list even if a given
          // install does not have it — a path that is not there simply falls
          // through to the next entry, which is the previous behaviour.
          '%LOCALAPPDATA%\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
          '%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe',
        ],
      },
    ],
    // Unverified — Cursor is a VS Code fork and is expected to share the
    // scheme, but nobody has confirmed it against a real install. See
    // docs/roadmap.md, "Verify the forks".
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
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
          // Same shape as Cursor's, and listed for the same reason — the shim
          // is the documented entry point. Unverified against a real install.
          '%LOCALAPPDATA%\\Programs\\Windsurf\\resources\\app\\bin\\windsurf.cmd',
          '%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe',
        ],
      },
    ],
    // Unverified, same caveat as Cursor.
    remoteScheme: 'vscode-remote',
    folderUriFlag: '--folder-uri',
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
