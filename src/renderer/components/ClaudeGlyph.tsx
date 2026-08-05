import { SiClaude } from 'react-icons/si';

/**
 * The Claude mark, for the Claude Code presence badge.
 *
 * ## Which mark, and why not the obvious one
 *
 * `react-icons` also carries `SiClaudecode`, and this badge is about Claude
 * CODE — so that looks like the right answer and is not. That mark is the
 * pixel-art critter, and the badge renders at 13px, where it collapses into an
 * unreadable blob. The sunburst survives the size, and nothing is lost by it:
 * the badge's own label and title both say "Claude Code", so the mark only has
 * to carry whose it is.
 *
 * Of the several sunbursts in the package (`VscClaude`, `BsClaude`,
 * `RiClaudeFill` all draw one), this is Simple Icons' — which tracks the
 * official brand asset, where the others are each project's own redraw. At
 * badge size the difference is marginal; authenticity is the tiebreak for a
 * logo. It is also CC0, so it adds no obligation to the ones already recorded
 * in `docs/supply-chain.md`.
 *
 * ## Why it is not part of EditorGlyph
 *
 * That component answers "which of several products", from a table keyed by
 * flavour. This one is a single mark for a single fact, and folding it into a
 * flavour table would mean inventing a flavour that means "not an editor".
 * They share the stylesheet's `.editor-glyph` sizing rule and nothing else.
 *
 * The colour comes from the badge — `--claude`, per theme — because the mark is
 * monochrome and inherits `currentColor`. Same rule as every other colour here.
 *
 * ## No `<title>`, deliberately
 *
 * An SVG `<title>` is a TOOLTIP, and it wins over the ancestor's `title`
 * attribute inside the shape's own box. Putting one here would mean hovering
 * the mark — the most hoverable thing in the badge — replaced the pids and
 * uptimes with the word "Claude Code". It buys nothing back, because the mark
 * is `aria-hidden` and the badge around it already carries an `aria-label`.
 */
export function ClaudeGlyph() {
  return <SiClaude className="editor-glyph" size={13} aria-hidden="true" />;
}
