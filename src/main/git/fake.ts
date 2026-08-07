import type { ActionResult } from '../../shared/ipc.js';
import type { BranchListing, GitStatus, HostPath } from '../../models/index.js';
import { canSwitchTo } from '../../models/index.js';

/**
 * Branches for the fixture containers, so the branch chip and its menu can be
 * worked on without checkouts on disk at those paths.
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

/**
 * Where a fixture switch lands.
 *
 * Mutable, and that is the whole point: a menu whose click changed nothing
 * would exercise the click and none of what follows it — the refresh, the chip
 * re-reading, the menu closing on a branch that is now current. Reset when the
 * process restarts, like every other fixture here.
 */
const switched = new Map<string, string>();

export function fakeGitStatus(folder: string): Promise<GitStatus> {
  const moved = switched.get(folder);
  if (moved !== undefined) return Promise.resolve({ kind: 'branch', branch: moved });
  return Promise.resolve(FIXTURE_BRANCHES[folder] ?? { kind: 'none' });
}

/**
 * The branch lists, chosen to put every arm of the menu on screen.
 *
 * - webapp is the ordinary case: a clean tree and somewhere to go.
 * - api-service has a DIRTY tree, so the whole menu is refused with a reason —
 *   the arm that is otherwise only reachable by editing a file mid-demo.
 * - platform has a branch held by another WORKTREE, which is the per-row
 *   refusal, and the state this feature exists for.
 * - infra-scripts is detached, so the menu has no current branch to mark.
 */
const FIXTURE_LISTINGS: Readonly<Record<string, BranchListing>> = {
  '/home/dev/code/webapp': {
    kind: 'ready',
    tree: { kind: 'clean' },
    branches: [
      { name: 'main', current: true },
      { name: 'feature/dark-theme', current: false },
      { name: 'fix/port-parsing', current: false },
    ],
  },
  '/home/dev/code/api-service': {
    kind: 'ready',
    tree: { kind: 'dirty', changed: 3 },
    branches: [
      { name: 'feature/rate-limiting', current: true },
      { name: 'main', current: false },
    ],
  },
  '/home/dev/code/platform': {
    kind: 'ready',
    tree: { kind: 'clean' },
    branches: [
      { name: 'release/2026.08', current: true },
      { name: 'main', current: false },
      {
        name: 'agent-3',
        current: false,
        checkedOutAt: '/home/dev/code/platform-worktrees/agent-3',
      },
    ],
  },
  '/home/dev/infra-scripts': {
    kind: 'ready',
    tree: { kind: 'clean' },
    branches: [
      { name: 'main', current: false },
      { name: 'terraform-1.9', current: false },
    ],
  },
};

/**
 * The listing, with any fixture switch already folded into which branch is
 * current.
 *
 * Keyed on `folder.path` rather than on the whole `HostPath`, which is exactly
 * right for these fixtures and worth saying why: every fixture folder is
 * `posix`, so `.path` IS the key the real seam would resolve. The WSL arm's own
 * spelling is `gitInvocation`'s business and is tested there — there is no
 * fixture repository behind a distro to list.
 */
export function fakeBranches(folder: HostPath): Promise<BranchListing> {
  const listing = FIXTURE_LISTINGS[folder.path];
  if (listing === undefined) {
    return Promise.resolve({
      kind: 'unavailable',
      reason: 'This fixture folder is not a git repository.',
    });
  }

  const moved = switched.get(folder.path);
  if (moved === undefined || listing.kind !== 'ready') return Promise.resolve(listing);

  return Promise.resolve({
    ...listing,
    branches: listing.branches.map((branch) => ({ ...branch, current: branch.name === moved })),
  });
}

/**
 * A fixture switch, through the REAL `canSwitchTo`.
 *
 * The same bargain the update fixture makes by folding a fabricated release
 * through the real `foldUpdateStatus`: what is fake is the repository, not the
 * decision — so the refusals seen on screen in fixture mode are the production
 * ones, and a bug in the ordering of those reasons shows up here.
 */
export async function fakeSwitchBranch(folder: HostPath, branch: string): Promise<ActionResult> {
  const allowed = canSwitchTo(branch, await fakeBranches(folder));
  if (allowed !== true) return { ok: false, message: allowed };
  switched.set(folder.path, branch);
  return { ok: true };
}
