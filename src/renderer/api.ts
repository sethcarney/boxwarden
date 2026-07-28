import type { BoxwardenApi } from '../shared/ipc.js';

/**
 * Reach the preload bridge, or report honestly that it is not there.
 *
 * Returning `undefined` rather than assuming the global exists is not
 * defensive padding — a preload that fails to load is a real and quiet failure
 * mode (wrong path, wrong module format; see src/preload/index.ts), and its
 * only symptom would otherwise be a UI that renders an empty container list as
 * though the machine had no dev containers. The App turns this into a specific
 * error screen instead.
 */
export function getApi(): BoxwardenApi | undefined {
  return (globalThis as { boxwarden?: BoxwardenApi }).boxwarden;
}
