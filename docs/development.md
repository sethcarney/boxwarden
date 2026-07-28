# Development

## Prerequisites

Node 22 and Bun. Both are provided by the dev container
(`.devcontainer/devcontainer.json`); on the host, match the versions pinned
there.

Bun is the package manager and script runner **only** — it is never the
runtime. Electron ships its own Node inside Chromium and executes main and
renderer code in *that* interpreter; `bun run dev` merely spawns the electron
binary. See the long comment in `devcontainer.json` for why this is not a
preference that can be revisited.

## Commands

```bash
bun install          # electron's postinstall downloads a ~100MB binary
bun run dev          # electron-vite dev server, HMR on the renderer
bun run dev:fake     # same, against fixtures instead of a real daemon
bun run build        # bundles main, preload, renderer into out/
bun run start        # preview the production build
bun run test         # vitest, no Docker or display required
bun run typecheck    # both halves — node and web configs
bun run check        # typecheck + test + devcontainer assertions
```

`trustedDependencies` in `package.json` lists `electron` and `esbuild` because
Bun blocks dependency lifecycle scripts by default, and Electron's postinstall
is what fetches its binary. Without it the install "succeeds" and the app then
refuses to launch.

## Working without Docker

```bash
BOXWARDEN_FAKE_DOCKER=1 bun run dev
```

This swaps `DockerodeBackend` for `FakeDockerBackend`, which serves six fixture
containers through the **real** `mapContainer`. The fixtures deliberately cover
the cases least likely to exist on your own machine and most likely to render
badly:

| Fixture | What it exercises |
| --- | --- |
| `webapp` | Running, healthy, one published and one unpublished port |
| `api-service` | Cleanly exited |
| `platform` | Compose-managed — the `compose` tag |
| `reporting-tool` | Windows host path, no `WorkingDir` → `/workspaces/<basename>` fallback |
| `legacy-thing` | Unparseable label → degraded row, exit code 137 |
| `infra-scripts` | Paused, WSL UNC path |

The main process logs a loud warning when this is on. A fake container list the
user believes is real is the worst possible failure for this app.

## Two TypeScript projects

The renderer has DOM and no Node; main and preload have the reverse. One config
cannot express that, so:

- `tsconfig.base.json` — strictness settings, shared
- `tsconfig.node.json` — `src/main`, `src/preload`, `src/domain`, `src/shared`
- `tsconfig.web.json` — `src/renderer`, plus the shared code
- `tsconfig.json` — solution file, references both

`exactOptionalPropertyTypes` is on, so an absent optional field must be an
*absent key*, not `undefined`. Hence the conditional spreads throughout
`mapping.ts` and `endpoint.ts`:

```ts
...(health === undefined ? {} : { health }),
```

## Testing

`vitest run`. The suite covers the pure layer only — label parsing, inspect
mapping, URI construction, endpoint ordering, display formatting — so it needs
neither a daemon nor a display and runs anywhere.

Functions that would otherwise read the clock take `now` as a parameter
(`relativeTime`, `statusLabel`), and platform-dependent functions take
`platform`/`homedir` as parameters (`candidateEndpoints`). Both are so that
tests assert on fixed values instead of freezing globals.

There is no test for the React components yet — see [roadmap](./roadmap.md).

## Verifying the UI headlessly

The app was smoke-tested in CI-like conditions with `xvfb-run` plus a
screenshot capture. Two gotchas if you repeat it:

- `app.enableSandbox()` means `--no-sandbox` is refused, so the app **cannot
  run as root**. Run as an unprivileged user and ensure
  `node_modules/electron/dist/chrome-sandbox` is `root:root` mode `4755`.
- Electron needs a D-Bus session for some subsystems; the errors it logs
  without one are noise, not failures.

## Before committing

```bash
bun run check
```
