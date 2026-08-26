import type { HostPath } from '../../models/index.js';

/**
 * The pure half of Build and Rebuild: what to spawn, and what the CLI said.
 *
 * Same shape as `terminal/command.ts` — an argv builder whose output is handed
 * to `spawn` with `shell: false`, so every path in it is inert data. The argv
 * rule is easier here than it is for terminals, and it is worth knowing why
 * before anyone reaches for base64: nothing on this path goes through `wt.exe`
 * or a distro's default shell, which are the two layers that re-join an argv
 * into a command line. `devcontainer` receives exactly this array.
 */

export type UpInvocation =
  | { readonly ok: true; readonly command: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the `devcontainer up` argv for one workspace.
 *
 * `workspaceFolderRaw` is the byte-exact spelling of the folder — for a
 * rebuild, the `devcontainer.local_folder` label itself, NOT the parsed path.
 * Same rule as `authorityFor`, enforced one layer further down: the CLI finds
 * the container to replace by matching that label, exact-match first, so a
 * spelling this app "cleaned up" is a container the CLI cannot find — and
 * `--remove-existing-container` then leaves the old one running beside the
 * new one it just built. `flavour` (the parsed arm) is only the gate that
 * says the raw string is a native path on THIS machine at all.
 *
 * The `wsl` arm refuses rather than building a `wsl.exe --exec` line. Running
 * the CLI inside a distro means the CLI must be installed inside that distro,
 * which is a fact no probe of this machine has established — a refusal naming
 * the Copy button is honest, a spawn that dies on a missing binary looks like
 * the build failing. `docs/roadmap.md` carries the follow-up.
 */
export function devcontainerUpInvocation(options: {
  readonly binaryPath: string;
  readonly workspaceFolderRaw: string;
  readonly flavour: HostPath['kind'];
  readonly configPath?: string;
  readonly removeExistingContainer?: boolean;
}): UpInvocation {
  if (options.flavour === 'wsl') {
    return {
      ok: false,
      reason:
        'This workspace lives inside a WSL distro, and building it means running the devcontainer CLI inside that distro. Use the copy button and run the command in the distro instead.',
    };
  }
  if (options.workspaceFolderRaw.trim() === '') {
    return { ok: false, reason: 'This workspace has no folder to build from.' };
  }

  return {
    ok: true,
    command: options.binaryPath,
    args: [
      'up',
      '--workspace-folder',
      options.workspaceFolderRaw,
      ...(options.configPath === undefined || options.configPath.trim() === ''
        ? []
        : ['--config', options.configPath]),
      ...(options.removeExistingContainer === true ? ['--remove-existing-container'] : []),
    ],
  };
}

/**
 * What one run of `devcontainer up` concluded.
 *
 * `unparseable` is its own arm rather than an error with a shrug in it: the
 * caller falls back to the process's stderr, which for a crash before the CLI
 * even parsed its arguments is the only message there is.
 */
export type UpOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'unparseable' };

/**
 * `devcontainer up` streams progress and finishes with a single JSON object on
 * stdout carrying an `outcome` field. Scanned from the END, tolerating noise:
 * the same approach `scripts/devcontainer-open.mjs` pins against a real CLI,
 * and the reason it survives both log formats and any lines a future CLI adds
 * after the result.
 */
export function parseUpOutcome(stdout: string): UpOutcome {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Progress line, not the result. Keep walking backwards.
    }
    if (typeof parsed !== 'object' || parsed === null || !('outcome' in parsed)) continue;

    const record = parsed as Record<string, unknown>;
    if (record.outcome === 'success') return { kind: 'success' };

    // The CLI puts the human sentence in `description` and the terse one in
    // `message`; either alone is better than neither, both is better still.
    const parts = [record.message, record.description].filter(
      (part): part is string => typeof part === 'string' && part.trim() !== '',
    );
    return {
      kind: 'error',
      message: parts.length > 0 ? [...new Set(parts)].join(' — ') : 'The build failed.',
    };
  }
  return { kind: 'unparseable' };
}
