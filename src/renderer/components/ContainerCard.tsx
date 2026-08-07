import type {
  ClaudeStatus,
  DevContainer,
  EditorAttachment,
  EditorId,
  GitStatus,
  OpenInEditorMode,
} from '../../models/index.js';
import {
  canStart,
  canStop,
  cardClass,
  hostPathLabel,
  statusLabel,
  statusTextClass,
} from '../format.js';
import type { BranchChip, BranchMenuBinding } from '../presenters.js';
import {
  branchChip,
  branchMenu as branchMenuView,
  cardTitle,
  claudeBadge,
  editorActions,
  editorBadge,
  stopWarning,
  openBlockedReason,
  portLabel,
  sshAgentBadge,
  terminalBlockedReason,
  visiblePorts,
} from '../presenters.js';
import { BranchMenu } from './BranchMenu.js';
import { ClaudeGlyph } from './ClaudeGlyph.js';
import { EditorGlyph } from './EditorGlyph.js';
import { StartupCommandField } from './StartupCommandField.js';
import { StatusDot } from './StatusDot.js';

interface Props {
  readonly container: DevContainer;
  readonly editorId: EditorId;
  readonly editorName: string;
  readonly editorAvailable: boolean;
  /** Undefined when no emulator was found — a different sentence from "Konsole was not found". */
  readonly terminalName: string | undefined;
  readonly terminalAvailable: boolean;
  /** '' when none is set. */
  readonly startupCommand: string;
  readonly busy: boolean;
  readonly now: number;
  /**
   * Rows layout: one line per container. Trims the labels that do not fit on
   * one — the image, and the editor's name inside the primary button. Nothing
   * is dropped without a `title` keeping it reachable.
   */
  readonly dense?: boolean;
  /**
   * Whether Claude Code is running in this container.
   *
   * Absent while the first poll is outstanding, and for a container the main
   * process has not been asked about. Absent is NOT `{ kind: 'none' }`: one
   * means "no answer yet", the other means "asked, nothing running", and only
   * the second one makes the Stop button safe.
   *
   * Spelled `?: T | undefined` rather than `?: T` because
   * exactOptionalPropertyTypes is on and the parent passes the result of a
   * lookup — an expression that is legitimately `undefined` rather than a key
   * it can omit.
   */
  readonly claude?: ClaudeStatus | undefined;
  /**
   * Whether an editor is attached to this container.
   *
   * Absent while the first poll is outstanding, and NOT the same as
   * `{ kind: 'none' }` — the same rule as `claude` above, and for the same
   * reason: no badge on this card is how it says stopping costs nothing.
   */
  readonly editor?: EditorAttachment | undefined;
  /**
   * Which branch the workspace folder is on.
   *
   * Absent while the first read is outstanding. Unlike `claude`, absent and
   * `{ kind: 'none' }` render identically — nothing here gates an action, so
   * there is no meaning attached to the chip being missing.
   */
  readonly git?: GitStatus | undefined;
  /**
   * What makes the chip a control rather than a label.
   *
   * Absent means the chip does not open — which is the honest state for a card
   * rendered without the wiring, and the default a test gets when it only cares
   * what branch is printed. Present means the whole mechanism is there: the
   * open flag, the listing, the busy flag and both callbacks. There is no
   * halfway, because a chip with a toggle and no listing is a button that opens
   * an empty box.
   */
  readonly branchMenu?: BranchMenuBinding | undefined;
  readonly onStart: (container: DevContainer) => void;
  readonly onStop: (container: DevContainer) => void;
  /** `mode` is omitted for the ordinary open; the card only passes it for "New window". */
  readonly onOpen: (container: DevContainer, mode?: OpenInEditorMode) => void;
  readonly onOpenTerminal: (container: DevContainer) => void;
  readonly onStartupCommandChange: (container: DevContainer, command: string) => void;
}

/**
 * A View. Every string it shows comes from `format.ts` or `presenters.ts`, and
 * every action is a callback — there is no decision made in this file.
 *
 * `now` arrives as a prop rather than being read inside. The ViewModel ticks it
 * once a second, so every "Up 3 minutes" on screen advances together off one
 * timer instead of each card owning one.
 */
export function ContainerCard({
  container,
  editorName,
  editorAvailable,
  terminalName,
  terminalAvailable,
  startupCommand,
  busy,
  now,
  dense = false,
  claude,
  editor,
  git,
  branchMenu,
  onStart,
  onStop,
  onOpen,
  onOpenTerminal,
  onStartupCommandChange,
}: Props) {
  const unresolved = container.localFolder.kind === 'unresolved';
  const ports = visiblePorts(container);
  const blocked = openBlockedReason(container, editorAvailable, editorName);
  const terminalBlocked = terminalBlockedReason(container, terminalAvailable, terminalName);
  const agent = sshAgentBadge(container.sshAgent);
  const badge = claudeBadge(claude);
  const attached = editorBadge(editor);
  const branch = branchChip(git);
  const warning = stopWarning([claude], [editor]);
  const actions = editorActions(editor, editorName, blocked, dense);

  return (
    <article className={cardClass(container.runtime, unresolved)}>
      <header className="card-head">
        <div className="card-title">
          <StatusDot runtime={container.runtime} />
          <h2>{cardTitle(container)}</h2>
          {/* Beside the name rather than in the meta list below it: the branch
              is the second thing a person needs to identify a checkout, and the
              meta list is the part the rows layout hides. Long branch names are
              ellipsised by the stylesheet and kept whole in `title`. */}
          {branch !== undefined && (
            <span className="branch-chip-slot">
              {/*
                A button when the card was given a menu to open, and a plain
                span otherwise. The two are not interchangeable and the split is
                not laziness: a button that opens nothing is a control that lies
                about being one, and `branchMenu` is absent exactly where there
                is nothing to open — a card rendered without the binding.
              */}
              {branchMenu === undefined ? (
                <span
                  className={`branch-chip branch-chip-${branch.tone}`}
                  title={branch.title}
                  aria-label={branch.label}
                >
                  <span className="branch-chip-icon" aria-hidden="true">
                    ⎇
                  </span>
                  {/* Wrapped rather than left as a bare text node:
                      `text-overflow` has nothing to act on inside a flex
                      container, so an unwrapped name is CLIPPED to nothing on a
                      narrow window instead of ellipsised to `clau…`. */}
                  <span className="branch-chip-name">{branch.text}</span>
                  <BranchCounts chip={branch} />
                </span>
              ) : (
                <button
                  type="button"
                  className={`branch-chip branch-chip-${branch.tone} branch-chip-button`}
                  title={`${branch.title}\nClick to switch.`}
                  aria-label={`${branch.label}. Switch branch.`}
                  aria-haspopup="menu"
                  aria-expanded={branchMenu.open}
                  // Not disabled while `busy`: the button is how the menu
                  // CLOSES, and a checkout that takes a moment would otherwise
                  // trap the user in a popover they cannot dismiss by the route
                  // they opened it. The rows inside are the things that go
                  // inert.
                  onClick={branchMenu.onToggle}
                >
                  <span className="branch-chip-icon" aria-hidden="true">
                    ⎇
                  </span>
                  <span className="branch-chip-name">{branch.text}</span>
                  <BranchCounts chip={branch} />
                </button>
              )}

              {branchMenu?.open === true && (
                <BranchMenu
                  view={branchMenuView(branchMenu.listing)}
                  busy={branchMenu.busy}
                  onSwitch={branchMenu.onSwitch}
                  onClose={branchMenu.onToggle}
                />
              )}
            </span>
          )}
          {/* Nothing at all for `absent` — see the note on sshAgentBadge. */}
          {agent !== undefined && (
            <span
              className={`agent-badge${agent.warning ? ' agent-badge-warning' : ''}`}
              title={agent.title}
            >
              {dense ? agent.short : agent.text}
            </span>
          )}
        </div>
        <div className="card-head-right">
          {/* Shortened under `dense` to a bare count, with the full text kept
              in `title` — the same contract as the image row and the primary
              button. The session count, pids and uptimes are all in there. */}
          {attached !== undefined && (
            <span
              className={`badge badge-editor badge-editor-${attached.tone}`}
              title={attached.title}
              aria-label={`${attached.label} attached`}
            >
              {/* Rows layout draws the editors' own marks rather than a name
                  it has no width for. The mark is what a user recognises
                  without reading, which is the whole job of a one-line row —
                  and unlike the generic glyph it replaces, it says WHICH
                  editor. `aria-label` above carries the names regardless, so
                  nothing is lost to a reader who cannot see the shape. */}
              {dense && attached.editors.length > 0
                ? attached.editors.map((flavour) => <EditorGlyph key={flavour} flavour={flavour} />)
                : dense
                  ? attached.denseLabel
                  : attached.label}
            </span>
          )}
          {badge !== undefined && (
            <span
              className={`badge badge-claude badge-claude-${badge.tone}`}
              title={badge.title}
              aria-label={badge.label}
            >
              {/* The mark in BOTH layouts, unlike the editor badge beside it,
                  which only draws one when it has no room for a name. There is
                  only ever one product here, so the shape is not being asked
                  to distinguish between several — it is the fastest way to
                  recognise the badge, which is worth its width even where
                  there is room for text.

                  The WORD stays wherever it fits, though, and the redundancy
                  is deliberate: this badge guards a destructive click, and a
                  bare orange asterisk means nothing to somebody who has not
                  seen it before. Only the rows layout, which has no room for
                  it, falls back to the mark plus a count. */}
              <ClaudeGlyph />
              {dense ? badge.denseLabel : badge.label}
            </span>
          )}
          <span className={statusTextClass(container.runtime)}>
            {statusLabel(container.runtime, now)}
          </span>
        </div>
      </header>

      <dl className="card-meta">
        <dt className="meta-folder">Folder</dt>
        <dd
          className={`meta-folder${unresolved ? ' unresolved' : ''}`}
          title={hostPathLabel(container.localFolder)}
        >
          {hostPathLabel(container.localFolder)}
          {/* `unresolved` is a const derived from the same check, so TypeScript
              narrows localFolder here — no second guard needed. */}
          {container.localFolder.kind === 'unresolved' && (
            <span className="hint"> — {container.localFolder.reason}</span>
          )}
        </dd>

        {/* Hidden by the stylesheet in rows layout — see `.meta-image`. */}
        <dt className="meta-image">Image</dt>
        <dd className="meta-image" title={container.image}>
          {container.image}
        </dd>

        {ports.length > 0 && (
          <>
            <dt className="meta-ports">Ports</dt>
            <dd className="meta-ports ports">
              {ports.map((port) => {
                const label = portLabel(port);
                return (
                  <span
                    key={`${String(port.containerPort)}/${port.protocol}/${port.hostPort ?? 'none'}`}
                    className={port.hostPort === undefined ? 'port port-unpublished' : 'port'}
                    title={label.title}
                  >
                    {label.text}
                  </span>
                );
              })}
            </dd>
          </>
        )}

        <StartupCommandField
          value={startupCommand}
          disabled={busy}
          onCommit={(command) => {
            onStartupCommandChange(container, command);
          }}
        />
      </dl>

      <footer className="card-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || blocked !== undefined}
          title={actions.open.title}
          onClick={() => {
            onOpen(container);
          }}
        >
          {actions.open.label}
        </button>

        {/* Only once an editor is attached — see `editorActions`. Until then
            the two buttons would do the same thing under different names. */}
        {actions.newWindow !== undefined && (
          <button
            type="button"
            className="secondary-open"
            disabled={busy || blocked !== undefined}
            title={actions.newWindow.title}
            aria-label={`Open a new ${editorName} window on this container`}
            onClick={() => {
              onOpen(container, 'new-window');
            }}
          >
            {actions.newWindow.label}
          </button>
        )}

        <button
          type="button"
          disabled={busy || terminalBlocked !== undefined}
          title={
            terminalBlocked ??
            `Open a shell in this container${terminalName === undefined ? '' : ` with ${terminalName}`}.`
          }
          onClick={() => {
            onOpenTerminal(container);
          }}
        >
          Terminal
        </button>

        {canStop(container.runtime) && (
          <button
            type="button"
            // Annotated, not gated. Stopping a container with a live agent in
            // it stays one click — it just stops being an uninformed one.
            className={warning === undefined ? undefined : 'warn'}
            title={warning}
            disabled={busy}
            onClick={() => {
              onStop(container);
            }}
          >
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}

        {canStart(container.runtime) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onStart(container);
            }}
          >
            {busy ? 'Starting…' : 'Start'}
          </button>
        )}
      </footer>
    </article>
  );
}

/**
 * The counts that ride on the branch chip: uncommitted changes, and how far
 * this branch has drifted from its upstream.
 *
 * Glyphs rather than words because the chip is 10px and already holds a branch
 * name it is allowed to ellipsise — every character here competes with that.
 * The words are in the chip's `title`, which is where `describeCounts` puts
 * them, so nothing is only ever a symbol.
 *
 * Each one is absent rather than zero when it does not apply. That is the whole
 * discipline of this feature: a chip with no `●` says the tree is clean, a chip
 * with no `↑` says nothing is unpushed, and a chip on a machine with no git
 * says neither — which is why absence had to mean "not asked" everywhere up the
 * chain rather than "none".
 */
function BranchCounts({ chip }: { readonly chip: BranchChip }) {
  if (chip.dirty === undefined && chip.ahead === undefined && chip.behind === undefined) {
    return null;
  }

  return (
    <span className="branch-counts" aria-hidden="true">
      {chip.dirty !== undefined && <span className="branch-count dirty">●{chip.dirty}</span>}
      {chip.ahead !== undefined && <span className="branch-count ahead">↑{chip.ahead}</span>}
      {chip.behind !== undefined && <span className="branch-count behind">↓{chip.behind}</span>}
    </span>
  );
}
