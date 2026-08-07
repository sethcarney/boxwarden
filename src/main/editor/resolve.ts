import { platform } from 'node:os';
import type { EditorTarget, ResolvedEditor } from '../../models/index.js';
import { resolveBinary } from '../discovery/resolve.js';

/**
 * Where an editor lives on this machine.
 *
 * The strategy machinery — PATH lookup, macOS bundles, well-known directories,
 * and what Windows can actually spawn — is in `../discovery/resolve.ts`,
 * because terminal emulators ask exactly the same question of a different
 * table. This module is only the editor-shaped wrapper around it, which is why
 * it has no tests of its own: everything with logic in it moved.
 */
export async function resolveEditor(
  target: EditorTarget,
  os: NodeJS.Platform = platform(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedEditor> {
  const found = await resolveBinary(target.discovery, os, env);
  return found.ok
    ? { ok: true, target, binaryPath: found.binaryPath, via: found.via }
    : { ok: false, target, code: found.code };
}
