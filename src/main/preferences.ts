import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { EngineSelection } from '../models/index.js';
import { ALL_ENGINES, parseEngineSelection, parseProjectRoots } from '../models/index.js';

/**
 * The handful of settings that must outlive a run.
 *
 * A file rather than electron-store or localStorage: the engine selection is
 * read by the MAIN process before the window exists (the first discover() has
 * to honour it, or the app opens showing the wrong engine and corrects itself a
 * second later), and renderer storage is not readable from there.
 *
 * The impure shell is this file; the parsing and defaulting live in
 * src/domain/engine.ts where they are testable without a filesystem.
 */

export interface Preferences {
  readonly engineSelection: EngineSelection;
  /**
   * Where to look for unbuilt projects, or absent for "wherever the platform
   * defaults say".
   *
   * Absent and empty are not the same thing and the optionality is load-bearing
   * — see `parseProjectRoots`. With `exactOptionalPropertyTypes` on, "absent"
   * has to be a missing key, which is why writers spread it conditionally
   * rather than assigning undefined.
   */
  readonly projectRoots?: readonly string[];
}

export const DEFAULT_PREFERENCES: Preferences = { engineSelection: ALL_ENGINES };

/**
 * Never rejects.
 *
 * A missing file is the normal first-run case, and a corrupt one is recoverable
 * — the only thing at stake is which engine is selected. Refusing to launch
 * over it would be a spectacular over-reaction, and the failure mode is
 * self-explaining: the picker reads "All engines" and the user sets it again.
 */
export async function loadPreferences(path: string): Promise<Preferences> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES;
    const record = parsed as Record<string, unknown>;
    const projectRoots = parseProjectRoots(record['projectRoots']);
    return {
      engineSelection: parseEngineSelection(record['engineSelection']),
      ...(projectRoots === undefined ? {} : { projectRoots }),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Best-effort. A preferences file that cannot be written is logged and
 * otherwise ignored: the selection still applies for this run, held in memory
 * by the backend, so failing the user's click over it would turn a cosmetic
 * problem into a functional one.
 */
export async function savePreferences(path: string, preferences: Preferences): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(preferences, undefined, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[boxwarden] Could not save preferences to ${path}:`, error);
  }
}
