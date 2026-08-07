import type { BranchMenuView } from '../presenters.js';

interface Props {
  readonly view: BranchMenuView;
  /** A checkout is running. Every row is inert, and the one clicked says so. */
  readonly busy: boolean;
  readonly onSwitch: (branch: string) => void;
  readonly onClose: () => void;
}

/**
 * The list of branches hanging off a card's chip.
 *
 * A View: every string it shows was decided by `branchMenu` in `presenters.ts`,
 * and the open/closed state belongs to `useBranches`. There is no `useState`
 * here and there must not be — the menu's own visibility is somebody else's
 * decision, which is what lets one card's menu close when another's opens.
 */
export function BranchMenu({ view, busy, onSwitch, onClose }: Props) {
  return (
    <>
      {/*
        The outside click, as markup rather than a document listener. A backdrop
        is one element, it needs no cleanup, it cannot leak past unmount, and a
        test can click it. `aria-hidden` plus `tabIndex={-1}` keep it out of the
        tab order and off a screen reader — Escape is the keyboard's way out,
        and it is handled in the ViewModel.
      */}
      <div
        className="menu-backdrop"
        aria-hidden="true"
        onClick={onClose}
        // A div and not a button: a full-screen button is announced, focusable
        // and lands in the tab order between the chip and the menu it opened.
        // The keyboard already has Escape, so this exists only for the pointer.
      />

      <div className="branch-menu" role="menu" aria-label="Switch branch">
        {view.kind === 'loading' && <p className="branch-menu-note">Reading branches…</p>}

        {view.kind === 'unavailable' && <p className="branch-menu-note">{view.reason}</p>}

        {view.kind === 'ready' && (
          <>
            {/* Said once, above the list, rather than repeated into every
                row's tooltip — the rows are all disabled for this one reason
                and a person should not have to hover to find that out. */}
            {view.warning !== undefined && <p className="branch-menu-warning">{view.warning}</p>}

            <ul className="branch-menu-list">
              {view.items.map((item) => (
                <li key={item.name}>
                  <button
                    type="button"
                    role="menuitem"
                    className={item.current ? 'branch-menu-item current' : 'branch-menu-item'}
                    // `reason` is always present when disabled, so a greyed row
                    // never sits there unexplained.
                    title={item.reason}
                    disabled={item.disabled || busy}
                    onClick={() => {
                      onSwitch(item.name);
                    }}
                  >
                    {/* A fixed-width slot so the names line up whether or not
                        the row is the current one — a tick that shifted the
                        text would make the list harder to scan, which is the
                        one thing it has to be good at. */}
                    <span className="branch-menu-mark" aria-hidden="true">
                      {item.current ? '✓' : ''}
                    </span>
                    <span className="branch-menu-name">{item.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
