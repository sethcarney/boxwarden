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
- **Open a terminal** in a running container, via `docker exec -it` in the
  user's own emulator, with a **Copy command** fallback. Twelve emulators
  across macOS, Linux and Windows, selected from the footer.
- A per-container **startup command**, run inside the container before the
  interactive shell. Persisted in `preferences.json` under the host folder, so a
  rebuild does not lose it.
- Recovers the **WSL distribution** from bind-mount sources, so a path inside a
  distro is not displayed as a native Linux path.
- A diagnostics screen naming every socket that was tried and why each failed.
- **Flags Claude Code sessions running inside a container**, so Stop and "Stop
  all" are not blind to an agent mid-task.
- **Finds dev container projects that have never been built** by walking the
  filesystem for `devcontainer.json`, listing the ones no container claims, and
  offering to open the folder so the editor can prompt "Reopen in Container".
  Scan roots are configurable through the OS folder picker and persisted.
- Polls every 5s; actions re-read from Docker rather than patching optimistically.

## Verified and unverified

Verified here: build, ESLint + Prettier, typecheck across both TS projects,
390 unit and component tests, and a headless launch under `xvfb` against
`BOXWARDEN_FAKE_DOCKER=1` — 7 cards in 1 compose group, group actions correct
for the members' states, WSL path resolved from mounts, ports and footer right.
That launch has since been repeated against a **packaged** Linux build, which
exercises the parts development mode does not: the asar archive, the sandboxed
preload loaded from inside it, and production CSP.

The terminal path was driven through the same harness with `xterm` installed:
the emulator was found and offered, the Terminal button was live only for the
running fixtures, a startup command written through the bridge landed in
`preferences.json` under the compose-aware key, and `openTerminal` spawned
xterm and returned the exec line — which round-tripped through a real `sh -c`
as eight intact argv elements. What that cannot prove is the far end.

**Not verified**, because the environment this was built in has no Docker
socket and no editor installed:

- Discovery against a real daemon.
- That the `vscode-remote://` URI actually reattaches VS Code.
- Editor binary resolution on any OS.
- That `docker exec` actually lands a shell in a container. There was no daemon
  behind the exec above.
- **The Windows emulators specifically.** `wt.exe new-tab`'s option parsing and
  its `\;` escape, and the `conhost.exe <command>` fallback, are both written
  from documentation rather than from a machine. They are the least trustworthy
  rows in `terminal/targets.ts`.
- The AppleScript for Terminal.app and iTerm2 — in particular that iTerm2 3.x
  really does want `create window with default profile command` and not
  `do script`.
- Claude Code detection against a real container. The parser is tested against
  fixture `top` responses in both engines' column layouts, but no daemon has
  returned a real one and no real `claude` process has been matched.
- **The update check against a real release.** There are none yet, so nothing
  has ever come back from `/releases/latest` — the parser, the version
  comparison and the per-platform asset match are tested against fixture
  payloads built from the artefact names in `releasing.md`. Two things can only
  be confirmed by publishing: that those names are exactly what electron-builder
  emits, and that `net.fetch` reaches api.github.com from a packaged app.
  `BOXWARDEN_FAKE_UPDATE=1` shows the banner without a release, which proves
  the UI and nothing about GitHub.

Those are the first thing to do on a real machine, and until they pass the app
should be considered unproven rather than working.

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
  `mdfind` path. The same resolver now finds terminal emulators, so a fix there
  is a fix for both.
- Open a terminal on each OS and confirm the shell lands in the container, the
  startup command runs before it, and interrupting a long-running startup
  command leaves an interactive shell rather than closing the window.

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

## 6. Packaging — signing, notarisation, updates

`electron-builder` is wired up (`electron-builder.yml`, `bun run dist`) and the
packaged Linux build has been verified to run: 7 fixture cards rendered out of
an asar with the sandboxed preload and IPC intact. dmg, AppImage, deb and NSIS
targets are configured, and the app has an icon.

Since then the **release process** is wired up too:
`.github/workflows/release.yml` turns a `v*` tag into all three platforms'
installers attached to a draft GitHub release, each built on the OS it targets
— see [releasing.md](./releasing.md). That closes the distribution half of
this item, and the "one Linux machine on one day" caveat below with it. What it
does not close is anything about _trusting_ the result.

What is still missing is everything about _trusting_ the result:

- **macOS signing and notarisation.** Locally, signing is left to
  electron-builder's keychain discovery, so a machine with a Developer ID
  produces a signed build and every other machine produces an unsigned one. In
  CI it is turned off explicitly (`CSC_IDENTITY_AUTO_DISCOVERY: false`), because
  a failed keychain search is a warning inside a green log and an unsigned
  release would look exactly like a signed one. Notarisation is not configured
  at all, so Gatekeeper blocks the dmg until the user strips the quarantine
  attribute by hand — documented in `running.md` and in the release notes
  boilerplate in `releasing.md`, which is not the same as fixed.
- **Windows signing.** Unsigned, so SmartScreen interposes.
- **ASAR integrity.** `asar: true` is on; the integrity fuse that would detect
  a tampered archive is not.
- **Auto-update.** boxwarden now **checks** — once a day, against
  `/releases/latest` — and tells the user what to download and how to install
  it for the platform and install kind they are on (`src/models/update.ts`,
  `src/main/update/`). What it does not do is install anything, and
  that half is blocked on the item above rather than on effort:
  `electron-updater` swaps the application in place and verifies a code
  signature to decide it is safe to, and there is no signature to verify.
  Squirrel.Mac refuses an unsigned swap outright; everywhere else it would
  replace a binary on the user's disk on the strength of an unverifiable
  download, which is worse than the manual install it replaces. Sign first,
  then wire it up — at which point `latest*.yml`, already attached to every
  release, is what it reads.
- **arm64 anything.** Every target builds both architectures and only the x64
  Linux build has ever been launched.

None of it is blocking for a tool you build yourself, and all of it is blocking
for one you hand to somebody else.

## 7. Claude Code presence — the follow-ups

Presence detection ships annotating the Stop button. Two things were
deliberately left out of v1, in this order:

- **Confirm before stopping a container with a live session.** The annotation
  is the honest v1 because this app has no modal today, and adding the first one
  should not ride along with a detection nobody has watched against a real
  daemon yet. Once it has been, the confirm is the point of the feature.
- **Activity, not just presence.** Working vs. idle vs. waiting on a permission
  prompt would mean parsing session transcripts under
  `~/.claude/projects/**/*.jsonl` or the IDE lock files under `~/.claude/ide/`,
  and locating the container's home directory first. Neither path is a versioned
  interface. It stays a separate item on purpose: presence is cheap and stable,
  activity is neither, and coupling them would put the stable half at the mercy
  of the other.

## 8. Smaller things

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
- **Building from boxwarden.** The unbuilt-projects panel offers to open a
  folder and to _copy_ `devcontainer up`; it does not run it. Doing so means
  streaming build output somewhere the user can watch it and read the
  `postCreateCommand` first — a real feature, not a button.
- **Unbuilt projects inside WSL.** `folderUri` emits `vscode-remote://wsl+…`
  correctly and the Windows defaults never scan into a distro, because walking
  `\\wsl.localhost\…` over 9P is slow. A user whose code lives in a distro has
  to add the root by hand. Enumerating running distros from `WslStatus` and
  offering them would be better.
- **Watching for new projects.** The scan runs on open and on demand. A repo
  cloned while the app is running does not appear until the user rescans.
- **A terminal for a compose project.** There is no "shell into every service",
  and it is not obvious there should be — a window per service is rarely what
  anyone wants.
- **A user-configured terminal.** `terminal/targets.ts` covers twelve
  emulators; anything else needs a table entry. An explicit-path override
  (`BOXWARDEN_TERMINAL`) would close that without a code change, and the
  discovery type already has an `explicit-path` arm for it.
- **Startup command history.** One command per container, overwritten in place.
  No previous values, no per-project defaults, and no way to edit one from rows
  layout — the field is hidden there because a text input does not fit on a
  single-line row.
- **App-level tests.** `App.tsx` — polling, the busy set, group fan-out — has
  no test of its own; the pieces it composes are covered individually.
- **Accessibility.** No keyboard shortcuts, no focus management, no screen
  reader pass.
- **Window state.** Size and position are not persisted.
- **CI on more than one OS.** `check.yml` runs the gate on every PR and on
  pushes to `main`, and `release.yml` builds all three platforms on a tag — but
  the gate itself only ever runs on Linux. The Windows-specific code
  (`docker/wsl.ts`, the `wt.exe` and `conhost.exe` rows in
  `terminal/targets.ts`) is untested anywhere, and a Windows runner in
  `check.yml` would at least prove it compiles and runs there. That is not the
  same as proving the probes are right, which needs a real machine.

## Done

Items completed since the first MVP pass, kept for the record:

- ~~Packaging~~ — electron-builder, four targets, an icon, and a verified
  packaged build. What remains of that item is signing, notarisation and
  updates, which is why it still has a section above.
- ~~A release process~~ — a `v*` tag builds macOS, Linux and Windows on their
  own runners and collects the installers into one draft release
  (`.github/workflows/release.yml`, `docs/releasing.md`). The version check
  that refuses a tag disagreeing with `package.json` is the load-bearing part:
  a published tag cannot be moved.
- ~~A guide to running it~~ — `running.md`, covering the dev container driven
  from the CLI (`bun run devcontainer:open`), development on the host, and
  installing a built app on each OS.
- ~~Renderer tests~~ — jsdom + Testing Library, covering the degraded row, the
  disabled Open button and its reason, the diagnostics panel, and compose groups.
- ~~Lint and format~~ — ESLint flat config with type-aware rules, Prettier, both
  in `bun run check`. This closed a real gap: the devcontainer configured both
  editor extensions and ran `source.fixAll.eslint` on save while neither tool
  was installed.
- ~~Compose grouping~~.
- ~~Copy the URI as a fallback~~ — now a labelled pair, so a failed terminal
  offers **Copy command** through the same slot.
- ~~Open a terminal in a container~~, with a per-container startup command.
  What remains of that item is confirming it against real daemons and real
  emulators, which is why it appears above under "Not verified".
