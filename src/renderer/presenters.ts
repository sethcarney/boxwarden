/**
 * Pure presentation logic — the derivations a ViewModel hands to a View.
 *
 * WHY THIS IS NOT IN `format.ts` AND NOT IN THE COMPONENTS
 *
 * `format.ts` formats ONE domain value: a runtime into a status line, a path
 * into a label. The functions here fold several — a whole snapshot, a pair of
 * project counts, a container plus the editor's availability — into the exact
 * string or flag a View renders. That is ViewModel work, and it lived inside
 * JSX before this file existed, which is what made it untestable: asserting
 * that a two-engine machine says "+1" meant mounting the app.
 *
 * Everything here is pure and takes its inputs as arguments, so the ViewModel
 * hooks stay thin and these can be tested without React or a DOM.
 */

import type {
  DevContainer,
  EndpointProbe,
  EngineSelection,
  PortBinding,
  SshAgentState,
} from '../models/index.js';
import { projectName } from '../models/index.js';
import type { DiscoverySnapshot } from '../shared/ipc.js';
import { describeTarget, runtimeLabel } from './format.js';

/**
 * Anything thrown, as a sentence.
 *
 * Every ViewModel that awaits the bridge needs this, and each one having its
 * own `error instanceof Error ? … : String(error)` was six copies of one
 * decision — which is how a rejection that is not an Error ends up rendering
 * as "[object Object]" in one place and a real message in another.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A probe that answered. A plain `.filter(p => p.ok)` does not narrow the union. */
function isConnected(probe: EndpointProbe): probe is Extract<EndpointProbe, { ok: true }> {
  return probe.ok;
}

export interface EngineChip {
  readonly ok: boolean;
  readonly label: string;
  /** The full list of engines that answered, one per line, for the `title`. */
  readonly title: string;
  readonly connectedCount: number;
}

/**
 * The header chip naming what answered.
 *
 * More than one engine can answer at once — a podman machine behind a named
 * pipe plus a rootless podman inside a WSL distro is an ordinary Windows
 * setup. The "+n" counts the OTHER engines being unioned in, so it is only
 * true while the selection is `all`; narrowed to one engine, the chip names
 * exactly what is in the list.
 */
export function engineChip(snapshot: DiscoverySnapshot): EngineChip {
  const connected = snapshot.environment.attempts.filter(isConnected);
  const title = connected
    .map(
      (probe) =>
        `${runtimeLabel(probe.runtime)} ${probe.serverVersion} — ${describeTarget(probe.endpoint.transport)}`,
    )
    .join('\n');

  const api = snapshot.environment.api;
  if (!api.ok) {
    return { ok: false, label: 'No container engine', title, connectedCount: connected.length };
  }

  const others = snapshot.selection.kind === 'all' ? connected.length - 1 : 0;
  return {
    ok: true,
    label: `${runtimeLabel(api.runtime)} ${api.serverVersion}${others > 0 ? ` +${String(others)}` : ''}`,
    title,
    connectedCount: connected.length,
  };
}

/**
 * Why the list is empty when the engine is fine.
 *
 * The narrowed case gets its own sentence: a user who selected one engine and
 * sees nothing needs to be told the others were not consulted, or they will
 * read an empty list as "boxwarden cannot see my containers".
 */
export function emptyListMessage(selection: EngineSelection, connectedCount: number): string {
  if (selection.kind !== 'all') {
    return 'The engine you selected is reachable, but nothing on it carries the devcontainer.local_folder label. Other engines may have containers — switch to “All engines” to check.';
  }
  const subject =
    connectedCount === 1
      ? 'A container engine is'
      : `${String(connectedCount)} container engines are`;
  const object = connectedCount === 1 ? 'it' : 'them';
  return `${subject} reachable, but nothing on ${object} carries the devcontainer.local_folder label.`;
}

/**
 * Why "Open in <editor>" is disabled, or undefined when it is not.
 *
 * Naming the failed precondition beats a disabled button with no explanation,
 * and the two causes need different fixes — one is a property of the
 * container, the other of the machine.
 */
export function openBlockedReason(
  container: DevContainer,
  editorAvailable: boolean,
  editorName: string,
): string | undefined {
  if (container.workspaceFolder === undefined) {
    return 'This container does not record which folder to open.';
  }
  if (!editorAvailable) return `${editorName} was not found on this machine.`;
  return undefined;
}

/**
 * The one-line summary above the unbuilt-project list.
 *
 * The "all built" case gets its own sentence rather than falling through to an
 * empty list, because the two are indistinguishable on screen and mean opposite
 * things: one says boxwarden looked and found nothing to do, the other says it
 * has not looked anywhere useful.
 */
export function summariseProjects(unbuilt: number, built: number, scanning: boolean): string {
  if (unbuilt === 0 && built === 0) {
    return scanning
      ? 'Looking for devcontainer.json files on this machine…'
      : 'No devcontainer.json files were found in the folders below.';
  }
  if (unbuilt === 0) {
    return `Every dev container project found on disk (${String(built)}) has been built — they are in the list above.`;
  }
  const suffix =
    built === 0 ? '' : ` A further ${String(built)} ${built === 1 ? 'is' : 'are'} already built.`;
  return `${String(unbuilt)} folder${unbuilt === 1 ? '' : 's'} on this machine ${unbuilt === 1 ? 'has' : 'have'} a devcontainer.json and no container yet.${suffix}`;
}

/** "1 dev container" / "4 dev containers". */
export function containerCountLabel(count: number): string {
  return `${String(count)} dev container${count === 1 ? '' : 's'}`;
}

/** A scan root's trailing hint — what was found there, or why it could not be read. */
export function scanRootHint(
  failure: 'missing' | 'unreadable' | undefined,
  found: number,
  detail: string | undefined,
): string {
  if (failure === 'missing') return 'no such folder';
  if (failure === 'unreadable') return `unreadable${detail === undefined ? '' : `: ${detail}`}`;
  return `${String(found)} found`;
}

/**
 * The card heading.
 *
 * Compose members show their container name: inside a group every card would
 * otherwise share the project's folder name and read as three identical
 * headings. The group header carries the project.
 */
export function cardTitle(container: DevContainer): string {
  return container.labels.composeProject === undefined
    ? projectName(container.localFolder)
    : container.name;
}

/**
 * The ports worth showing.
 *
 * Only a running or paused container has them — a stopped one's bindings are
 * whatever it had last time, which would render as though the ports were live.
 */
export function visiblePorts(container: DevContainer): readonly PortBinding[] {
  return container.runtime.state === 'running' || container.runtime.state === 'paused'
    ? container.runtime.ports
    : [];
}

export interface SshAgentBadge {
  readonly text: string;
  /** The dense-layout spelling. The full text stays reachable in `title`. */
  readonly short: string;
  readonly title: string;
  readonly warning: boolean;
}

/**
 * The SSH agent indicator, or undefined when there is nothing to say.
 *
 * `absent` renders NOTHING, and that is the important half of this function.
 * Plenty of dev containers have no business talking to a remote, and a badge
 * on every card announcing a feature the user did not ask for is how an
 * indicator becomes wallpaper — by the time it means something, nobody reads
 * it. Only the two states that carry information get a badge.
 *
 * `declared-unmounted` is the warning: the variable is set, so the container
 * looks configured to anything that checks, and the socket behind it is not
 * there. The title says what will actually go wrong, because "SSH agent not
 * mounted" is a symptom nobody connects to the `git fetch` that fails ten
 * minutes later.
 */
export function sshAgentBadge(state: SshAgentState): SshAgentBadge | undefined {
  switch (state.kind) {
    case 'absent':
      return undefined;
    case 'forwarded':
      return {
        text: 'SSH agent',
        short: 'SSH',
        title: `Your SSH agent is forwarded into this container at ${state.socket}, so git over SSH will use the keys loaded on your machine.`,
        warning: false,
      };
    case 'declared-unmounted':
      return {
        text: 'SSH agent missing',
        short: 'SSH!',
        title: `This container sets SSH_AUTH_SOCK=${state.socket} but nothing is mounted there, so the socket does not exist. Anything using SSH — git fetch, git push against a private repo — will fail with "Could not open a connection to your authentication agent".`,
        warning: true,
      };
  }
}

/** One port, as the chip renders it, plus the tooltip that explains it. */
export function portLabel(port: PortBinding): { readonly text: string; readonly title: string } {
  if (port.hostPort === undefined) {
    return {
      text: `${String(port.containerPort)} (not published)`,
      title: 'Exposed by the image but not published to the host.',
    };
  }
  return {
    text: `${String(port.hostPort)} → ${String(port.containerPort)}`,
    title: `${port.hostIp ?? '0.0.0.0'}:${String(port.hostPort)} → ${String(port.containerPort)}`,
  };
}
