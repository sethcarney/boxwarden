import { spawn } from 'node:child_process';
import type { EditorTarget } from '../../models/index.js';

/**
 * Launch an editor at a `vscode-remote://` URI.
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
export function launchEditor(binaryPath: string, target: EditorTarget, uri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [target.folderUriFlag, uri], {
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
