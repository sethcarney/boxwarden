/**
 * Which setup advisories are on screen, and which the user has put away.
 *
 * WHY THIS EXISTS
 *
 * `src/models/advice.ts` decides what is worth telling the user about their
 * setup. That is a judgement made from the environment alone, and it has no way
 * to know that this particular developer has read the note about the `docker`
 * CLI four hundred times and does not intend to install it. Left alone, the
 * panel at the top of the window is permanent furniture — and an advisory panel
 * that is always there is one nobody reads on the day it says something urgent.
 *
 * So the user can hide one. The rule that makes hiding safe is that NOTHING IS
 * EVER DESTROYED: a hidden advisory is still computed, still counted, and still
 * listed in full on the setup page, which is reachable from the header whether
 * or not anything is wrong. "Dismiss" here means "not on the main screen", never
 * "gone".
 *
 * WHY LOCALSTORAGE AND NOT `preferences.json`
 *
 * Same reason as `view.ts`: the main process makes no decision from this. It
 * computes the advice either way, and only the renderer chooses where to draw
 * it. Putting it in the preferences file would buy a sixteenth IPC verb nothing.
 *
 * The parsing and the folding are pure and tested here; the two functions that
 * touch `window` are the thin shell around them, and both swallow their
 * failures — a browser with storage disabled should show every advisory, which
 * is the safe direction to fail in.
 */

import type { Advice, AdviceSeverity } from '../models/index.js';

const STORAGE_KEY = 'boxwarden.hiddenAdvice';

/**
 * Hiding is keyed on `Advice.id`, which is stable across runs by design (see
 * the field's comment in `advice.ts`). The consequence worth knowing: an
 * advisory whose *details* change — `wsl-socat-missing` naming a different
 * distro — stays hidden, because it is the same id. That is the right trade
 * only because the setup page lists hidden advisories in full rather than
 * summarising them, so the new distro is one click away rather than lost.
 */
export type AdviceId = string;

export interface AdvicePartition {
  /** Shown at the top of the container list, as before. */
  readonly active: readonly Advice[];
  /** Hidden from the main screen; the setup page shows these in full. */
  readonly hidden: readonly Advice[];
}

/**
 * Splits this scan's advice by what the user has put away.
 *
 * Order is preserved on both sides: `adviseEnvironment` emits most urgent
 * first, and re-sorting here would quietly disagree with it.
 */
export function partitionAdvice(
  advice: readonly Advice[],
  hidden: readonly AdviceId[],
): AdvicePartition {
  const put = new Set(hidden);
  return {
    active: advice.filter((entry) => !put.has(entry.id)),
    hidden: advice.filter((entry) => put.has(entry.id)),
  };
}

/**
 * An advisory's body starts open or closed, by severity.
 *
 * A blocking error is the whole reason the user is looking at the window, so
 * folding it shut would hide the fix behind a click. A note is the opposite: it
 * is true, it is worth having, and it is not why anyone opened the app. Notes
 * arrive collapsed to a single line and open on demand.
 */
export function startsExpanded(severity: AdviceSeverity): boolean {
  return severity !== 'info';
}

const SEVERITY_RANK: Record<AdviceSeverity, number> = { error: 3, warning: 2, info: 1 };

export type SetupTone = AdviceSeverity | 'none';

export interface SetupBadge {
  /** Active advisories — what the header button counts. Hidden ones are not urgent by definition. */
  readonly count: number;
  /** The worst severity among the active advisories, or `none` when there are none. */
  readonly tone: SetupTone;
  /** The button's tooltip, which is where the hidden ones are accounted for. */
  readonly title: string;
}

/**
 * The header button's count and tooltip.
 *
 * The count is of ACTIVE advisories only — a hidden one is by definition not
 * something the user wants counted at them. But the tooltip says how many are
 * hidden, because a count of zero next to a page holding four hidden warnings
 * would be the one lie this feature could tell.
 */
export function setupBadge(partition: AdvicePartition): SetupBadge {
  const { active, hidden } = partition;
  const tone = active.reduce<SetupTone>(
    (worst, entry) =>
      worst === 'none' || SEVERITY_RANK[entry.severity] > SEVERITY_RANK[worst]
        ? entry.severity
        : worst,
    'none',
  );

  const headline =
    active.length === 0
      ? 'Setup and diagnostics. Nothing needs your attention.'
      : `${String(active.length)} thing${active.length === 1 ? '' : 's'} about this machine’s setup ${
          active.length === 1 ? 'is' : 'are'
        } worth reading.`;

  const tail =
    hidden.length === 0
      ? ''
      : ` ${String(hidden.length)} hidden ${hidden.length === 1 ? 'advisory is' : 'advisories are'} still here.`;

  return { count: active.length, tone, title: `${headline}${tail}` };
}

/** What the setup page says when this machine has nothing wrong with it. */
export function setupSummary(partition: AdvicePartition): string {
  const { active, hidden } = partition;
  if (active.length === 0 && hidden.length === 0) {
    return 'boxwarden found nothing to advise about this machine. Everything it checks — the container engine, WSL, the SSH agent, the docker CLI — is either working or not needed here.';
  }
  if (active.length === 0) {
    return `Nothing needs your attention right now. ${String(hidden.length)} ${
      hidden.length === 1 ? 'advisory is' : 'advisories are'
    } hidden from the main screen and still listed below.`;
  }
  return `${String(active.length)} ${active.length === 1 ? 'advisory' : 'advisories'} about this machine’s setup, in full. Hiding one takes it off the main screen; it stays on this page.`;
}

/** Adds an id, without letting a double click store it twice. */
export function withHidden(hidden: readonly AdviceId[], id: AdviceId): readonly AdviceId[] {
  return hidden.includes(id) ? hidden : [...hidden, id];
}

export function withoutHidden(hidden: readonly AdviceId[], id: AdviceId): readonly AdviceId[] {
  return hidden.filter((entry) => entry !== id);
}

/**
 * Reads a stored list back.
 *
 * Ids that no advisory currently carries are KEPT rather than pruned. An
 * advisory the user hid is usually one whose condition comes and goes — a
 * stopped WSL distro, an engine that is down — and pruning on load would
 * un-hide it the first time the machine was briefly healthy.
 */
export function parseHiddenAdvice(raw: unknown): readonly AdviceId[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((entry): entry is string => typeof entry === 'string');
  return [...new Set(ids)];
}

export function loadHiddenAdvice(): readonly AdviceId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    return parseHiddenAdvice(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveHiddenAdvice(hidden: readonly AdviceId[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(hidden));
  } catch {
    // A quota or a disabled store is not worth interrupting anyone over. The
    // choice still applies for this run, held in React state.
  }
}
