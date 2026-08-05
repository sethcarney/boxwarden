/**
 * The renderer imports one stylesheet for its side effect, and Vite turns that
 * into a `<link>` at build time. TypeScript has no idea that happens.
 *
 * TypeScript 5 leaves such an import unchecked, so this file buys nothing
 * today. TypeScript 7 reports it — `error TS2882: Cannot find module or type
 * declarations for side-effect import of './styles.css'` — and that is the
 * only thing in this repo the native compiler rejects, so the declaration is
 * here now rather than tangled into the version bump later. A side-effect
 * import binds no name, which is why the body is empty: there is nothing to
 * give a type to.
 *
 * `vite/client` would also declare it, along with `import.meta.env`, the asset
 * query suffixes and a handful of DOM-adjacent globals. It is not referenced
 * here because tsconfig.web.json sets `"types": []` on purpose — the renderer
 * is Chromium with context isolation and everything it can reach arrives
 * through `window.boxwarden`. One `declare module` is the smaller answer, and
 * it does not quietly widen what the renderer is allowed to see.
 *
 * Add an arm here (and only here) if a component ever imports an image or a
 * `?raw` file; those DO bind a name, so they need `const src: string` rather
 * than an empty body.
 */
declare module '*.css';
