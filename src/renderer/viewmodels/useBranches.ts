import { useCallback, useEffect, useRef, useState } from 'react';
import type { BranchListing, ContainerId } from '../../models/index.js';
import type { BoxwardenApi } from '../../shared/ipc.js';
import type { BranchMenuBinding } from '../presenters.js';
import { errorMessage } from '../presenters.js';
import { useMounted } from './useMounted.js';
import type { NoticesViewModel } from './useNotices.js';

export interface BranchesViewModel {
  /** Which card's menu is showing, if any. At most one — see the hook. */
  readonly openFor: ContainerId | undefined;
  /** The listing for `openFor`. Undefined while the `git` call is outstanding. */
  readonly listing: BranchListing | undefined;
  /** A checkout is running. The menu stays open and inert until it lands. */
  readonly busy: boolean;
  readonly toggle: (id: ContainerId) => void;
  readonly close: () => void;
  readonly switchTo: (id: ContainerId, branch: string) => void;
  /**
   * Everything one card's chip needs, as the single prop it takes.
   *
   * Here and not built in the View for the ordinary reason: binding an id into
   * two callbacks is a derivation, and a View that did it would be deciding
   * which container each click refers to. It also means `listing` is handed out
   * only to the card whose menu is open — the others get `undefined`, so a
   * stale listing cannot render under the wrong name even by mistake.
   */
  readonly bindingFor: (id: ContainerId) => BranchMenuBinding;
}

/**
 * The branch menu: which one is open, what it holds, and switching.
 *
 * ## Why this is not part of `useGitStatus`
 *
 * That hook is a POLL. It asks about every container every thirty seconds and
 * owns a map that outlives any one card. This owns the state of an open menu,
 * which exists between two clicks and concerns exactly one container — and it
 * spawns `git` processes, which a poll must never do. The two are joined by
 * one call: a successful switch refreshes the poll, so the chip catches up
 * immediately instead of up to thirty seconds later.
 *
 * ## Why only one menu is open at a time
 *
 * A popover is modal by convention, and holding a listing per container would
 * mean caching answers that go stale the moment the user runs git in a
 * terminal — the state this app is FOR. One listing, fetched on open, discarded
 * on close: what is on screen was read when it was asked for. It also makes
 * Escape and the backdrop trivial, because there is one thing to close.
 *
 * ## Why the refusals are not decided here
 *
 * They are decided in `src/models/git.ts` and enforced in the main process,
 * immediately before the checkout. What this hook does with a refusal is
 * report it: `switchTo` is allowed to be called for a row the UI disabled, and
 * the answer will be the same sentence either way. A ViewModel that refused on
 * its own would be a second copy of the rule, and the copy that mattered would
 * be the one nobody could see.
 */
export function useBranches(
  api: BoxwardenApi | undefined,
  notices: NoticesViewModel,
  /** Called after a switch lands, so the branch chip re-reads instead of waiting for its poll. */
  onSwitched: () => void,
): BranchesViewModel {
  const [openFor, setOpenFor] = useState<ContainerId | undefined>(undefined);
  const [listing, setListing] = useState<BranchListing | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();

  // Destructured rather than held as the object, the same as the two polls:
  // `useNotices` returns a fresh literal each render.
  const { showError } = notices;

  /**
   * Which open this answer belongs to.
   *
   * `listBranches` spawns git, so a user who opens one card's menu and then
   * another's before the first answers has two calls in flight. Without this,
   * the slower one wins and card B shows card A's branches — a wrong answer
   * that looks exactly like a right one.
   */
  const wanted = useRef<ContainerId | undefined>(undefined);

  const close = useCallback(() => {
    wanted.current = undefined;
    setOpenFor(undefined);
    setListing(undefined);
  }, []);

  const load = useCallback(
    async (id: ContainerId) => {
      if (api === undefined) return;
      try {
        const next = await api.listBranches(id);
        if (mounted.current && wanted.current === id) setListing(next);
      } catch (error) {
        // An `unavailable` arm rather than a notice: the answer belongs in the
        // box the user just opened, where they are already looking, and the
        // notice bar is for failures that follow an ACTION. Opening a menu is
        // not one.
        if (mounted.current && wanted.current === id) {
          setListing({ kind: 'unavailable', reason: errorMessage(error) });
        }
      }
    },
    [api, mounted],
  );

  const toggle = useCallback(
    (id: ContainerId) => {
      if (openFor === id) {
        close();
        return;
      }
      wanted.current = id;
      setOpenFor(id);
      // Cleared, not kept: the previous card's branches must never be on screen
      // under this card's name, even for one frame.
      setListing(undefined);
      void load(id);
    },
    [openFor, close, load],
  );

  const switchTo = useCallback(
    (id: ContainerId, branch: string) => {
      if (api === undefined || busy) return;
      setBusy(true);

      void (async () => {
        try {
          const result = await api.switchBranch(id, branch);
          if (!mounted.current) return;

          if (result.ok) {
            close();
            onSwitched();
            return;
          }

          // A refusal is not an exception, and it is the message the models
          // layer wrote — "commit or stash them first", "already checked out
          // in …". The menu STAYS OPEN behind it, because the user's next
          // move is usually a different branch.
          showError(result.message);
          void load(id);
        } catch (error) {
          if (mounted.current) showError(errorMessage(error));
        } finally {
          if (mounted.current) setBusy(false);
        }
      })();
    },
    [api, busy, mounted, close, onSwitched, showError, load],
  );

  /**
   * Escape closes it.
   *
   * Here and not in the component for the reason every other decision is: a
   * View may not hold state, and a listener that closes a menu is reaching for
   * the state this hook owns. The backdrop that catches an outside click is
   * markup rather than a second listener — see `BranchMenu.tsx`.
   */
  useEffect(() => {
    if (openFor === undefined) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openFor, close]);

  const bindingFor = useCallback(
    (id: ContainerId): BranchMenuBinding => {
      const open = openFor === id;
      return {
        open,
        // Only the open card sees a listing — see the note on the field.
        listing: open ? listing : undefined,
        busy: open && busy,
        onToggle: () => {
          toggle(id);
        },
        onSwitch: (branch: string) => {
          switchTo(id, branch);
        },
      };
    },
    [openFor, listing, busy, toggle, switchTo],
  );

  return { openFor, listing, busy, toggle, close, switchTo, bindingFor };
}
