import type { DesktopWindow } from '../../models/index.js';

/**
 * The impure edge around `models/editor-window.ts`: enumerating the desktop's
 * top-level windows, and asking it to close some of them.
 *
 * Three backends, one per platform, because there is no cross-platform way to
 * do either — and no native module either, deliberately. Everything here shells
 * out to a program the OS already ships (`powershell.exe`, `osascript`,
 * `wmctrl`), which keeps this feature out of the packaging story: a native
 * addon would need building per platform per architecture, and arm64 has never
 * been launched on any of them (see docs/roadmap.md).
 *
 * ## Two calls, never one
 *
 * Every backend enumerates first and closes second, and the close is addressed
 * by a handle the enumeration produced. Nothing this app knows about a
 * container is ever interpolated into a program that closes a window — the
 * matching happens in Node, over strings, in a pure function. It is the shape
 * `switchBranch` uses for the same reason: the only values reaching the
 * dangerous call are ones the previous call printed moments earlier.
 */
export interface DesktopWindowBackend {
  /** Every visible top-level window with a title. */
  list(): Promise<readonly DesktopWindow[]>;
  /**
   * Ask for these windows to close, the way the title bar's X does.
   *
   * Fire-and-return: the request is asynchronous on every platform and the
   * application is entitled to take its time over it, or to refuse — VS Code
   * holding up its own close over an unsaved buffer is the case that matters.
   * The caller re-enumerates to find out what actually happened.
   */
  close(windows: readonly DesktopWindow[]): Promise<void>;
}

/**
 * Why this machine cannot be asked, phrased for the message bar.
 *
 * A reason and not a boolean because the three ways it happens have three
 * different fixes, and only one of them is "nothing can be done": a missing
 * `wmctrl` is an install, a withheld Accessibility grant is a checkbox, and
 * Wayland is a protocol that genuinely does not let one application close
 * another's window. A bare "could not close it" would send all three users to
 * the same dead end.
 */
export interface DesktopUnsupported {
  readonly reason: string;
}

export type DesktopBackendResult =
  | { readonly ok: true; readonly backend: DesktopWindowBackend }
  | { readonly ok: false; readonly unsupported: DesktopUnsupported };

/** How long any one helper process gets before it is abandoned. */
export const HELPER_TIMEOUT_MS = 5_000;
