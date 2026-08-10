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

// Type-only, and it has to stay that way: `useNotices` imports `errorMessage`
// from this module, so a value import here would close a runtime cycle.
// `import type` is erased outright under `verbatimModuleSyntax`.
import type { Notice } from './viewmodels/useNotices.js';
import type {
  BranchListing,
  ClaudeSession,
  ClaudeStatus,
  DevContainer,
  EditorAttachment,
  EditorFlavour,
  EditorWindowClosure,
  EndpointProbe,
  EngineSelection,
  GitStatus,
  SessionActivity,
  PortBinding,
  SshAgentState,
  UpdateInstructions,
  UpdateStatus,
} from '../models/index.js';
import {
  attachedEditorsIn,
  branchSwitchBlockedReason,
  editorDisplayName,
  isWorking,
  projectName,
  shortCommit,
  treeBlockedReason,
} from '../models/index.js';
import type { DiscoverySnapshot } from '../shared/ipc.js';
import { canExec, describeTarget, relativeTime, runtimeLabel } from './format.js';

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
 * What the card's editor buttons say, and how many there are.
 *
 * One action or two, decided here rather than in the card, because the decision
 * is the interesting part: **the second button only appears when an editor is
 * already attached.** Offering "New window" on a container nobody has open is
 * offering a distinction without a difference — the CLI opens a new window
 * either way — and a permanently-present button that changes meaning silently
 * is worse than one that appears when it starts to matter.
 *
 * When one IS attached the two are genuinely different things, and the labels
 * say which is which: `open` focuses the window that exists, `newWindow` adds
 * a second on the same container. Two windows on one dev container is an
 * ordinary way to work — one per branch, one per agent — so this is not an
 * escape hatch, it is the other half of the feature.
 *
 * `blocked` wins over both: a container with no workspace folder has nothing to
 * open in any number of windows.
 */
export interface EditorAction {
  readonly label: string;
  readonly title: string;
}

export interface EditorActions {
  readonly open: EditorAction;
  /** Absent unless an editor is attached — see above. */
  readonly newWindow: EditorAction | undefined;
}

export function editorActions(
  attachment: EditorAttachment | undefined,
  editorName: string,
  blocked: string | undefined,
  dense: boolean,
): EditorActions {
  if (attachment?.kind !== 'attached') {
    return {
      open: {
        label: dense ? 'Open' : `Open in ${editorName}`,
        title: blocked ?? `Open in ${editorName}`,
      },
      newWindow: undefined,
    };
  }

  const names = attachment.editors.map(editorDisplayName).join(', ');
  return {
    open: {
      label: dense ? 'Focus' : `Focus ${editorName}`,
      title:
        blocked ??
        // Says what it does AND why it can: the window is found by the folder
        // URI, so this raises the one showing THIS container rather than
        // whatever was last in front.
        `Bring the ${names} window already attached to this container to the front. Nothing new is opened.`,
    },
    newWindow: {
      label: dense ? '+' : 'New window',
      title:
        blocked ??
        `Open a SECOND ${editorName} window on this container, alongside the one already attached.`,
    },
  };
}

/**
 * Why the Terminal button is disabled, or undefined when it is not.
 *
 * Two preconditions, and the order matters: a stopped container cannot be
 * exec'd into whatever emulator is installed, so that reason comes first and
 * naming a missing emulator would be a red herring.
 *
 * `terminalName` being undefined is a third case rather than a missing name —
 * nothing was found, so there is nobody to blame and no install to suggest.
 */
export function terminalBlockedReason(
  container: DevContainer,
  terminalAvailable: boolean,
  terminalName: string | undefined,
): string | undefined {
  if (!canExec(container.runtime)) return 'A shell can only be opened in a running container.';
  if (terminalAvailable) return undefined;
  return terminalName === undefined
    ? 'No terminal emulator boxwarden recognises was found on this machine.'
    : `${terminalName} was not found on this machine.`;
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

/**
 * The branch chip, or nothing.
 *
 * Four `GitStatus` arms collapse to two outcomes, and the pairing is not the
 * same one `claudeBadge` makes:
 *
 *   - `branch` / `detached` -> a chip
 *   - `none` / `unknown` / not yet polled -> nothing
 *
 * `unknown` renders NOTHING here, where the Claude badge renders a question
 * mark, and the difference is deliberate. That badge guards a click: a card
 * with no badge is a card saying stopping is safe, so "we could not tell" has
 * to be visible. A branch guards nothing — and its `unknown` arm is the
 * ordinary state of every card on a machine where the folders are not visible
 * (boxwarden running in its own dev container, a WSL path seen from macOS, a
 * daemon over SSH). A question mark on every card, forever, on a machine where
 * nothing is wrong is noise, and noise is how a chip stops being read. The
 * reason is not lost: it is in `GitStatus`, and the folder row already says
 * whether the path could be parsed at all.
 */
export interface BranchChip {
  readonly text: string;
  readonly title: string;
  /** For the accessible name, since "4f2c1ab" alone does not say what it is. */
  readonly label: string;
  readonly tone: 'branch' | 'detached';
  /**
   * How many uncommitted changes, when the count has been read. Absent is not
   * zero: it means git was never asked, which is the ordinary state on a
   * machine that has none installed.
   */
  readonly dirty?: number;
  /** Commits ahead of the upstream, when there is one and it is not zero. */
  readonly ahead?: number;
  /** Commits behind it. Kept apart from `ahead` — the two mean opposite things. */
  readonly behind?: number;
}

/**
 * The counts, as the sentences that go in the chip's tooltip.
 *
 * Words rather than the glyphs the chip shows, because `↑2` is a shape you
 * learn and this is the place that teaches it. Zeroes are dropped rather than
 * printed: "0 behind" is noise on the ninety per cent of chips that are in
 * sync, and an absent upstream must not be reported as agreement.
 */
function describeCounts(status: GitStatus): readonly string[] {
  if (status.kind !== 'branch' && status.kind !== 'detached') return [];

  const lines: string[] = [];
  if (status.tree?.kind === 'dirty') {
    const { changed } = status.tree;
    lines.push(`${String(changed)} uncommitted change${changed === 1 ? '' : 's'}.`);
  }

  if (status.kind === 'branch' && status.tracking !== undefined) {
    const { ahead, behind } = status.tracking;
    if (ahead > 0) lines.push(`${String(ahead)} commit${ahead === 1 ? '' : 's'} not pushed yet.`);
    if (behind > 0) {
      lines.push(`${String(behind)} commit${behind === 1 ? '' : 's'} on the upstream not pulled.`);
    }
  }

  return lines;
}

/** The count fields, spread onto a chip. Absent keys, never zeroes — see `BranchChip`. */
function countFields(status: GitStatus): Partial<BranchChip> {
  if (status.kind !== 'branch' && status.kind !== 'detached') return {};
  const tracking = status.kind === 'branch' ? status.tracking : undefined;

  return {
    ...(status.tree?.kind === 'dirty' ? { dirty: status.tree.changed } : {}),
    ...(tracking !== undefined && tracking.ahead > 0 ? { ahead: tracking.ahead } : {}),
    ...(tracking !== undefined && tracking.behind > 0 ? { behind: tracking.behind } : {}),
  };
}

export function branchChip(status: GitStatus | undefined): BranchChip | undefined {
  if (status === undefined) return undefined;

  switch (status.kind) {
    case 'none':
    case 'unknown':
      return undefined;

    case 'branch':
      return {
        text: status.branch,
        title: [`The workspace folder is on branch ${status.branch}.`, ...describeCounts(status)]
          .join('\n')
          .trim(),
        // The counts join the accessible name, not just the tooltip: the
        // glyphs that carry them on screen are `aria-hidden`, so this is the
        // only place a screen reader meets them.
        label: [`Branch ${status.branch}`, ...describeCounts(status)].join(' '),
        tone: 'branch',
        ...countFields(status),
      };

    case 'detached': {
      const short = shortCommit(status.commit);
      return {
        text: short,
        // The full id, because seven characters is a thing to search for and
        // forty is the thing to paste.
        title: [
          `The workspace folder has a detached HEAD at ${status.commit} — no branch is checked out.`,
          ...describeCounts(status),
        ].join('\n'),
        label: [`Detached HEAD at ${short}`, ...describeCounts(status)].join(' '),
        tone: 'detached',
        ...countFields(status),
      };
    }
  }
}

/** One row of the branch menu. */
export interface BranchMenuItem {
  readonly name: string;
  /** Marked rather than hidden — a menu that omitted it would look incomplete. */
  readonly current: boolean;
  readonly disabled: boolean;
  /**
   * Why it is disabled, for the row's `title`. Always present when `disabled`
   * is true: a control that is off for no stated reason is the thing this
   * whole feature was chosen to avoid.
   */
  readonly reason?: string;
}

/**
 * What the branch menu renders.
 *
 * `unavailable` and an empty `ready` are folded into one arm on purpose. From
 * the user's side "git is not installed", "that folder is not a repository"
 * and "this repository has no branches yet" are the same shape of answer —
 * there is nothing to pick, and here is why — and giving them separate arms
 * would buy three code paths that render one box.
 */
export type BranchMenuView =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      /**
       * A command that would fix it, shown with a Copy button and never run —
       * the same bargain `advice.ts` makes, for a sharper reason: the one
       * failure that currently sets this is git's `safe.directory` check, and
       * an app that silently disabled a repository-trust check on a click is an
       * app nobody should hand a Docker socket.
       */
      readonly command?: string;
    }
  | {
      readonly kind: 'ready';
      /**
       * The one refusal that applies to every row, said ONCE above the list
       * rather than repeated into eight identical tooltips.
       */
      readonly warning?: string;
      readonly items: readonly BranchMenuItem[];
    };

/**
 * Fold a listing into the menu.
 *
 * `undefined` is "the click landed and the answer has not come back", which is
 * a real state here in a way it is not for the chip: listing branches spawns a
 * `git` process, so unlike everything else on a card there is a visible wait.
 *
 * The disabled reasons come from `branchSwitchBlockedReason` in the models —
 * the SAME function the main process applies before it spawns a checkout. That
 * is what makes the greyed-out row and the refusal agree; two copies of this
 * rule would be free to disagree, and the one the user would meet is the one
 * that is not on screen.
 */
export function branchMenu(listing: BranchListing | undefined): BranchMenuView {
  if (listing === undefined) return { kind: 'loading' };
  if (listing.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: listing.reason,
      ...(listing.command === undefined ? {} : { command: listing.command }),
    };
  }

  if (listing.branches.length === 0) {
    return {
      kind: 'unavailable',
      reason: 'This repository has no local branches yet.',
    };
  }

  const warning = treeBlockedReason(listing.tree);

  return {
    kind: 'ready',
    ...(warning === undefined ? {} : { warning }),
    items: listing.branches.map((branch) => {
      const reason = branchSwitchBlockedReason(branch, listing.tree);
      return {
        name: branch.name,
        current: branch.current,
        disabled: reason !== undefined,
        ...(reason === undefined ? {} : { reason }),
      };
    }),
  };
}

/**
 * Everything the card needs to render an interactive chip, in one prop.
 *
 * Grouped rather than spread across five, because they are one thing: without
 * any of them the menu cannot work, and a card that received three of the five
 * would render a button that does nothing. The absence of the whole object is
 * then the honest way to say "this chip does not open" — which is what a test
 * that only cares about the branch TEXT wants to say.
 */
export interface BranchMenuBinding {
  readonly open: boolean;
  /** Undefined until the first listing comes back — rendered as `loading`. */
  readonly listing: BranchListing | undefined;
  /** A checkout is in flight. Every row is inert while it is. */
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onSwitch: (branch: string) => void;
}

/**
 * The Claude Code badge, or nothing.
 *
 * A presenter rather than a `switch` in the component: the View gets a field.
 * Four `ClaudeStatus` arms collapse to three outcomes —
 *
 *   - `running`  -> a badge, with the session count and how long they have been up
 *   - `unknown`  -> a badge that says so, because "we could not tell" and "there
 *                   is nothing running" must not look the same on a card whose
 *                   Stop button reads this
 *   - `none` / `not-applicable` / not yet polled -> nothing
 *
 * `label` is the short form the card shows; `title` is the full text, which the
 * card keeps in the `title` attribute so nothing is lost to the shortening.
 */
export interface ClaudeBadge {
  readonly label: string;
  /**
   * What sits beside the mark — the count, and only when it is worth stating.
   *
   * The card draws the Claude mark in both layouts, so the word "Claude" is
   * carried by the shape and this is what the shape cannot say. One session is
   * therefore the EMPTY string: the mark already means "a session is running",
   * and a `1` next to it is the same fact twice.
   *
   * `?` is the one case where this is not a count, and it has to render — a
   * card with no badge is a card saying stopping is safe, and "we could not
   * tell" must not borrow that meaning.
   */
  readonly denseLabel: string;
  readonly title: string;
  /**
   * `working` is a third tone rather than a flag, so the stylesheet decides how
   * loud it is in one place. It is deliberately NOT a new arm of
   * `ClaudeStatus`: a session that is working is still a session that is
   * present, and splitting the status would make every existing check about
   * presence ask two questions instead of one.
   */
  readonly tone: 'running' | 'working' | 'unknown';
}

export function claudeBadge(status: ClaudeStatus | undefined): ClaudeBadge | undefined {
  if (status === undefined) return undefined;

  switch (status.kind) {
    case 'not-applicable':
    case 'none':
      return undefined;

    case 'unknown':
      return {
        label: 'Claude ?',
        denseLabel: '?',
        title: `Could not tell whether Claude Code is running in this container: ${status.reason}`,
        tone: 'unknown',
      };

    case 'running': {
      const count = status.sessions.length;
      const working = isWorking(status);
      return {
        // The word only appears when it is TRUE. An idle session reads exactly
        // as it did before this signal existed, so "working" stays a thing the
        // eye catches rather than a label every card carries.
        label: working
          ? count === 1
            ? 'Claude · working'
            : `Claude ×${String(count)} · working`
          : count === 1
            ? 'Claude'
            : `Claude ×${String(count)}`,
        // Rows layout has room for a mark and a count and nothing else, so the
        // state rides the TONE there instead of the text.
        denseLabel: count === 1 ? '' : `×${String(count)}`,
        title: [
          count === 1
            ? 'A Claude Code session is running in this container.'
            : `${String(count)} Claude Code sessions are running in this container.`,
          ...status.sessions.map(describeSession),
          count === 1 ? 'Stopping the container ends it.' : 'Stopping the container ends them.',
        ].join('\n'),
        tone: working ? 'working' : 'running',
      };
    }
  }
}

/**
 * One session, for the badge's tooltip.
 *
 * "up" and "since" are not interchangeable, and the wording follows whichever
 * column the engine supplied: Podman gives an elapsed duration, Docker's
 * default `ps -ef` gives a start time. Printing a start time as an elapsed
 * duration would report a session that began ten minutes ago as ten hours old.
 */
function describeSession(session: ClaudeSession): string {
  const age =
    session.elapsed !== undefined
      ? `up ${session.elapsed}`
      : session.startTime !== undefined
        ? `since ${session.startTime}`
        : 'uptime not reported';
  return `  pid ${String(session.pid)} · ${age} · ${describeActivity(session.activity)}`;
}

/**
 * One session's activity, in the tooltip.
 *
 * `unknown` says what it means — "not measured yet" — rather than staying
 * silent, because on the first poll after launch EVERY session reads that way
 * and a blank there looks like a bug rather than like a baseline being taken.
 */
function describeActivity(activity: SessionActivity): string {
  switch (activity.kind) {
    case 'idle':
      return 'idle';
    case 'unknown':
      return 'activity not measured yet';
    case 'working':
      // Naming the signal is what makes a wrong badge diagnosable: "running a
      // command" and "using CPU" fail for different reasons and are fixed in
      // different places.
      switch (activity.signal) {
        case 'subprocess':
          return 'working — running a command';
        case 'cpu':
          return 'working — using CPU';
        case 'both':
          return 'working — running a command, using CPU';
      }
  }
}

/**
 * The warning that annotates a Stop action, or nothing.
 *
 * Two things can make stopping worse than the user expects, and they are not
 * the same thing: a Claude Code session is ENDED by it, and an editor window is
 * STRANDED by it. Both are folded here so the button has one tooltip rather
 * than a race between two.
 *
 * Annotates rather than gates: v1 puts the fact on the button's tooltip and
 * marks it, and leaves the click alone. A confirmation dialog is the right end
 * state, but this app has no modal today and adding the first one should wait
 * until the detection has been seen to be reliable against a real daemon.
 *
 * Takes a LIST so a compose group's "Stop all" aggregates — which is the case
 * where the warning matters most, since that button reaches services whose own
 * cards the user may never have looked at.
 *
 * An `unknown` status deliberately does not warn. Annotating every container
 * boxwarden could not read would train the user to ignore the annotation, which
 * costs more than the case it covers.
 */
export function stopWarning(
  claude: readonly (ClaudeStatus | undefined)[],
  editors: readonly (EditorAttachment | undefined)[] = [],
): string | undefined {
  const lines: string[] = [];

  const sessions = claude.reduce(
    (total, status) => total + (status?.kind === 'running' ? status.sessions.length : 0),
    0,
  );
  // Whether any of them is DOING something right now. It sharpens the sentence
  // rather than adding one: "is running" and "is working right now" are the
  // same warning at two volumes, and stacking both would push the editor
  // warning below the fold of a tooltip.
  const working = claude.some(isWorking);

  if (sessions === 1) {
    lines.push(
      working
        ? 'A Claude Code session is working in here right now. Stopping ends it mid-task.'
        : 'A Claude Code session is running in here. Stopping ends it.',
    );
  }
  if (sessions > 1) {
    lines.push(
      working
        ? `${String(sessions)} Claude Code sessions are running in here and at least one is working right now. Stopping ends them mid-task.`
        : `${String(sessions)} Claude Code sessions are running in here. Stopping ends them.`,
    );
  }

  // Second, and separately worded: an agent is ENDED by stopping, whereas an
  // editor window is CLOSED — boxwarden asks the window manager to shut it
  // before the container goes, so the window is not left pointing at something
  // that no longer exists. Telling the user which of those they are about to do
  // is the whole point of the sentence.
  //
  // "will try to" and not "will", because the attempt genuinely can decline and
  // this string is written before anything has been attempted: a Wayland
  // session, a macOS Accessibility grant nobody has ticked, a window title the
  // user has reconfigured. Promising the close here and reporting the failure
  // afterwards in the message bar would be the wrong way round — a tooltip is
  // read before the click, and it is the only thing that can set the
  // expectation the notice then has to correct.
  const attached = attachedEditorsIn(editors);
  if (attached.length > 0) {
    const names = attached.map(editorDisplayName).join(' and ');
    lines.push(
      `${names} ${attached.length === 1 ? 'is' : 'are'} attached to this container. Stopping will try to close the window first, so it is not left offering to reload.`,
    );
  }

  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * What to say in the message bar about the window a Stop just closed — or
 * didn't.
 *
 * Undefined for the two arms that have nothing to report: `none`, where no
 * editor was attached, and `still-open`, where the stop itself failed and
 * `withBusy` is already showing the sentence that explains why. A second notice
 * about the same click would only push the first one off the bar.
 *
 * The other four all speak, and the reason `not-found` speaks loudest is the
 * reason its arm exists at all: an editor IS attached, the desktop answered,
 * and no window matched — so the user has been left with exactly the stranded
 * window this feature promised to close, and is the one person who can see why.
 */
export function windowClosureNotice(
  closure: EditorWindowClosure | undefined,
  containerName: string,
): Notice | undefined {
  if (closure === undefined) return undefined;

  switch (closure.kind) {
    case 'none':
    case 'still-open':
      return undefined;

    case 'closed': {
      const names = closure.editors.map(editorDisplayName).join(' and ');
      // `editor` is the fallback rather than a missing word: a window matched
      // by a process name we could not classify still got closed, and the
      // sentence has to survive not knowing what it was.
      const what = names === '' ? 'editor' : names;
      return {
        tone: 'info',
        message:
          closure.windows === 1
            ? `Closed the ${what} window and stopped ${containerName}.`
            : `Closed ${String(closure.windows)} ${what} windows and stopped ${containerName}.`,
      };
    }

    case 'not-found': {
      const names = closure.editors.map(editorDisplayName).join(' and ');
      const who = names === '' ? 'An editor is' : `${names} is`;
      return {
        tone: 'error',
        message: `${who} attached to ${containerName}, but boxwarden could not find its window to close it. The window is still open and will offer to reload.`,
      };
    }

    case 'unsupported':
      return { tone: 'error', message: `Stopped ${containerName}. ${closure.reason}` };

    case 'failed':
      return {
        tone: 'error',
        message: `Stopped ${containerName}, but closing the editor window failed: ${closure.reason}`,
      };
  }
}

/**
 * The editor chip, or nothing.
 *
 * Same three-way split as `claudeBadge`, and for the same reason: `unknown`
 * shows, because this decorates a destructive button and "we could not tell"
 * must not look like "nothing is attached".
 */
export interface EditorBadge {
  readonly label: string;
  readonly denseLabel: string;
  /**
   * Which editors, for the rows layout to draw a mark per flavour.
   *
   * Empty for `unknown`, which is the arm where there is no flavour to name —
   * and where `denseLabel` is a question mark for the reason that arm exists at
   * all.
   *
   * Flavours and not names, because the marks carry no `<title>`: an SVG title
   * is a tooltip that would win over the badge's own inside the shape's box.
   * The names are already in `label` and `title`, which is where a reader who
   * cannot see a shape finds them.
   */
  readonly editors: readonly EditorFlavour[];
  readonly title: string;
  readonly tone: 'attached' | 'unknown';
}

export function editorBadge(attachment: EditorAttachment | undefined): EditorBadge | undefined {
  if (attachment === undefined) return undefined;

  switch (attachment.kind) {
    case 'not-applicable':
    case 'none':
      return undefined;

    case 'unknown':
      return {
        label: 'Editor ?',
        denseLabel: '?',
        editors: [],
        title: `Could not tell whether an editor is attached to this container: ${attachment.reason}`,
        tone: 'unknown',
      };

    case 'attached': {
      const names = attachment.editors.map(editorDisplayName).join(', ');
      return {
        label: names,
        // Only reached if the icons cannot render at all. It used to be `⧉` —
        // a generic pair of windows that says an editor is attached and cannot
        // say WHICH, on a card whose whole job is telling containers apart.
        denseLabel: names,
        editors: attachment.editors,
        title: [
          `${names} ${attachment.editors.length === 1 ? 'is' : 'are'} attached to this container.`,
          'Detected from the editor server running inside it, which outlives the window by a few minutes — so this can linger briefly after you close one.',
        ].join('\n'),
        tone: 'attached',
      };
    }
  }
}

/**
 * ---- The update prompt ----
 *
 * Two derivations, because the answer is shown in two places at once and they
 * are not the same thing:
 *
 *   - `updatePanel` is the banner. It exists ONLY when there is a newer
 *     release the user has not waved away, because a panel that is always on
 *     screen is a panel nobody reads by the second week.
 *   - `updateSummary` is the footer line, which is always there. It is also
 *     the only place boxwarden says which version it is, which is worth having
 *     on its own — "what am I running" is the first question in any bug report.
 */

export interface UpdatePanel {
  readonly headline: string;
  readonly detail: string;
  /** Straight from the Model — the steps and commands for this install kind. */
  readonly instructions: UpdateInstructions;
  /**
   * The one file this machine needs, when exactly one matched. Undefined sends
   * the user to the release page to choose, which is the honest answer — see
   * `pickAsset`. A label and a URL travel together so a View cannot render one
   * without the other.
   *
   * This is the ONLY route: boxwarden opens the link and the user takes it from
   * there. See the note at the top of src/models/update.ts for why there is no
   * in-app download beside it.
   */
  readonly link: { readonly label: string; readonly url: string } | undefined;
  readonly releaseUrl: string;
}

/**
 * The update banner, or nothing.
 *
 * `revealed` is what a dismissal does NOT do: "Not now" hides the banner and
 * leaves the footer saying an update exists, and clicking that footer brings
 * this back. A dismissal that could not be undone would be a trap — the user
 * would have to wait for the NEXT release to see the instructions again.
 */
export function updatePanel(
  status: UpdateStatus,
  now: number,
  revealed: boolean,
): UpdatePanel | undefined {
  if (status.outcome.kind !== 'available') return undefined;
  const { release, asset, instructions, dismissed } = status.outcome;
  if (dismissed && !revealed) return undefined;

  const published =
    release.publishedAt === undefined
      ? ''
      : ` It was published ${relativeTime(release.publishedAt, now)}.`;

  return {
    headline: `boxwarden ${release.version} is available`,
    // This sentence must not say "unsigned" flatly, and must not promise a
    // verification the app no longer performs. The artefacts ARE cosign-signed
    // and are still not CODE-signed, which is why the last step of every
    // install is a Gatekeeper or SmartScreen warning — that warning is what
    // `instructions` prepares the user for, and it is the honest thing to lead
    // them towards rather than a claim about what boxwarden checked.
    detail: `You are running ${status.currentVersion}.${published} Downloading and installing it is your click — see the steps below.`,
    instructions,
    link:
      asset === undefined
        ? undefined
        : { label: `${asset.name}${formatSize(asset.size)}`, url: asset.url },
    releaseUrl: release.url,
  };
}

/** Bytes as the browser will show them, or nothing when GitHub did not say. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const megabytes = bytes / (1024 * 1024);
  return ` (${megabytes < 10 ? megabytes.toFixed(1) : String(Math.round(megabytes))} MB)`;
}

export interface UpdateSummary {
  readonly label: string;
  readonly title: string;
}

/**
 * The footer line, for every arm of the status.
 *
 * The six arms produce six different sentences on purpose. "Up to date" and
 * "could not check" must never look the same — one of them is a promise the
 * app is in no position to make — and neither may borrow the silence that
 * "checks are off" is entitled to.
 */
export function updateSummary(status: UpdateStatus, now: number): UpdateSummary {
  const name = status.currentVersion === '' ? 'boxwarden' : `boxwarden ${status.currentVersion}`;
  const checked =
    status.checkedAt === undefined
      ? 'boxwarden has not checked for a new release yet.'
      : `Last checked ${relativeTime(status.checkedAt, now)}.`;
  const clickToCheck = 'Click to check now.';

  switch (status.outcome.kind) {
    case 'unsupported':
      return { label: `${name} · development build`, title: status.outcome.reason };

    case 'disabled':
      return {
        label: `${name} · update checks off`,
        title: `boxwarden is not contacting GitHub. Click to turn the daily check back on and look now.`,
      };

    case 'unchecked':
      return { label: name, title: `${checked} ${clickToCheck}` };

    case 'current':
      return { label: `${name} · up to date`, title: `${checked} ${clickToCheck}` };

    case 'failed':
      return {
        label: `${name} · update check failed`,
        title: `${status.outcome.message} ${clickToCheck}`,
      };

    case 'available':
      return {
        label: `${name} · ${status.outcome.release.version} available`,
        title: status.outcome.dismissed
          ? `You said not now to ${status.outcome.release.version}. Click to see how to install it.`
          : `${checked} Click to see how to install it.`,
      };
  }
}
