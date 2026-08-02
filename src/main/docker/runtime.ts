import type { ContainerRuntimeKind } from '../../models/index.js';

/**
 * Identify which container runtime answered, from its own /version response.
 *
 * WHY THIS EXISTS
 *
 * Until this module, the runtime was inferred from which socket replied —
 * `//./pipe/docker_engine` was assumed to be Docker Desktop, `~/.orbstack/...`
 * to be OrbStack, and so on. That inference is wrong on any machine running a
 * Docker-compatible engine, which is most of them now:
 *
 *   - Podman on Windows serves its docker-compat API on `\\.\pipe\docker_engine`,
 *     the exact pipe name Docker Desktop uses.
 *   - Rancher Desktop in moby mode takes over `/var/run/docker.sock`.
 *   - Podman on Linux is commonly symlinked to `/var/run/docker.sock`.
 *
 * The visible symptom is a status chip reading "Docker 5.7.0" — Docker has
 * never shipped a 5.7.0; that is Podman's version number wearing Docker's name.
 * Worse than ugly, it is actively misleading when the next thing the user does
 * is search for why "Docker" cannot see their containers.
 *
 * The daemon knows what it is. Ask it.
 */

/** The parts of Docker's /version payload this needs. Everything is optional — it is remote JSON. */
export interface VersionResponse {
  readonly Version?: string | undefined;
  readonly ApiVersion?: string | undefined;
  readonly Components?: readonly { readonly Name?: string | undefined }[] | undefined;
  readonly Platform?: { readonly Name?: string | undefined } | undefined;
}

/**
 * `fallback` is the guess made from the socket path, used only when the
 * response identifies nothing. Several engines are genuinely indistinguishable
 * over the wire — Colima and Rancher Desktop both run stock moby and report
 * `Docker Engine - Community`, exactly as a plain Linux install does — so for
 * those the socket path really is the better evidence, and this defers to it.
 */
export function detectRuntime(
  version: VersionResponse,
  fallback: ContainerRuntimeKind,
): ContainerRuntimeKind {
  const components = (version.Components ?? [])
    .map((component) => component.Name ?? '')
    .join('\n')
    .toLowerCase();
  const platform = (version.Platform?.Name ?? '').toLowerCase();

  // Podman first, and on Components rather than Platform: Podman's Platform.Name
  // is the guest OS ("linux/amd64/ubuntu-26.04"), which says nothing, while
  // Components always leads with "Podman Engine".
  if (components.includes('podman')) return 'podman';

  // OrbStack and Docker Desktop both brand Platform.Name. OrbStack is checked
  // first because it also reports an "Engine" component like Docker does.
  if (platform.includes('orbstack')) return 'orbstack';
  if (platform.includes('docker desktop')) return 'docker-desktop';
  if (platform.includes('rancher')) return 'rancher-desktop';
  if (platform.includes('colima')) return 'colima';

  return fallback;
}

/** The runtime a candidate socket is *guessed* to belong to, for use before anything has answered. */
export function guessedRuntime(origin: {
  readonly kind: string;
  readonly runtime?: ContainerRuntimeKind | undefined;
}): ContainerRuntimeKind {
  return origin.runtime ?? 'docker-engine';
}
