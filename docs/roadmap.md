# Roadmap

What the app does, what it does not, and what to build next. Ordered by what
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
- **Says which editor is already attached**, from the same process-table read, in
  that editor's own mark — and turns Open into **Focus** plus a quieter **New
  window** while a window is up.
- **Closes that window when you press Stop**, before the container goes, so the
  editor is not left offering to reload something that no longer exists.
- **Connects to every engine that answers** and merges their lists, with a
  header picker once two are reachable and the choice persisted; plus a setup
  screen carrying every advisory and every socket tried.
- **Reports SSH agent forwarding** per container, including the case a user
  cannot diagnose alone: the variable is set and the socket is not mounted.
- **Checks GitHub once a day for a newer release** and names the exact artefact
  for the platform and install kind it is running as, with the steps to install
  it. Dismissable per version, and switchable off entirely.
- Three layouts and three themes, persisted.
- **Shows the branch each workspace folder is on**, read from `.git/HEAD` on the
  host — worktrees included — so several containers over one repository are
  told apart at a glance.
- **Switches that branch from the chip**, listing the repository's local
  branches and running `git checkout` on the host. Refuses — with the reason on
  screen — on a dirty tree, on a branch another worktree holds, and on the one
  already checked out. It never stashes, forces or discards.
- **Colours the card by state**, so a grid says what is running without being
  read: a status-keyed accent down the card's edge and a tinted status line,
  both from the same three-way `displayStatus` the dot uses.
- **Finds dev container projects that have never been built** by walking the
  filesystem for `devcontainer.json`, listing the ones no container claims, and
  offering to open the folder so the editor can prompt "Reopen in Container".
  Scan roots are configurable through the OS folder picker and persisted.
- Polls every 5s; actions re-read from Docker rather than patching optimistically.

## What has been verified

**On every push**, by `bun run check` and `bun run build`: typecheck across both
TS projects, ESLint, Prettier, **843 unit and component tests** across 52 files,
the devcontainer mount assertions and the Linux icon set. Separately, a headless
launch under `xvfb` against `BOXWARDEN_FAKE_DOCKER=1`, repeated against a
**packaged** build — which exercises what development mode does not: the asar
archive, the sandboxed preload loaded from inside it, and production CSP.

**By hand, on real machines — macOS, Linux and Windows**, against real container
engines, real editor installs and real terminal emulators. That covers the
things this document spent its first several revisions listing as unproven:

- Discovery against a real daemon: the label filter, the state mapping, start
  and stop.
- That the `vscode-remote://` URI **reattaches** rather than offering to build a
  new container — the risk called out in `uri.ts`, that VS Code might normalise
  the path before hex-encoding it and so disagree with the raw label. It does
  not, on any of the three, the Windows drive-letter case included — so
  `authorityFor` stays as it is, and the test in `uri.test.ts` that pins it now
  records observed behaviour rather than an assumption.
- Editor binary resolution, and the Cursor and Windsurf forks against real
  installs.
- `docker exec` landing an interactive shell in the container, as the container's
  `remoteUser` and in its workspace folder, with the startup command running
  first — in real emulators on all three platforms, `wt.exe` and the AppleScript
  pair included.
- Claude Code presence and attached-editor detection against real process
  tables, in both engines' column layouts.
- The branch chips against real checkouts, worktrees included.
- The daily update check: a packaged build reaching `/releases/latest` through
  `net.fetch`, comparing versions, and naming the right artefact for the platform
  and install kind it is running as. Which also confirmed the other half of that
  bet — that the filenames in `releasing.md` are exactly what electron-builder
  emits.

**What this branch adds is newer than that pass** and has not been through it:

- **Closing an editor window on a real desktop.** The matcher is a pure function
  with example and property tests over real title strings, but
  `src/main/window/` spawns `powershell.exe`, `osascript` and `wmctrl` and has
  no test of its own, for the reason `docker/client.ts` does not. Four things
  only a real run can settle, one per platform and one shared:

  - That a VS Code dev container window's title really is
    `<file> - <workspace> [Dev Container: <name>] - Visual Studio Code` on each
    platform, and that the workspace segment is the CONTAINER-side folder name
    rather than the host one. Both are in `editorWindowCriteria`, which carries
    the two spellings precisely because this is unverified.
  - That System Events reports VS Code's process as `Code`, Insiders as
    `Code - Insiders`, and the forks under their own names — the macOS
    enumerator narrows by that list before it reads, so a wrong name there is a
    silent no-match rather than an error.
  - That `EnumWindows` + `WM_CLOSE` closes one VS Code window on Windows and not
    the application, and that the PowerShell helper's `Add-Type` block compiles
    on a stock Windows PowerShell 5.1 rather than only on PowerShell 7.
  - That an unsaved buffer really does hold the window open long enough for the
    six-second settle to see it — which is the whole basis of the `still-open`
    refusal. If VS Code closes and reopens a prompt instead, that arm never
    fires and the container stops under the dialog.

  Wayland is not on this list because it is not unverified, it is impossible:
  the protocol gives a client no way to act on another client's surfaces. That
  arm reports the reason and Stop degrades to what it did before this feature.

- **Branch switching against a real repository.** The parsers are tested against
  fixture `for-each-ref` and `status --porcelain` output and the refusals against
  the real `canSwitchTo`, but `src/main/git/branches.ts` spawns `git` and has no
  test of its own, for the same reason `docker/client.ts` does not. Two things
  only a real run can settle: that `%(worktreepath)` is available on the git the
  user has (it needs 2.23), and that `wsl.exe -d <distro> --exec git` resolves
  git inside the distro.

  One thing a real run already settled, and it is folded in: Windows git against
  a `\\wsl.localhost\…` workspace refuses it as dubiously owned, because the
  files belong to the Linux user rather than to the Windows account.
  `gitInvocation` routes a WSL workspace through the distro's own git instead.

- **Cursor's `dev-container` authority end to end.** Cursor resolves it — a real
  install gets past the URI and into container setup, which is what proves the
  spec is right. What has not been seen through is a completed attach; the run
  that got that far stopped on the machine's own `spawn podman ENOENT`, which is
  Cursor's container CLI configuration and not this app's.

**Three further things remain unverified**, and all three are about trusting a
build somebody else made rather than about the app working:

- **arm64 on any platform.** Every release packages both architectures; only the
  x64 builds have ever been launched.
- **Code signing and notarisation.** Not configured, so every platform
  interposes on first launch — item 5 below.
- **ASAR integrity.** `asar: true` is on; the fuse that would detect a tampered
  archive is not.

---

## 1. Delete the fork insurance, or keep it on purpose

`EditorTarget.remoteScheme` and `folderUriFlag` exist purely as insurance:
every VS Code fork is _expected_ to use `vscode-remote` and `--folder-uri`, and
Cursor and Windsurf now demonstrably do. So the fields are two levels of
indirection carrying one value each.

The instruction this section used to give itself was **delete both if neither
diverges**, and that condition is now met. It is still listed rather than done
because deleting them is a small, deliberate change to a launch path that is
currently working on three platforms, and it wants its own commit rather than a
drive-by.

**But do not read that as "the forks agree".** They do not, and the divergence
was simply somewhere neither field was looking: the `dev-container` authority's
SPEC. VS Code hex-encodes the `devcontainer.local_folder` label; Cursor
hex-encodes a JSON blob naming the workspace and its `devcontainer.json`. That
is what `EditorTarget.devContainerSpec` now carries, and it is a field added
because a fork demonstrably diverges rather than in case one might — which is
the opposite of the two above and the reason it should outlive them.

The lesson worth keeping when these two are deleted: the insurance was bought
against the wrong risk. A fork changing the scheme or the flag would have
failed loudly; changing the spec fails SILENTLY, because an authority the
editor cannot resolve just opens a default window.

## 2. WSL host paths — strategies 2 and 3

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

## 3. Replace polling with an event stream

The 5s poll is fine for a handful of containers and wasteful for a daemon with
hundreds. Docker's `/events` endpoint (`docker.getEvents()`) gives
start/stop/die/destroy pushes. Keep a slow poll as a reconciliation backstop —
event streams drop.

The reason this was deferred — that it could not be verified without a real
daemon — no longer holds, so what is left is the work itself. The hazard to
respect is that an event stream is a second source of truth in the discovery
path: reconnection, missed events while the machine was asleep, and an engine
that goes away mid-stream all have to end up in the same place the poll would
have put them.

## 4. Rebuild and create

Needs `@devcontainers/cli`, which shells out to the `docker` binary. This is
exactly why `DockerEnvironment` probes the API and the CLI **separately** —
`api.ok` gates today's features, `cli.ok` gates these. The diagnostics panel
already reports CLI absence.

## 5. Packaging — signing, notarisation, updates

The distribution half of this item is **closed**. `electron-builder.yml`
configures dmg, AppImage, deb and NSIS with a real icon set;
`.github/workflows/release.yml` turns a `v*` tag into all three platforms'
installers attached to a draft GitHub release, each built on the OS it targets
(see [releasing.md](./releasing.md)); releases have been cut from it; and the
installers it produces have been installed and run on macOS, Windows and Linux.

What it does not close is anything about _trusting_ the result — which is the
whole of what is left here, and the reason the app is still `0.x`:

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
- **Auto-update.** boxwarden **checks** once a day against `/releases/latest`
  and links to the artefact for the machine it is on. It does not download it
  and does not install it.

  It did both for one release. The download verified SHA-256 against
  `sha256sums.txt` and the cosign bundle against a TUF-fetched Sigstore trust
  root, and it was removed — not because it was broken in principle, but because
  the app cannot swap its own bundle without a code signature, so the download
  ended at the same installer the link ends at while adding a hard dependency on
  Sigstore's CDN being reachable. On a network that blocked it, the app refused
  to install and said so in words indistinguishable from "this release is
  forged". See `docs/development.md#why-there-is-no-in-app-download`.

  A real auto-update is blocked on the signing item above rather than on effort:
  with a certificate, `electron-updater` does the download, the verification and
  the swap as one thing, and none of the removed code would come back.

  **The AppImage would be the easiest exception to make**, if in-place update
  ever comes back for Linux alone: it is a single file the user owns, so
  replacing it through a same-directory rename IS the install, with no installer
  to hand off to and no package manager to offend.

  When there IS a certificate, the remaining work is macOS and Windows in-place
  swaps, at which point `latest*.yml` — already attached to every release — is
  what `electron-updater` would read.

- **arm64 anything.** Every target builds both architectures, and only the x64
  builds have ever been launched — on all three platforms now, which is what
  makes this the narrow remaining gap rather than the wide one it was. The
  Apple Silicon dmg is the one that matters most, since it is the default
  download for most current Macs.

None of it is blocking for a tool you build yourself, and all of it is blocking
for one you hand to somebody else.

## 6. Claude Code presence — the follow-ups

Presence detection ships annotating the Stop button. Two things were
deliberately left out of v1, in this order:

- **Confirm before stopping a container with a live session.** The annotation was
  the honest v1 because this app has no modal today, and adding the first one
  should not have ridden along with a detection nobody had watched against a real
  daemon. It has been watched against one now, on all three platforms, so this is
  the next thing to build here rather than a thing waiting on evidence. The
  detection is a superset of "a session is doing work" — it also fires on an
  idle one — so the confirm has to be dismissable without being annoying, which
  is the actual design question.
- **Activity, not just presence.** Working vs. idle vs. waiting on a permission
  prompt would mean parsing session transcripts under
  `~/.claude/projects/**/*.jsonl` or the IDE lock files under `~/.claude/ide/`,
  and locating the container's home directory first. Neither path is a versioned
  interface. It stays a separate item on purpose: presence is cheap and stable,
  activity is neither, and coupling them would put the stable half at the mercy
  of the other.

## 7. The workspace branch — what it does not do

The chip reads `.git/HEAD` on the host, and its menu lists the local branches
and checks one out. Three things the READING deliberately does not answer, in
rough order of how often they will be missed:

- **Whether the tree is dirty, or ahead of its remote.** Both mean walking the
  index and the refs — orders of magnitude more work than reading one file, on
  a poll, for a machine that may have a dozen containers. If it lands, it wants
  a different cadence and probably an explicit refresh.
- **A branch for the unbuilt projects.** The scan already knows those folders,
  and the same reader would answer for them. It was left out only because the
  scan is on-demand and this is a poll, so joining them needs a decision about
  which clock wins rather than more code.
- **The container's own checkout, when it is not a bind mount.** A dev container
  that clones the repository into a volume instead of mounting the host folder
  has a checkout this cannot see, and will report the host folder's branch — or
  `none` — for it. That is the trade that buys the whole feature its cost of two
  file reads; the alternative is an `exec` per container.

And four the SWITCHING does not do, each left out on purpose rather than for
lack of time:

- **Create a branch, or check out a remote one.** The menu offers `refs/heads`
  and nothing else. `git switch -c` and tracking a `refs/remotes` ref are both
  one command away in a terminal, and both would put boxwarden in the business
  of naming refs — which is exactly what makes the current design safe, since
  the renderer can only ever pick from a list git printed.
- **Stash, or carry changes across.** Refusing on a dirty tree is the whole
  posture (see CLAUDE.md), and reversing it is a product decision, not a patch.
  If it ever lands it wants an explicit "Stash and switch" that also offers to
  pop — a half-done stash is worse than a refusal.
- **Fetch or pull.** Nothing here touches the network, which is why there is no
  credential path to think about. `GIT_TERMINAL_PROMPT=0` is set anyway, because
  an LFS smudge filter can turn a local checkout into a download.
- **Switch a branch for an unbuilt project.** Same join problem as reading one:
  the scan is on demand and this hangs off a container card.

## 8. Port forwarding, and why the terminal cannot provide it

A dev server started from boxwarden's terminal is not reachable on
`localhost:3000` the way one started from a VS Code terminal is. This comes up
as "the terminal is broken", so it is worth being exact about where the
forwarding actually happens.

**It is not the shell's doing, in either case.** VS Code's port forwarding is a
service of the vscode-server running INSIDE the container plus the VS Code
client on the host; the two hold a tunnel open and the client binds the host
port. A shell — whether spawned by the server, by `docker exec`, or by
`devcontainer exec` — has no part in it. So "spawn the terminal exactly the way
VS Code does" would not deliver forwarding: there is nothing to spawn it into.
This is the same reason the ports the card lists are the DAEMON's published
ports (`-p`) and never VS Code's forwarded ones.

Which means, with a VS Code window attached, a server started from boxwarden's
terminal _should_ be forwarded anyway — `remote.autoForwardPorts` defaults to
watching the container's running processes, not VS Code's own terminal output,
so it does not care which shell started the process. Two things break that, and
neither is boxwarden:

- **No window is attached.** Nothing is forwarding, and nothing will. The card's
  editor badge is the honest indicator of this.
- **`remote.autoForwardPortsSource` has flipped to `hybrid`.** VS Code switches
  it automatically once twenty ports have been forwarded in a session, and in a
  dev container it then stops detecting ports — see
  [microsoft/vscode#200795](https://github.com/microsoft/vscode/issues/200795)
  and
  [microsoft/vscode-remote-release#10926](https://github.com/microsoft/vscode-remote-release/issues/10926).
  It is written to user settings, so it persists. Setting it back to `process`
  is the fix.

What boxwarden could do, in increasing order of cost:

- **Say so.** The card knows the container's published ports, and it knows
  whether an editor is attached. A container with a dev server and neither a
  published port nor an attached editor is a diagnosable state, and an advisory
  is the cheap half of this whole entry.
- **Publish at build time.** `appPort` in `devcontainer.json` is a real `-p`,
  so the port is reachable with no editor running at all. boxwarden already
  reads and copies `devcontainer.json` for the unbuilt-project flow; offering
  the edit is a small step from there. It needs a rebuild, which is the catch.
- **Forward it itself.** A TCP listener in the main process relaying into the
  container. There is no way to do that over the Docker API alone without a
  relay binary in the container (`socat`, or a helper container on
  `--network container:<id>`), so it is a real feature with a real dependency,
  not an afternoon. It would also be the first thing boxwarden runs inside
  somebody's container, which is a line this app has been deliberate about not
  crossing — see the `top`-never-`exec` rule for Claude Code presence.

One smaller piece of VS Code parity is genuinely missing and unrelated to any
of the above: **`remoteEnv` is not applied to the terminal.** `containerEnv`
lands in `Config.Env` and so is inherited by `docker exec`, but `remoteEnv` is
applied by the vscode-server, so a boxwarden shell does not have it. It is in
the `devcontainer.metadata` label, beside `remoteUser` and `workspaceFolder`
which are already read from there. The reason it was not done with those is the
environment rule in `mapping.ts`: `remoteEnv` values can be
`${containerEnv:VAR}` references, resolving them means reading `Config.Env`, and
the resolved result must then NOT cross IPC into the renderer's snapshot. That
means a main-process-only map keyed by container id, which is a small piece of
plumbing the backend does not have yet.

## 9. Smaller things

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
  `terminal/targets.ts`) now works on a real Windows machine, which is exactly
  why a Windows runner is worth adding: what is unguarded is not whether it
  works but whether it keeps working, and a regression there is currently
  invisible until somebody launches the app on Windows by hand.

## Done

Items completed since the first MVP pass, kept for the record:

- ~~Prove the real paths~~ — the item that sat at the top of this list as the
  highest priority for the whole MVP: run it against real daemons, confirm the
  URI reattaches, confirm binary resolution, confirm a terminal lands a shell.
  Done on macOS, Linux and Windows; the findings are in
  [What has been verified](#what-has-been-verified). The load-bearing result is
  the negative one — VS Code does **not** normalise the host path before
  hex-encoding it, so the raw label rule holds and `authorityFor` stays as it is.
- ~~Verify the forks~~ — Cursor and Windsurf both reattach through
  `vscode-remote` and `--folder-uri`, so neither diverges. What is left is the
  cleanup that follows, which is item 1 above.
- ~~Packaging~~ — electron-builder, four targets, an icon, and installers
  installed and run on all three platforms. What remains of that item is
  signing, notarisation and arm64, which is why it still has a section above.
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
- ~~Open a terminal in a container~~, with a per-container startup command —
  confirmed against real daemons and real emulators on all three platforms,
  including the two that have no CLI and are driven by AppleScript.
- ~~Claude Code presence~~ and ~~attached-editor detection~~, from one
  `top` per container. What remains is the confirm dialog, which is item 6.
- ~~The workspace branch~~ — read from `.git/HEAD` on the host, worktrees
  followed. Item 7 is what it deliberately does not answer.
- ~~The release check~~ — a packaged build asks GitHub daily and names the
  artefact for the machine it is on. The in-app download that briefly
  accompanied it was removed on purpose; see
  [development.md](./development.md#why-there-is-no-in-app-download).
