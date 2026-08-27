import { spawn } from 'node:child_process';

/**
 * Launch an editor at a `vscode-remote://` URI.
 *
 * The URI and nothing else. No `--new-window`, because the CLI will not open a
 * second window on a folder that already has one (see `models/editor.ts`), and
 * no `--reuse-window` either — that is a different and worse thing, taking over
 * whichever window was last active whatever the developer had in it. Passing
 * neither is what makes an editor resolve the folder URI against its open
 * windows and raise the one that matches, which is the behaviour a card showing
 * "VS Code attached" wants.
 *
 * Two deliberate choices, both security-relevant:
 *
 *   - `spawn` with an argv ARRAY and never `shell: true`. The URI embeds a
 *     hex-encoded host path that ultimately comes from a container label, so
 *     it is attacker-influenced by anyone who can create containers on this
 *     daemon. Through argv it is inert data; through a shell string it would
 *     be a command injection. Electron's security checklist makes the same
 *     point about `shell.openExternal`, which is why that is not used here
 *     either — this launches a specific resolved binary, not "whatever is
 *     registered for this scheme".
 *
 *   - `detached` plus `unref`, so closing boxwarden does not take the editor
 *     with it. Without this the editor is a child process in our process
 *     group and dies with us.
 */
export function launchEditor(binaryPath: string, uri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `--folder-uri` was a per-editor field while forks were supported; every
    // fork used this spelling, so it is a constant now.
    const child = spawn(binaryPath, ['--folder-uri', uri], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });

    // 'error' fires for ENOENT/EACCES — the binary vanished between resolution
    // and launch, or is not actually executable.
    child.once('error', reject);

    // 'spawn' means the process was created. We deliberately do not wait for
    // exit: the CLI shim returns immediately after handing off to a running
    // window, but when it has to start the editor it stays alive for the
    // editor's whole session. Waiting would hang the IPC call for hours.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
