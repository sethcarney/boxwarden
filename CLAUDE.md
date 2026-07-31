# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

boxwarden is an Electron desktop app (early MVP) that lists dev containers on
the local machine — filtered to those carrying the `devcontainer.local_folder`
label — and reattaches an editor (VS Code, Insiders, Cursor, Windsurf) to
them. It also groups Docker Compose projects and starts/stops containers
individually or per project.

Bun is the package manager and script runner **only**, never the runtime —
Electron ships its own Node and executes main/renderer code there. `bun run
dev` just spawns the electron binary.

## Commands

```bash
bun install          # electron's postinstall fetches a ~100MB binary
bun run dev          # electron-vite dev server, HMR on the renderer
bun run dev:fake     # same, against fixtures (BOXWARDEN_FAKE_DOCKER=1) instead of a real daemon
bun run build        # bundles main, preload, renderer into out/
bun run start        # preview the production build
bun run test         # vitest run — pure layer only, no Docker/display needed
bun run test:watch
bun run typecheck    # tsc over both TS projects (node config, then web config)
bun run lint         # eslint, type-aware
bun run format       # prettier --write
bun run check        # typecheck + lint + format:check + test + check:devcontainer — run before committing

bun run package      # build + electron-builder --dir: unpacked app, no installer
bun run dist         # build + installers for the host OS, into release/
bun run dist:mac / dist:linux / dist:win

bun run devcontainer:open   # devcontainer up, then attach an editor to it (scripts/devcontainer-open.mjs)
```

Run a single test file: `bunx vitest run src/main/docker/mapping.test.ts`.

## Architecture

Three Electron processes, plus two dependency-free layers shared across them:

```
renderer (Chromium, sandboxed, no Node)   src/renderer/  — React UI, reaches only window.boxwarden
        │ contextBridge, structured clone
preload (no logic)                        src/preload/   — ipcRenderer.invoke wrappers only
        │ ipcMain.handle
main (Node)                               src/main/
  docker/   endpoint discovery, dockerode, inspect→domain
  editor/   binary resolution, URI building, spawn

src/domain/   pure types, no I/O — shared by all three
src/shared/   the IPC contract (src/shared/ipc.ts) — shared by all three
```

**The layering rule**: `src/domain/` holds only types and pure functions and
imports nothing. Anything that touches the outside world lives in `src/main/`
as a thin shell around a pure core:

| Impure edge                    | Pure core it wraps                         |
| ------------------------------ | ------------------------------------------ |
| `docker/client.ts` (dockerode) | `docker/mapping.ts`, `docker/host-path.ts` |
| `docker/client.ts` (probing)   | `docker/endpoint.ts`                       |
| `editor/launch.ts` (spawn)     | `editor/uri.ts`                            |
| `editor/resolve.ts` (fs, exec) | `editor/targets.ts` (data)                 |

Preserve this split when adding features — it's why the suite tests without a
Docker daemon or a display, and why the shells stay small.

**The IPC surface is five narrow verbs** (`discover`, `start`, `stop`,
`listEditors`, `openInEditor` — see `src/shared/ipc.ts`), all declared as a
`BoxwardenApi` interface consumed by the renderer without importing Electron.
Prefer looping over the existing verbs (e.g. `Promise.allSettled` for a
compose group's "Start all") over adding new channels. Lifecycle actions
return failure as `{ ok: false, message }` data rather than throwing — a
thrown main-process error crosses IPC as an opaque string with the real
message buried.

### Two path spaces — the most error-prone part of this app

- **Host paths** — what the developer's OS sees. `HostPath` in the domain,
  with `posix` / `windows` / `wsl` arms.
- **Container paths** — what's inside the container. `ContainerPath`, a
  branded string.

The editor URI is `vscode-remote://dev-container+<hex of host path>/<container path>`.
As bare strings the two are interchangeable and a swap only misfires on
someone else's OS; the branded types make it a compile error instead.

**The raw label rule**: `devcontainer.local_folder` is parsed into a
`MaybeHostPath` _for display only_. The editor URI is always built from the
**raw label string, byte for byte** (`src/main/editor/uri.ts`) — the Dev
Containers extension only reattaches if the URI decodes to the exact string it
originally hex-encoded. Normalizing slashes, trimming, or case-folding a drive
letter produces a valid-looking URI pointing at a container that doesn't
exist, so VS Code offers to build a new one instead of reattaching. The
`does not normalise the host path` test in `uri.test.ts` pins this — don't
"fix" `authorityFor` to normalize.

### Discovery

1. Build ordered candidate sockets (`endpoint.ts`): `DOCKER_HOST` first, then
   well-known sockets for Docker Desktop, OrbStack, Colima, Rancher Desktop,
   rootless Docker, Podman.
2. Probe each with `docker.version()`. Every attempt is kept (not just the
   winner) — `DockerEnvironment.attempts` **is** the diagnostics UI that names
   which socket failed and why, instead of a bare "couldn't connect".
3. `listContainers` filtered server-side on `devcontainer.local_folder`.
4. `inspect` each hit (list summary lacks `StartedAt`/`ExitCode`/`Health`).
5. Map to `DevContainer` via the pure `mapContainer`.

A container whose label can't be parsed is still shown — greyed, dashed
border, with the raw label and the reason — never silently dropped.

### Compose grouping

`src/renderer/grouping.ts` folds the flat container list into `ContainerGroup`
(`single` | `compose`) so a workspace + its database render as one framed
group. Known gap: grouping only sees containers carrying
`devcontainer.local_folder`, so an unlabeled compose sibling is invisible to
"Stop all" (see `docs/roadmap.md`).

### Electron security posture

`src/main/index.ts` centralizes the hardening: sandboxed + context-isolated
renderer, CSP, permission handlers that deny everything except
`clipboard-sanitized-write`, blocked navigation/new-windows, and
`shell.openExternal` restricted to a four-origin allow-list. Two invariants to
preserve when touching this code:

- **Sender validation is object identity, not URL matching**:
  `isTrustedSender: (contents) => contents === mainWindow?.webContents`. This
  is also why `openInEditor` takes a container **id**, not a `DevContainer` —
  the main process looks up its own copy rather than trusting a renderer-
  supplied host path.
- **Editor launch never goes through a shell**: `src/main/editor/launch.ts`
  uses `spawn` with an argv array, never `shell: true`. The URI embeds a
  hex-encoded host path that originates from a container label (i.e.
  attacker-influenced by anyone who can create containers on the daemon).

Full checklist and rationale: `docs/electron-security.md`. Read it before
changing `webPreferences`, adding an IPC channel, or loading new content into
the window.

## TypeScript / lint conventions

Two separate `tsconfig`s because the renderer has DOM and no Node, and
main/preload have the reverse — one config can't express both:

- `tsconfig.base.json` — shared strictness
- `tsconfig.node.json` — `src/main`, `src/preload`, `src/domain`, `src/shared`
- `tsconfig.web.json` — `src/renderer`, plus shared code

`exactOptionalPropertyTypes` is on: an absent optional field must be an
_absent key_, not `undefined`. Use conditional spreads:
`...(health === undefined ? {} : { health })`.

ESLint (`eslint.config.js`) uses type-aware rules (`strictTypeChecked` +
`stylisticTypeChecked`), split by environment the same way the tsconfigs are.
`no-floating-promises`/`no-misused-promises` are the ones that matter most in
an app that's mostly async I/O — use `void somePromise()` for deliberate
fire-and-forget. Test files relax `no-unsafe-argument`,
`no-unnecessary-condition`, and `no-unnecessary-type-assertion` because
fixtures deliberately construct malformed inputs.

## Testing conventions

- `vitest run` covers only the pure layer (label parsing, inspect mapping,
  URI construction, endpoint ordering, display formatting) — no daemon, no
  display, runs anywhere.
- Functions that would read the clock take `now` as a parameter
  (`relativeTime`, `statusLabel`); platform-dependent functions take
  `platform`/`homedir` as parameters (`candidateEndpoints`) — this is how
  tests assert fixed values instead of freezing globals. Follow the same
  pattern for new code that needs the clock or platform.
- Component tests opt into jsdom **per file** with `// @vitest-environment
jsdom` (not a glob) — jsdom costs ~1s of setup and a glob would triple
  suite time for non-component tests.
- `src/renderer/test-fixtures.ts` builds `DevContainer` values directly rather
  than running `mapContainer` (which lives in `src/main`, outside the
  renderer's tsconfig) — don't reach across that boundary in renderer tests.

## Working without Docker

```bash
BOXWARDEN_FAKE_DOCKER=1 bun run dev    # or: bun run dev:fake
```

Swaps in `FakeDockerBackend`, serving six fixture containers through the
**real** `mapContainer` (see the fixture table in `docs/development.md` for
what each one exercises — Windows paths, compose, unparseable labels, WSL,
etc.). The main process logs a loud warning when this is active; never let a
fake container list be mistaken for a real one.

## Working in the repo's own dev container

`bun run devcontainer:open` (`scripts/devcontainer-open.mjs`) builds/starts
the container via `devcontainer up`, then attaches an editor via
`code --folder-uri vscode-remote://dev-container+<hex>/<remoteWorkspaceFolder>`.
It uses docker-outside-of-docker, so boxwarden running inside it talks to the
**host's** daemon and sees the developer's real containers — but two things
don't work from inside it:

- **The Electron GUI** (no X11/Wayland forwarding).
- **Opening an editor** — `editor/resolve.ts` looks for `code` on the
  container's PATH, not the host's.

So: checks and main-process/Docker work happen in the container; GUI and
editor-launch work happen on the host. On rootless Podman hosts, the socket
path needs `BOXWARDEN_DOCKER_SOCKET` — see
`docs/development.md#podman-and-rootless-docker-hosts` for the full
troubleshooting path (this is a common source of confusing dev-container
startup failures).

## Docs

- `docs/architecture.md` — process model, path spaces, discovery, grouping (fuller version of the above)
- `docs/development.md` — Podman/rootless setup, fixtures, testing/lint rationale
- `docs/electron-security.md` — full security checklist and rationale
- `docs/running.md` — the three ways to run the app, troubleshooting table
- `docs/roadmap.md` — what's unverified (no real Docker daemon or editor has touched this yet) and what's next

The README's status line matters: discovery/start-stop/open-in-editor are
unit-tested and UI-verified against fixtures, but **not yet verified against a
real Docker daemon or a real editor install**.
