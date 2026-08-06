# resources/

electron-builder's `buildResources` directory — see `electron-builder.yml`.

Not the default `build/`, because `.gitignore` excludes that one and an icon
that is ignored locally goes missing from every clean checkout, with no symptom
beyond the app quietly wearing Electron's own logo.

## icon.png

1024×1024 RGBA, the source everything else is derived from. macOS and Windows
take it directly: electron-builder builds the `.icns` and the `.ico` from it at
build time, and both of those formats hold every size inside the one file.

An isometric cube on a rounded plate, in the app's own palette (`--bg`,
`--accent` from `src/renderer/styles.css`), with the area outside the plate
transparent so macOS and Linux launchers can mask it to their own shape.

Replacing it: any square PNG of 512px or more works. Keep the transparent
margin — a full-bleed square gets letterboxed inside macOS's rounded rect. Then
run `bun run icons:generate` and commit `icons/` alongside it; `bun run check`
fails until you do.

## icons/

The same artwork at eight sizes, committed rather than generated at build time,
because Linux has no `.icns` equivalent and the packaging is unforgiving in a
way that shows up as nothing at all.

A Linux desktop finds an app's icon by **name** — the installed `.desktop` entry
says `Icon=boxwarden`, not a path — and resolves that name by searching the size
subdirectories of `/usr/share/icons/hicolor/` **that hicolor's own `index.theme`
declares**. electron-builder passes a single PNG through without resizing, so
pointing `linux.icon` at the 1024px source installed exactly one file, into
`hicolor/1024x1024/`, a size `index.theme` does not list. Nothing errored: the
deb built, installed, and put a perfectly valid icon somewhere GTK never looks.
Linux Mint drew a generic gear in its menu while macOS and Windows were correct,
which is why it survived three releases.

So: every size here appears in `index.theme`, and none of them is 1024.
`scripts/icon-sizes.mjs` is the list, `bun run icons:generate` writes the files
(ImageMagick required, only for that), and `bun run check:icons` — part of
`bun run check`, so it runs in CI — fails if a size goes missing, stops matching
its own filename, loses its alpha channel, or falls out of date with
`icon.png`.

`256x256.png` does double duty: `extraResources` stages it beside the packaged
app as `resources/icon.png`, and `linuxWindowIcon()` in `src/main/index.ts`
hands it to `BrowserWindow` so the running window carries `_NET_WM_ICON` even
when there is no `.desktop` entry to match against — which is the case for an
AppImage run straight out of the downloads folder.

### manifest.json

Written by the generator, read by the check. It records the SHA-256 of the
`icon.png` the sizes were derived from, which is the only way to catch the one
failure the other checks cannot see: artwork replaced, sizes not regenerated.
The stale PNGs are still valid, still the right dimensions, and still show the
previous icon.
