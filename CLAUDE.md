# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

boxwarden is an Electron desktop app (early MVP) that lists dev containers on
the local machine — filtered to those carrying the `devcontainer.local_folder`
label — and reattaches an editor (VS Code, Insiders, Cursor, Windsurf) to
them. It also groups Docker Compose projects, starts/stops containers
individually or per project, and scans the filesystem for dev container
projects that have never been built.

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
  docker/    endpoint discovery, dockerode, inspect→domain
  editor/    binary resolution, URI building, spawn
  projects/  filesystem walk for unbuilt dev containers

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
| `projects/scan.ts` (fs walk)   | `domain/project.ts`                        |

Preserve this split when adding features — it's why the suite tests without a
Docker daemon or a display, and why the shells stay small.

**The IPC surface is ten narrow verbs** — see `src/shared/ipc.ts` — all
declared as a `BoxwardenApi` interface consumed by the renderer without
importing Electron. They fall into two groups by cadence:

- **Docker, polled every 5s**: `discover`, `start`, `stop`, `listEditors`,
  `openInEditor`, `selectEngine`.
- **Filesystem, on demand only**: `scanProjects`, `openProject`,
  `addProjectRoot`, `removeProjectRoot`.

Prefer looping over the existing verbs (e.g. `Promise.allSettled` for a compose
group's "Start all") over adding new channels. The two exceptions so far both
earned it: `selectEngine` changes main-process state that outlives the call, and
the project verbs are a _different cadence_ — folding `scanProjects` into
`DiscoverySnapshot` would make the 5s poll pay for a filesystem walk sixty times
an hour. Lifecycle actions return failure as `{ ok: false, message }` data
rather than throwing — a thrown main-process error crosses IPC as an opaque
string with the real message buried.

`addProjectRoot` takes **no argument** on purpose: the renderer can ask for the
folder picker, and cannot say which folder the answer is.

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

### Engine selection

Every engine that answers is connected to and their container lists are
unioned (deduplicated by container id). `EngineSelection` in
`src/domain/engine.ts` narrows that to one engine; the picker appears in the
header once two are reachable.

- `EngineId` is **derived from the transport** (`unix:/var/run/docker.sock`,
  `wsl:dev:/run/podman.sock`), kept separate from the prose
  `describeTransport` because it is written to the preferences file — a
  reworded UI must not reset everyone's choice.
- The selection lives on the **backend**, so start/stop agree with the list.
- `probe()` still tries **every** candidate whatever the selection: the picker
  can only offer engines that were tried.
- A selection whose engine has gone away yields an **empty list**, never a
  silent fall back — `adviseEnvironment` emits `selected-engine-unreachable`.

Persisted by `src/main/preferences.ts` and applied before the window opens.

### Setup advice

`src/domain/advice.ts` is a pure function from `DockerEnvironment` to
`Advice[]` (title, body, copyable commands, doc links), computed in the main
process at discover time and shipped in the snapshot. It covers missing WSL, a
WSL distro without socat, nothing installed (per-platform install menu),
`EACCES` on a socket, a socket that refuses, and an engine too old.

Two rules when adding to it:

- **Every advisory names what is wrong AND what to type.** One that only
  describes the problem belongs in the diagnostics list instead.
- **A link's origin must also be added to `ALLOWED_EXTERNAL_ORIGINS`** in
  `src/main/index.ts`, which is a closed set on purpose. A link added without
  it renders and silently does nothing.

Commands are shown, never run — they reboot machines and use `sudo`.

### WSL on Windows

`DockerEnvironment.wsl` carries a `WslStatus` (`not-installed` → `no-distros`
→ `none-running` → `ready`, plus per-distro socat/podman/socket facts) because
on Windows WSL _is_ the setup: Linux containers need a Linux kernel and every
mainstream engine runs inside WSL2. The nastiest case it exists for is a distro
with an engine and no socat — 9P cannot carry unix sockets, so those containers
are invisible and the list looks complete while being short. That advisory
shows even when another engine is working.

### Unbuilt projects

`src/domain/project.ts` (pure) plus `src/main/projects/scan.ts` (the walk) find
`devcontainer.json` files on disk, so "no dev containers found" is not the end
of the story on a machine where nothing has been built yet.

- **A project's id is its config path, not its folder.**
  `.devcontainer/<variant>/devcontainer.json` is the spec's way of shipping more
  than one dev container per repo; keying on the folder drops all but the first.
- **`devcontainer.json` is JSONC.** `stripJsonc` is a character scan, not a
  regex, because every image reference with a registry host in it contains `//`
  inside a string. Don't "simplify" it.
- **The walk is bounded three ways** — depth 3, 10s, 250 results — and a scan
  that hit a limit sets `truncated`, which the UI shows. Never report a short
  list as a complete one.
- **`comparableFolder` normalises paths; `authorityFor` must not.** Matching a
  project against a container's label folds case and separators on Windows. That
  is safe only because nothing is launched from the result — see the raw label
  rule above.
- **Roots** default to `$HOME` (+ `/workspaces` on Linux) and are persisted in
  `preferences.json`. `undefined` means "use the defaults"; `[]` means "the user
  removed them all" — `parseProjectRoots` keeps those distinct on purpose.
- **`devcontainer up` is copied, never run** — same rule as the setup advice, and
  a stronger case: it pulls images and executes `postCreateCommand` from the
  repo.

### Compose grouping

`src/renderer/grouping.ts` folds the flat container list into `ContainerGroup`
(`single` | `compose`) so a workspace + its database render as one framed
group. Known gap: grouping only sees containers carrying
`devcontainer.local_folder`, so an unlabeled compose sibling is invisible to
"Stop all" (see `docs/roadmap.md`).

### Layout and theme

Three layouts (`grid` — the default, `list`, `rows`) and three themes (`dark`,
`light`, `auto`), typed and parsed in `src/renderer/view.ts`.

- **The layout is an attribute, not a component fork**: `data-layout` on the
  list element selects grid tracks in `styles.css`; the cards are the same
  markup in all three. `ContainerCard`'s `dense` prop is the only exception,
  and it only ever shortens a label — the full text stays in the `title`.
- **Persisted in `localStorage`, not `preferences.ts`.** The engine selection
  lives in the preferences file because the main process must apply it before
  the window opens; a view preference is read only by the renderer, so putting
  it there would buy a seventh IPC verb nothing.
- `auto` is resolved in the renderer (`resolveTheme`) so the light palette is
  written once and `data-theme` always names a concrete theme.
- **Colours go through variables, including the incidental ones.** The rules
  that broke first when a light theme arrived were the inline
  `rgba(255,255,255,…)` glazes — a white wash is invisible on a white surface.

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

- `vitest run` covers the pure layer (label parsing, inspect mapping, URI
  construction, endpoint ordering, display formatting) — no daemon, no display,
  runs anywhere. The one impure exception is `projects/scan.test.ts`, which
  builds a tree under `mkdtemp` and tears it down: the rule is "no daemon and no
  display", not "no filesystem", and a directory walk's bugs show up nowhere
  else.
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
