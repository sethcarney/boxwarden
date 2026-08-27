import type { EditorDiscovery, EditorTarget, KnownEditorId } from '../../models/index.js';

/**
 * Editor definitions as DATA. There is exactly one entry now — VS Code —
 * because fork support (Insiders, Cursor, Windsurf) was removed deliberately:
 * the app's editor-lifecycle features are only ever exercised against VS
 * Code, and a launch path nobody tests is how Cursor's `config-json`
 * authority divergence reached production silently. The table shape is kept
 * so re-adding a fork is an entry here, not a new branch in the resolver —
 * but see the note in `src/models/editor.ts` for what else a fork needs back.
 *
 * Discovery order is deliberate. `code` on PATH is checked first because when
 * it is there it is unambiguous and instant. The macOS app bundle comes next
 * because "Shell Command: Install 'code' command in PATH" is a manual step a
 * large fraction of macOS users have never run — treating a missing `code` as
 * "VS Code is not installed" would be wrong for most of them.
 *
 * The Windows entries point at the GUI `.exe` and NOT at the `bin\code` /
 * `bin\code.cmd` shims sitting next to it on PATH, because neither shim can be
 * spawned without a shell — one is a bash script, the other a batch file Node
 * refuses to run directly. `Code.exe` accepts the same `--folder-uri` flag. See
 * the note on WINDOWS_SPAWNABLE_EXTENSIONS in resolve.ts.
 *
 * There is no new-window flag in this table. `--new-window` was here, and it
 * did nothing that could be seen: VS Code will not open a second window on a
 * folder one of its windows already has. See the note in
 * `src/models/editor.ts`.
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
  },
};

/** Probe order in the UI's editor list. */
export const EDITOR_ORDER: readonly KnownEditorId[] = ['vscode'];

export const EDITOR_TARGETS: readonly EditorTarget[] = EDITOR_ORDER.map((id) => TARGETS[id]);

export function editorTarget(id: string): EditorTarget | undefined {
  return EDITOR_TARGETS.find((target) => target.id === id);
}
