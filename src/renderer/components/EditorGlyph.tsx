import { SiCursor, SiWindsurf } from 'react-icons/si';
import { VscVscode, VscVscodeInsiders, VscWindow } from 'react-icons/vsc';
import type { IconType } from 'react-icons';
import type { EditorFlavour } from '../../models/index.js';

/**
 * The attached-editor badge's icon, for the rows layout.
 *
 * ## Why an icon at all
 *
 * The rows layout gives a container one line, so the badge that says "VS Code
 * is attached" had to shorten to something. It was `⧉` — a generic "two
 * overlapping windows" glyph that says an editor is attached and cannot say
 * WHICH, on a card whose whole purpose is to distinguish one container from
 * another. A user running VS Code on one workspace and Cursor on the next got
 * the same mark on both rows.
 *
 * ## Where the marks come from
 *
 * `react-icons`, which carries each product's OWN mark — including a distinct
 * one for Insiders, which is a better answer than recolouring the stable
 * ribbon, because that is how the two are actually told apart in a dock.
 * Drawing approximations by hand was the alternative and it is a bad one: an
 * almost-right logo reads as a rendering bug.
 *
 * It is a **devDependency**, deliberately, and that is not a filing error.
 * Vite inlines these four icons into the renderer bundle at build time, so
 * nothing resolves `react-icons` at runtime — while electron-builder copies
 * every PRODUCTION dependency into `app.asar` verbatim. Left in
 * `dependencies`, all 85 MB of the package would ship inside every installer
 * to deliver four path strings Vite had already inlined. Verified by listing
 * the asar. See `docs/supply-chain.md`.
 *
 * The cost that remains is 8 kB of renderer bundle, which is the icons plus
 * `react-icons`' tiny element-builder, and about two seconds of build time
 * spent tree-shaking its per-set index files.
 *
 * ## Attribution — required, not courtesy
 *
 * The VS Code marks are **codicons, under CC BY 4.0**, which obliges
 * attribution wherever they are redistributed; the Cursor and Windsurf marks
 * are Simple Icons, under CC0, which does not. Both notices live in
 * `docs/supply-chain.md` alongside the rest of what this app ships. The logos
 * themselves remain their owners' trademarks and are used here to identify
 * those products, which is what a mark is for; boxwarden claims no
 * affiliation.
 *
 * ## Why the colours are not here
 *
 * Every icon is monochrome and inherits `currentColor`, so the tint is a CSS
 * rule on the class rather than a prop. That is the stylesheet's standing rule
 * — a colour picked against the dark surface is the one that vanishes on the
 * light one — and keeping it out of this file means the light palette can
 * darken the brand blue without a second table to keep in step.
 */

/**
 * Flavour to mark. A table, the same shape as `editor/targets.ts` and
 * `terminal/targets.ts`: adding a fork should be a row, not a branch.
 *
 * `unknown` is a server recognised as an editor's without being recognised as
 * anyone's. A plain window says "something is attached" without claiming a
 * product, which is the only honest thing to draw for it.
 */
const MARKS: Readonly<Record<EditorFlavour, IconType>> = {
  vscode: VscVscode,
  'vscode-insiders': VscVscodeInsiders,
  cursor: SiCursor,
  windsurf: SiWindsurf,
  unknown: VscWindow,
};

interface Props {
  readonly flavour: EditorFlavour;
  /**
   * The editor's display name, for the `<title>`.
   *
   * A prop and not a lookup, because a View may not call into the Model — see
   * `EditorMark` in `presenters.ts`, which is where it comes from.
   */
  readonly name: string;
}

export function EditorGlyph({ flavour, name }: Props) {
  const Mark = MARKS[flavour];

  return (
    <Mark
      // Two classes: one sizes and aligns every mark, one carries the tint for
      // this flavour. Both are in styles.css, per the note above.
      className={`editor-glyph editor-glyph-${flavour}`}
      size={13}
      // Renders a <title>, so the shape has a name in the accessibility tree
      // and on hover. The badge around it is labelled too — this is the inner
      // half, for the case where two marks sit in one badge.
      title={name}
      aria-hidden="true"
    />
  );
}
