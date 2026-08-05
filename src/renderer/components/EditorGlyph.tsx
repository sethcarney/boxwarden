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
 * ## Why inline SVG and not an asset
 *
 * The renderer runs under a strict CSP with no remote origins, and the build
 * has no image pipeline configured (`assets.d.ts` declares only `*.css`, on
 * purpose). A `<path>` in a component needs neither, costs no request, and
 * inherits `currentColor` — which matters because the badge is themed and a
 * fixed-colour PNG would be invisible on one of the two palettes.
 *
 * ## The two shapes
 *
 * `vscode` and `vscode-insiders` share the VS Code ribbon mark, which is the
 * thing a user recognises without reading. They are told apart by colour, the
 * way the products are: Insiders ships the same mark in green.
 *
 * Cursor and Windsurf get a LETTERMARK rather than a guess at their logos.
 * Drawing an approximation of somebody's brand is worse than not drawing it —
 * an almost-right logo reads as a rendering bug — and a letter in a rounded
 * square is unambiguous about being boxwarden's own shorthand. If either
 * product's mark is ever added, it belongs here beside the other, not in the
 * badge.
 *
 * Every arm carries a `<title>`, so the icon has an accessible name even
 * though the badge around it also has one.
 *
 * NOTE ON THE MARK: the VS Code logo is Microsoft's trademark. It is used here
 * to identify Microsoft's product, which is what the mark is for — the same
 * reason a file manager shows an application's icon next to its files — and
 * boxwarden claims no affiliation. If that is ever unwelcome, this is the one
 * file to change: the badge takes a flavour and does not care what is drawn.
 */

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

/**
 * Brand colour per flavour, as a CSS VARIABLE and never a literal.
 *
 * The rule the stylesheet already keeps: a colour chosen against the dark
 * surface is the one that vanishes on the light one. The two VS Code flavours
 * are the only marks with a colour of their own — Insiders ships the same
 * shape in green, which is how its users already tell their two installs apart
 * in a dock — and both are darkened for the light palette in styles.css.
 *
 * Everything else takes `currentColor`, i.e. the badge's own per-theme dim
 * text. A lettermark does not need a brand colour to be read; it needs to be
 * legible on both palettes, which `currentColor` is by construction.
 */
const TINT: Readonly<Record<EditorFlavour, string>> = {
  vscode: 'var(--editor-vscode)',
  'vscode-insiders': 'var(--editor-insiders)',
  cursor: 'currentColor',
  windsurf: 'currentColor',
  unknown: 'currentColor',
};

export function EditorGlyph({ flavour, name }: Props) {
  const fill = TINT[flavour];

  if (flavour === 'vscode' || flavour === 'vscode-insiders') {
    return (
      <svg
        className="editor-glyph"
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill={fill}
        role="img"
        aria-hidden="true"
      >
        <title>{name}</title>
        <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
      </svg>
    );
  }

  if (flavour === 'cursor' || flavour === 'windsurf') {
    return (
      <svg
        className="editor-glyph"
        viewBox="0 0 24 24"
        width="13"
        height="13"
        role="img"
        aria-hidden="true"
      >
        <title>{name}</title>
        <rect x="1" y="1" width="22" height="22" rx="5" fill={fill} opacity="0.22" />
        <rect
          x="1"
          y="1"
          width="22"
          height="22"
          rx="5"
          fill="none"
          stroke={fill}
          strokeWidth="1.6"
        />
        <text
          x="12"
          y="17"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill={fill}
          fontFamily="inherit"
        >
          {flavour === 'cursor' ? 'C' : 'W'}
        </text>
      </svg>
    );
  }

  // An editor server we recognised as one without recognising which. A window
  // outline says "something is attached" without claiming a product.
  return (
    <svg
      className="editor-glyph"
      viewBox="0 0 24 24"
      width="13"
      height="13"
      role="img"
      aria-hidden="true"
    >
      <title>{name}</title>
      <rect
        x="2"
        y="4"
        width="20"
        height="16"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M2 9h20" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
