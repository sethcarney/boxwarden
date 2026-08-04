import type { DevContainer, DevContainerRuntime, MaybeHostPath } from '../models/index.js';
import { asContainerId, asContainerPath } from '../models/index.js';

/**
 * Fixture builders for the component tests.
 *
 * Deliberately NOT built by running `mapContainer` over inspect JSON, even
 * though that would exercise more code: `mapContainer` lives in src/main, and
 * the renderer's tsconfig does not include it. Reaching across that boundary in
 * a test would quietly undo the separation the two TypeScript projects exist to
 * enforce. The mapper has its own tests.
 */

const RUNNING: DevContainerRuntime = {
  state: 'running',
  startedAt: new Date('2026-07-27T09:00:00Z'),
  ports: [],
};

export function devContainer(overrides: Partial<DevContainer> = {}): DevContainer {
  const localFolder: MaybeHostPath = overrides.localFolder ?? {
    kind: 'posix',
    path: '/home/dev/code/webapp',
  };

  return {
    id: asContainerId('a'.repeat(64)),
    name: 'vsc-webapp-9f2c1a-uid',
    image: 'vsc-webapp-features',
    createdAt: new Date('2026-07-20T10:00:00Z'),
    localFolder,
    workspaceFolder: asContainerPath('/workspaces/webapp'),
    labels: {
      localFolderRaw: localFolder.kind === 'unresolved' ? localFolder.raw : '/home/dev/code/webapp',
    },
    // The common case, and the one that renders nothing. A fixture defaulting
    // to `forwarded` would put a badge on every card in every component test,
    // which is the opposite of what a default should do.
    sshAgent: { kind: 'absent' },
    runtime: RUNNING,
    ...overrides,
  };
}

/** A container whose host path could not be parsed — the degraded row. */
export function unresolvedContainer(raw = 'relative/not/absolute'): DevContainer {
  return devContainer({
    localFolder: { kind: 'unresolved', raw, reason: 'Not an absolute path.' },
    labels: { localFolderRaw: raw },
  });
}
