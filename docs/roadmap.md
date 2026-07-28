# Roadmap

What the MVP does, what it does not, and what to build next. Ordered by what
unblocks the most.

## What works today

- Discovers dev containers on the local daemon by the
  `devcontainer.local_folder` label.
- Lists them with project name, host path, image, state, health, and published
  vs. exposed-only ports. Running first, then alphabetical.
- **Groups compose projects** and offers Start all / Stop all, so stopping a
  workspace no longer leaves its database running.
- Start and stop, individually or per project.
- Open in VS Code / Insiders / Cursor / Windsurf via `vscode-remote://`, with a
  **Copy URI** fallback when launching fails.
- Recovers the **WSL distribution** from bind-mount sources, so a path inside a
  distro is not displayed as a native Linux path.
- A diagnostics screen naming every socket that was tried and why each failed.
- Polls every 5s; actions re-read from Docker rather than patching optimistically.

## Verified and unverified

Verified here: build, ESLint + Prettier, typecheck across both TS projects,
112 unit and component tests, and a headless launch under `xvfb` against
`BOXWARDEN_FAKE_DOCKER=1` — 7 cards in 1 compose group, group actions correct
for the members' states, WSL path resolved from mounts, ports and footer right.

**Not verified**, because the environment this was built in has no Docker
socket and no editor installed:

- Discovery against a real daemon.
- That the `vscode-remote://` URI actually reattaches VS Code.
- Editor binary resolution on any OS.

Those three are the first thing to do on a real machine, and until they pass
the app should be considered unproven rather than working.

---

## 1. Prove the real paths (highest priority)

- Run against a real daemon on macOS, Linux, and Windows. Confirm the label
  filter, the state mapping, and start/stop.
- Confirm the URI reattaches rather than offering to build a new container.
  The risk called out in `uri.ts` — that VS Code normalises the path before
  hex-encoding it, especially the Windows drive-letter case — is real and
  untested. If it does normalise, `authorityFor` needs to match that
  normalisation exactly, and the test in `uri.test.ts` inverts.
- Confirm `code` resolution via each strategy, especially the macOS
  `mdfind` path.

## 2. Verify the forks

`EditorTarget.remoteScheme` and `folderUriFlag` are configurable purely as
insurance: every VS Code fork is _expected_ to use `vscode-remote` and
`--folder-uri`, but Cursor and Windsurf have not been checked against a real
install. Confirm empirically. **If neither diverges, delete both fields** —
they are speculative generality until proven otherwise.

## 3. WSL host paths — strategies 2 and 3

Strategy 1 (bind-mount sources) is **done**: Docker Desktop's WSL2 backend
rewrites mount sources through
`.../docker-desktop-bind-mounts/<Distro>/<hash>`, and
`wslDistroFromMountSources` reads the distro out of that. A native Linux daemon
never produces that shape, so a no-match means "leave it alone" rather than
"it is native".

Still missing, for the cases that heuristic does not cover (a non-Docker-Desktop
WSL setup, or a mount that has been staged differently):

1. Match against `wsl -l -q`.
2. Prompt once and cache.

When every strategy fails the path stays `posix`, never a guess. Note the blast
radius is display only — the editor URI is built from the raw label, so a wrong
guess is visible but harmless.

## 4. Replace polling with an event stream

The 5s poll is fine for a handful of containers and wasteful for a daemon with
hundreds. Docker's `/events` endpoint (`docker.getEvents()`) gives
start/stop/die/destroy pushes. Keep a slow poll as a reconciliation backstop —
event streams drop.

Deliberately not attempted yet: it cannot be verified without a real daemon,
and unverifiable complexity in the discovery path is the last thing this needs.

## 5. Rebuild and create

Needs `@devcontainers/cli`, which shells out to the `docker` binary. This is
exactly why `DockerEnvironment` probes the API and the CLI **separately** —
`api.ok` gates today's features, `cli.ok` gates these. The diagnostics panel
already reports CLI absence.

## 6. Packaging

`electron-builder` is not wired up; there is no distributable. Needs ASAR
integrity, code signing and notarisation on macOS, and an auto-update story or
an explicit decision not to have one.

## 7. Smaller things

- **Attached containers.** Containers attached to rather than created by the
  extension use a different authority (`attached-container+<hex of JSON>`).
  Not handled.
- **Remote daemons.** `DockerTransport` models tcp and ssh and `parseDockerHost`
  parses them, but the host paths on a remote daemon belong to the remote
  machine — the editor URI would point at folders that do not exist locally.
  Either detect and disable opening, or say what it means.
- **`docker context`.** Only `DOCKER_HOST` and well-known sockets are read.
  Users who switch contexts with `docker context use` are not followed.
- **Compose siblings without the devcontainer label.** Grouping only sees
  containers carrying `devcontainer.local_folder`. A compose project whose
  database service lacks that label will not appear in the group, so "Stop all"
  will miss it. Fixing this means a second query filtered on
  `com.docker.compose.project` for projects already known.
- **App-level tests.** `App.tsx` — polling, the busy set, group fan-out — has
  no test of its own; the pieces it composes are covered individually.
- **Accessibility.** No keyboard shortcuts, no focus management, no screen
  reader pass.
- **Window state.** Size and position are not persisted.
- **CI.** No workflow runs any of this on push.

## Done

Items completed since the first MVP pass, kept for the record:

- ~~Renderer tests~~ — jsdom + Testing Library, covering the degraded row, the
  disabled Open button and its reason, the diagnostics panel, and compose groups.
- ~~Lint and format~~ — ESLint flat config with type-aware rules, Prettier, both
  in `bun run check`. This closed a real gap: the devcontainer configured both
  editor extensions and ran `source.fixAll.eslint` on save while neither tool
  was installed.
- ~~Compose grouping~~.
- ~~Copy the URI as a fallback~~.
