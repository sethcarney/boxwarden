import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { EngineSelection } from '../models/index.js';
import {
  ALL_ENGINES,
  parseEngineSelection,
  parseProjectRoots,
  parseStartupCommands,
} from '../models/index.js';

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
  /**
   * Startup commands by `containerSettingsKey` — the command run inside a
   * container before the interactive shell each time a terminal opens.
   *
   * Here rather than in a file of its own because this one already exists,
   * already has the load/persist plumbing, and is already read before the
   * window opens. A second settings file would be a second thing to keep
   * consistent for no benefit.
   *
   * Not optional: an empty map and an absent one mean the same thing, unlike
   * `projectRoots` where the difference is load-bearing.
   */
  readonly startupCommands: Readonly<Record<string, string>>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  engineSelection: ALL_ENGINES,
  startupCommands: {},
};

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
      startupCommands: parseStartupCommands(record['startupCommands']),
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
 * problem into a functional one. The same reasoning covers a startup command —
 * it still runs in every terminal opened this session; what is lost is the
 * memory of it, on a machine that has bigger problems than that.
 */
export async function savePreferences(path: string, preferences: Preferences): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(preferences, undefined, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[boxwarden] Could not save preferences to ${path}:`, error);
  }
}
