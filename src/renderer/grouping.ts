import type { DevContainer } from '../models/index.js';

/**
 * Group the flat container list for rendering.
 *
 * THE PROBLEM
 *
 * A compose-based dev container is several containers — the workspace, a
 * database, maybe a cache. Acting on them individually means "Stop" leaves the
 * siblings running and burning CPU, which is exactly the state a user opened
 * this app to get out of. The domain has carried `composeProject` since Phase 2
 * for this; here is where it finally does something.
 *
 * A union rather than "a group with a possibly-empty project name", so the
 * renderer has to decide what a lone container looks like versus a project.
 * The two really do render differently: a project gets a header and group-level
 * actions, a lone container does not.
 */
export type ContainerGroup =
  | { readonly kind: 'single'; readonly key: string; readonly container: DevContainer }
  | {
      readonly kind: 'compose';
      readonly key: string;
      readonly project: string;
      readonly containers: readonly DevContainer[];
    };

/** Every container in the group, whichever arm it is. */
export function groupMembers(group: ContainerGroup): readonly DevContainer[] {
  return group.kind === 'single' ? [group.container] : group.containers;
}

/**
 * Insertion order is preserved, so the caller's sort (running first, then
 * name) still governs. A project takes the position of its first member rather
 * than being sorted separately — otherwise a project whose workspace container
 * is running would sink below stopped singles because of a stopped sibling.
 *
 * A compose project with exactly one container stays a `compose` group. It is
 * still compose-managed, and collapsing it to a single would hide the tag that
 * warns the user their actions do not cover siblings that may appear later.
 */
export function groupContainers(containers: readonly DevContainer[]): readonly ContainerGroup[] {
  const groups: ContainerGroup[] = [];
  const byProject = new Map<string, number>();

  for (const container of containers) {
    const project = container.labels.composeProject;

    if (project === undefined) {
      groups.push({ kind: 'single', key: container.id, container });
      continue;
    }

    const existing = byProject.get(project);
    if (existing === undefined) {
      byProject.set(project, groups.length);
      groups.push({
        kind: 'compose',
        key: `compose:${project}`,
        project,
        containers: [container],
      });
      continue;
    }

    const group = groups[existing];
    // Defensive but cheap: the index came from this array a moment ago.
    if (group?.kind !== 'compose') continue;
    groups[existing] = { ...group, containers: [...group.containers, container] };
  }

  return groups;
}

/**
 * Whether a group-level start or stop has anything to do.
 *
 * Deliberately permissive: if ANY member can be started, "Start all" is
 * offered. A group where two of three are already running still has work to
 * do, and disabling the button because it is partially satisfied would leave
 * the user with no way to finish the job except clicking into each card.
 */
export function groupCanStart(
  members: readonly DevContainer[],
  canStart: (runtime: DevContainer['runtime']) => boolean,
): boolean {
  return members.some((member) => canStart(member.runtime));
}

export function groupCanStop(
  members: readonly DevContainer[],
  canStop: (runtime: DevContainer['runtime']) => boolean,
): boolean {
  return members.some((member) => canStop(member.runtime));
}
