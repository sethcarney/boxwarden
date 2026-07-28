import type { BoxwardenApi } from '../shared/ipc.js';

/**
 * The global the preload installs.
 *
 * Declared in its own module, containing no runtime code, so the renderer can
 * `import type` it without pulling preload code — and therefore Electron —
 * into the browser bundle.
 */
declare global {
  interface Window {
    readonly boxwarden: BoxwardenApi;
  }
}

export type { BoxwardenApi };
