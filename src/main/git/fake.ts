import type { GitStatus } from '../../models/index.js';

/**
 * Branches for the fixture containers, so the branch chip can be worked on
 * without checkouts on disk at those paths.
 *
 * The counterpart to `FakeDockerBackend` and `fakeUpdatesFromEnv`, and gated on
 * the SAME switch as the container fixtures (BOXWARDEN_FAKE_DOCKER=1): the
 * folders below only exist because the containers do, so a real container list
 * can never pick up a fabricated branch. Anything not named here answers
 * `none`, which is what a folder that is not a checkout answers for real.
 */
const FIXTURE_BRANCHES: Readonly<Record<string, GitStatus>> = {
  '/home/dev/code/webapp': { kind: 'branch', branch: 'main' },
  '/home/dev/code/api-service': { kind: 'branch', branch: 'feature/rate-limiting' },
  // Both compose members share a folder, which is the case that proves the
  // batch reads one folder once rather than once per container.
  '/home/dev/code/platform': { kind: 'branch', branch: 'release/2026.08' },
  // A checked-out tag, so the detached arm has somewhere to render.
  '/home/dev/infra-scripts': {
    kind: 'detached',
    commit: '4f2c1ab9d3e5f70123456789abcdef0123456789',
  },
};

export function fakeGitStatus(folder: string): Promise<GitStatus> {
  return Promise.resolve(FIXTURE_BRANCHES[folder] ?? { kind: 'none' });
}
