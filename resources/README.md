# resources/

electron-builder's `buildResources` directory — see `electron-builder.yml`.

Not the default `build/`, because `.gitignore` excludes that one and an icon
that is ignored locally goes missing from every clean checkout, with no symptom
beyond the app quietly wearing Electron's own logo.

## icon.png

1024×1024 RGBA, the source for every platform's icon: electron-builder derives
the `.icns` and `.ico` from it at build time. An isometric cube on a rounded
plate, in the app's own palette (`--bg`, `--accent` from
`src/renderer/styles.css`), with the area outside the plate transparent so
macOS and Linux launchers can mask it to their own shape.

Replacing it: any square PNG of 512px or more works. Keep the transparent
margin — a full-bleed square gets letterboxed inside macOS's rounded rect.
