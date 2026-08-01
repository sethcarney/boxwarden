/**
 * What WSL looks like on this machine.
 *
 * WHY THIS IS A DOMAIN TYPE AND NOT A LOG LINE
 *
 * On Windows, WSL is not one detail of the setup — for dev containers it is the
 * setup. Linux containers need a Linux kernel, and on Windows the only ones on
 * offer are WSL2's or a Hyper-V VM that Docker Desktop manages for you. Every
 * mainstream option (Docker Desktop's default backend, Podman, Rancher Desktop)
 * runs its engine inside WSL2.
 *
 * So "no container engine found" on Windows has a specific and very common
 * cause — WSL is not installed, or is installed with no distribution in it —
 * and a specific fix. Discovery already learns all of this on the way to
 * finding a socket; throwing it away and reporting a bare failure turns a
 * one-line fix into a support thread. Modelling it lets the UI say
 * "run `wsl --install`" instead.
 */

/** What one running distribution can offer boxwarden. */
export interface WslDistroReport {
  readonly distro: string;
  /**
   * socat, the relay. Without it a socket inside the distro is reachable in
   * principle and not in practice: WSL projects a distro's filesystem over 9P,
   * and 9P does not carry unix domain sockets, so the only way across the
   * boundary is a process on the Linux side piping bytes through stdio.
   * See src/main/docker/wsl.ts.
   */
  readonly hasSocat: boolean;
  /** podman on PATH, which boxwarden can start an API service with if no socket exists. */
  readonly hasPodman: boolean;
  /** The engine socket found, or started, inside this distro. */
  readonly socketPath?: string;
}

export type WslStatus =
  /** Not Windows. Nothing here applies. */
  | { readonly kind: 'not-applicable' }
  /**
   * `wsl.exe` is absent, or present as the stub Windows ships and refusing to
   * run. Either way the fix is the same one command.
   */
  | { readonly kind: 'not-installed' }
  /** WSL itself is there, with no distribution inside it. */
  | { readonly kind: 'no-distros' }
  /** Distributions exist, none is running. Starting one is enough. */
  | { readonly kind: 'none-running'; readonly installed: readonly string[] }
  /** At least one distro is up. Whether it holds an engine is per-distro. */
  | { readonly kind: 'ready'; readonly distros: readonly WslDistroReport[] };

/** Running distros that hold an engine socket boxwarden can actually reach. */
export function reachableDistros(status: WslStatus): readonly WslDistroReport[] {
  if (status.kind !== 'ready') return [];
  return status.distros.filter((distro) => distro.socketPath !== undefined);
}

/**
 * Distros with an engine (or the means to start one) that boxwarden cannot
 * reach for want of socat. These are the most frustrating case in the whole
 * app — the containers are right there and invisible — and the fix is one
 * package, so they get their own accessor and their own advisory.
 */
export function distrosMissingSocat(status: WslStatus): readonly WslDistroReport[] {
  if (status.kind !== 'ready') return [];
  return status.distros.filter((distro) => !distro.hasSocat);
}
