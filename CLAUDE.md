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
bun run check        # typecheck + lint + format:check + test + check:devcontainer — run before committing, and what CI runs

bun run package      # build + electron-builder --dir: unpacked app, no installer
bun run dist         # build + installers for the host OS, into release/
bun run dist:mac / dist:linux / dist:win

bun run check:release-version   # tag vs package.json — run before tagging, not part of `check`
bun run check:sigstore          # can this machine reach Sigstore's trust root? diagnostic, not part of `check`

bun run devcontainer:open   # devcontainer up, then attach an editor to it (scripts/devcontainer-open.mjs)
```

Run a single test file: `bunx vitest run src/main/docker/mapping.test.ts`.

## Architecture

**The app is MVVM.** Three Electron processes carry the three roles, and no
layer reaches past the one below it:

```
VIEW        src/renderer/views/        layout only — no state, no logic
            src/renderer/components/   leaf presentational components
        │ binds to
VIEWMODEL   src/renderer/viewmodels/   state, commands, derived values (React hooks)
            src/renderer/presenters.ts pure derivations the ViewModels hand down
        │ window.boxwarden
            src/preload/               ipcRenderer.invoke wrappers only, no logic
            src/shared/ipc.ts          the IPC contract
        │ ipcMain.handle
MODEL       src/models/                pure types and functions, imports nothing
            src/main/                  the impure shells that fill them
              docker/     endpoint discovery, dockerode, inspect→model
              discovery/  finding a binary on this machine
              editor/     URI building, spawn
              terminal/   docker exec argv, emulator quoting, spawn
              projects/   filesystem walk for unbuilt dev containers
              update/     the daily release check, and its fixture
```

**The layering rule** has three parts, and all three are load-bearing:

1. **`src/models/` holds only types and pure functions and imports nothing.**
   Anything that touches the outside world lives in `src/main/` as a thin shell
   around a pure core:

   | Impure edge                       | Pure core it wraps                         |
   | --------------------------------- | ------------------------------------------ |
   | `docker/client.ts` (dockerode)    | `docker/mapping.ts`, `docker/host-path.ts` |
   | `docker/client.ts` (probing)      | `docker/endpoint.ts`                       |
   | `editor/launch.ts` (spawn)        | `editor/uri.ts`                            |
   | `terminal/launch.ts` (spawn)      | `terminal/command.ts`                      |
   | `discovery/resolve.ts` (fs, exec) | `editor/targets.ts`, `terminal/targets.ts` |
   | `projects/scan.ts` (fs walk)      | `models/project.ts`                        |
   | `git/status.ts` (fs reads)        | `models/git.ts`                            |
   | `preferences.ts` (fs)             | `models/{engine,project,terminal}.ts`      |
   | `ssh-agent.ts` (env, fs, exec)    | `models/advice.ts`, `models/ssh-agent.ts`  |
   | `update/github.ts` (net)          | `models/update.ts`                         |
   | `update/check.ts` (clock, cache)  | `models/update.ts`                         |

2. **A ViewModel renders nothing.** No module in `src/renderer/viewmodels/`
   imports `react-dom` or returns JSX. That is what lets the whole layer be
   tested with `renderHook` against a fake `BoxwardenApi` — no Electron, no
   daemon, no markup.

3. **A View decides nothing.** If a string needs an `if`, it belongs in
   `presenters.ts` and reaches the View through a ViewModel field. `App.tsx` is
   the composition root and is deliberately two lines.

Preserve this split when adding features — it's why the suite tests without a
Docker daemon or a display, and why the shells stay small.

### The ViewModel layer

`useAppViewModel()` composes ten, kept separate because their lifetimes
genuinely differ:

| Hook              | Owns                                                        | Cadence                    |
| ----------------- | ----------------------------------------------------------- | -------------------------- |
| `useDiscovery`    | snapshot, busy set, start/stop/open/terminal, engine choice | polled every 5s            |
| `useProjects`     | scan, roots, unbuilt/built partition                        | on open, on ask            |
| `useEditors`      | installed editors, the chosen one                           | read once                  |
| `useTerminals`    | installed emulators, the chosen one, startup commands       | read once                  |
| `useNotices`      | the message bar and the copyable fallback                   | event-driven               |
| `useClaudeStatus` | Claude Code presence per container                          | polled every 15s           |
| `useGitStatus`    | the branch each workspace folder is on                      | polled every 30s           |
| `useUpdate`       | the release check: banner, footer line, dismiss, off switch | asked hourly, GitHub daily |
| `useAdvisories`   | which advice is hidden, and which screen is showing         | never touches IPC          |
| `useTheme`        | layout + theme, persisted to localStorage                   | never touches IPC          |

Four conventions hold this together:

- **Every hook is called unconditionally** and guards on `api` internally. A
  preload that failed to load must not change how many hooks run.
- **`useDiscovery` and `useProjects` destructure the stable callbacks off
  `notices`** rather than depending on the object. `useNotices` returns a fresh
  object literal each render, and depending on it would re-run the poll effect
  on every notice.
- **Actions live next to the state they change.** Start/stop/open/terminal sit
  in `useDiscovery` because they share the busy set — the poll, the busy set and
  the lifecycle verbs are one state machine, and splitting them lets a stop land
  on top of a refresh and get overwritten with pre-stop state. `useTerminals`
  owns the emulator list and the startup commands but NOT `openTerminal`, for
  exactly that reason: two busy sets would let one re-enable a button the other
  still considers busy.
- **Failures report through `useNotices`**, never through a second message
  channel, so a later failure cannot hide behind an earlier one. `useUpdate` is
  the one exception, and it is a narrow one: every other ViewModel reports a
  failure that followed a click, whereas a background release check that seized
  the message bar would push aside a notice about what the user was actually
  doing — hourly, forever, on a machine that is simply offline. A failed check
  is an arm of `UpdateStatus` instead, so it renders where the answer would
  have.

**The IPC surface is twenty-two narrow verbs** — see `src/shared/ipc.ts` — all
declared as a `BoxwardenApi` interface consumed by the renderer without
importing Electron. They fall into three groups by cadence:

- **Docker, polled every 5s**: `discover`, `start`, `stop`, `listEditors`,
  `openInEditor`, `selectEngine`.
- **Filesystem, on demand only**: `scanProjects`, `openProject`,
  `addProjectRoot`, `removeProjectRoot`.
- **Terminals, read once then on demand**: `listTerminals`, `openTerminal`,
  `getStartupCommands`, `setStartupCommand`.
- **Container processes, polled every 15s**: `claudeStatus`.
- **The host's checkouts, polled every 30s**: `gitStatus`.
- **The release check, asked hourly and answered from GitHub once a day**:
  `updateStatus`, `dismissUpdate`, `setUpdateChecks`, `downloadUpdate`,
  `cancelUpdateDownload`, `installUpdate`.

Prefer looping over the existing verbs (e.g. `Promise.allSettled` for a compose
group's "Start all") over adding new channels. The exceptions so far all earned
it: `selectEngine` changes main-process state that outlives the call; the
terminal verbs spawn a process no combination of the others can; and the
project verbs, `claudeStatus` and `gitStatus` are a _different cadence_ —
folding `scanProjects` into `DiscoverySnapshot` would make the 5s poll pay for
a filesystem walk sixty times an hour, folding in `claudeStatus` would multiply
its Docker traffic by the number of live containers, and folding in `gitStatus`
would put a `stat` per container — possibly over a network share — behind a
poll that runs seven hundred times an hour. The update verbs
clear all three between them: `updateStatus` is the slowest cadence in the app
(an HTTP request, daily); `dismissUpdate` and `setUpdateChecks` write
preferences that outlive the call; and `downloadUpdate`, `cancelUpdateDownload`
and `installUpdate` do something no combination of the others can, because a
sandboxed renderer has no filesystem — and because the decision that a download
is trustworthy must not live on the side of the bridge that renders network
data. **A new verb has to clear one of those three bars.** Lifecycle actions return failure as
`{ ok: false, message }` data rather than throwing — a thrown main-process
error crosses IPC as an opaque string with the real message buried.

Every verb that acts on a container or a project takes an **ID**. The main
process resolves it against its own copy from the last scan and never acts on
renderer-supplied data: `openInEditor` will not take a host path,
`openProject` will not take a folder, `openTerminal` will not take a startup
command — it reads its own stored copy — and `claudeStatus` and `gitStatus`
drop any id that is not in the last scan. `gitStatus` is the sharpest case of
the id rule: what an id resolves to there is a path on the user's disk that the
main process then opens.

`addProjectRoot` takes **no argument** on purpose: the renderer can ask for the
folder picker, and cannot say which folder the answer is. `dismissUpdate` is
the same shape — the renderer says the user dismissed something, and the main
process decides which version that was from its own last status. So are the
three download verbs, and they are the sharpest case of the rule: one fetches a
file from the internet and one opens it with the operating system, and neither
takes a URL, a filename or a version. The plan is built in the main process
from a release payload whose every link was already checked against this
repository, and the path handed to the OS is the single one that passed both the
checksum and the signature.

### Two path spaces — the most error-prone part of this app

- **Host paths** — what the developer's OS sees. `HostPath` in the models layer,
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
`src/models/engine.ts` narrows that to one engine; the picker appears in the
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

`src/models/advice.ts` is a pure function from `DockerEnvironment` to
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

### Hiding advice, and the setup page

An advisory panel that is always on screen is one nobody reads on the day it
matters, so a card can be **collapsed** (body folded away, per-run, default from
severity — `error`/`warning` open, `info` folded) and **hidden** (off the main
screen, persisted by `Advice.id` in `localStorage`). `src/renderer/advisories.ts`
is the pure half; `useAdvisories` is the state.

**Nothing is ever destroyed.** A hidden advisory is still computed, still
counted in the header tooltip, and still listed in full on the second screen —
`views/SetupView.tsx`, reachable from the header's nav whether or not anything
is wrong. Three rules keep that true:

- **`onHide` is only passed where the advisory survives it.** `<Advisories>`
  takes `onHide` on the main screen and `onRestore` on the setup page's hidden
  list; a Hide button on an already-hidden card would do nothing.
- **A hidden id is kept even when nothing matches it this scan.** The condition
  comes and goes (a distro is started, an engine restarted) and pruning on load
  would un-hide it the first time the machine was briefly healthy.
- **The header counts ACTIVE advice; the tooltip says how many are hidden.** A
  count of zero on a tab holding four hidden warnings is the one lie available
  here.

`<EndpointAttempts>` is shared: in `<DockerUnavailable>` it is evidence for a
failure and only renders when nothing answered; on the setup page it is a
standing inventory shown while everything works, which is what answers "one of
my two engines is missing — which socket did boxwarden not find?"

Persisted in `localStorage`, not `preferences.json` — same reason as the layout:
the main process makes no decision from it.

### SSH agent forwarding

Two halves, both fed by data the app already has.

`src/models/ssh-agent.ts` folds `Config.Env` + mount destinations from the
inspect response into `DevContainer.sshAgent`: `forwarded`,
`declared-unmounted`, or `absent`. No extra Docker call, no new IPC verb.
`declared-unmounted` — the variable is set, the socket is not there — is the
one a user cannot diagnose alone; `absent` renders nothing at all.

**The environment rule:** `Config.Env` carries tokens and passwords. Exactly
one variable (`SSH_AUTH_SOCK`) is read out of it in `mapContainer` and the
array is never bound to a name that outlives that call. It must never reach
`DevContainer`, cross IPC, land in a snapshot, or hit a log line — the
`does not carry any environment variable other than SSH_AUTH_SOCK` test in
`mapping.test.ts` pins that over the serialised result. Don't relax it to
"the variables we need"; the next need will be someone's registry password.

`adviseSshAgent` in `advice.ts` handles the host side, from the probe in
`src/main/ssh-agent.ts` (cached 30s — discovery polls every 5s and Windows
spawns PowerShell). **Severity is never `error`**: plenty of dev containers
have no business talking to a remote. When boxwarden runs in its own dev
container, `process.env` describes the container, so the host branch is
suppressed rather than reported about the wrong machine.

### WSL on Windows

`DockerEnvironment.wsl` carries a `WslStatus` (`not-installed` → `no-distros`
→ `none-running` → `ready`, plus per-distro socat/podman/socket facts) because
on Windows WSL _is_ the setup: Linux containers need a Linux kernel and every
mainstream engine runs inside WSL2. The nastiest case it exists for is a distro
with an engine and no socat — 9P cannot carry unix sockets, so those containers
are invisible and the list looks complete while being short. That advisory
shows even when another engine is working.

### Unbuilt projects

`src/models/project.ts` (pure) plus `src/main/projects/scan.ts` (the walk) find
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

### Opening a terminal

`docker exec -it <id> sh -lc <script>` inside a terminal window, assembled
purely in `src/main/terminal/command.ts` and spawned by `launch.ts`.

- **The daemon is named explicitly** (`-H` for docker, `--url` for podman) from
  the endpoint the container was last seen on. This app connects to every engine
  that answers; the engine selection narrows what it LISTS but does not reach
  the CLI, so leaving the choice to the CLI's default means "no such container"
  for one that is on screen. A WSL socket runs `wsl.exe -d <distro> --` and
  names the CLI bare, on the Linux side.
- **The shell starts in the workspace folder.** `docker exec` starts in the
  image's `WorkingDir`, which is usually `/`, so the script `cd`s to
  `workspaceFolder` first and the startup command therefore runs from there.
  It is a `cd` and NOT `docker exec -w` on purpose: `workspaceFolder`'s third
  source is the `/workspaces/<basename>` convention, i.e. a guess, and a `-w`
  at a path that does not exist makes the daemon refuse the exec — most
  emulators then close the window instantly, so the button appears to do
  nothing. A failed `cd` leaves the developer where they were before, with one
  line on stderr saying so.
- **`terminal/targets.ts` is a data table** of twelve emulators with three
  invocation styles: `argv` (safe, the default), `command-string`, and
  `applescript` (Terminal.app and iTerm2, which have no CLI at all). iTerm2 3.x
  needs `create window with default profile command`, not `do script`.
- **The quoting is the security boundary.** `posixQuote` and
  `appleScriptString` are pure, wrap rather than escape a denylist, and are
  tested against a deliberately hostile startup command. `spawn` is never given
  `shell: true` — the startup command is user-authored shell code meant to run
  _inside_ the container. The workspace folder goes through the same quoting for
  a different reason: the user did not write it, a container label did.
- **Startup commands are keyed by `containerSettingsKey`**, i.e. the host folder
  (plus container name for compose members), not the container id. A rebuild
  changes the id, and a setting that evaporates on rebuild is worse than none.
  They live in `preferences.json` beside the engine selection and scan roots.

### Compose grouping

`src/renderer/grouping.ts` folds the flat container list into `ContainerGroup`
(`single` | `compose`) so a workspace + its database render as one framed
group. It is a pure function, called by `useDiscovery` and exposed as
`groups` — the `ContainerList` view receives the folded list and never sees the
flat one. Known gap: grouping only sees containers carrying
`devcontainer.local_folder`, so an unlabeled compose sibling is invisible to
"Stop all" (see `docs/roadmap.md`).

### Claude Code presence

Each card says whether a `claude` process is running inside the container, so
Stop and "Stop all" are not blind to an agent mid-task. Same shell/core split
as everything else: `claudeStatus` in `docker/client.ts` calls
`Container.top()` and hands the raw rows to the pure `parseClaudeProcesses` in
`src/models/claude.ts`; `useClaudeStatus` polls, `claudeBadge` in
`presenters.ts` turns a status into a label and tone, and `ContainerCard` gets a
field rather than a `switch`.

Four things this feature will break on if they are forgotten:

- **`top`, never `exec`.** Read-only, no shell, runs nothing in the container.
  The process table is attacker-influenced data (anyone who can create
  containers on the daemon), so an `exec` would be a far larger surface for a
  strictly smaller answer.
- **Find the command column by _title_, never by index.** Docker's default is
  `ps -ef` (`UID PID PPID C STIME TTY TIME CMD`); Podman returns
  `USER PID PPID %CPU ELAPSED TTY TIME COMMAND`. The response carries `Titles`
  alongside `Processes` for exactly this.
- **`STIME` is not `ELAPSED`.** Docker gives a start time, Podman a duration.
  They live on separate `ClaudeSession` fields and the UI says "since" vs "up"
  accordingly — folding them together ages a ten-minute session by ten hours.
- **Match the package path, not the process name.** The CLI is a Node process
  (`node .../@anthropic-ai/claude-code/cli.js`), and a wrapper named `claude` is
  the other spelling. Matching any token containing "claude" false-positives on
  an ordinary checkout, which is worse than no badge — the badge only earns its
  place if it is believed.

Three arms of `ClaudeStatus` render as nothing (`none`, `not-applicable`, and a
container not yet polled) and one renders as an uncertain badge (`unknown`).
Keep them distinct: **the absence of a badge is how a card says stopping is
safe**, and "we could not tell" must not borrow that meaning.

**Scope is presence, not activity.** Working vs. idle vs. waiting on a prompt
would mean parsing session transcripts or IDE lock files under the container's
`~/.claude`; neither is a versioned interface. Presence is cheap and stable,
activity is neither.

v1 **annotates** the Stop button rather than gating it; a confirm dialog is the
follow-up, once the detection has been seen to be reliable against a real
daemon.

### The workspace branch

Each card says which branch its workspace folder is on, read from `.git/HEAD`
on the **host** — `src/models/git.ts` is the pure half (`parseGitHead`,
`parseGitDirPointer`, `readableHostFolder`), `src/main/git/status.ts` does the
file reads, `useGitStatus` polls, `branchChip` in `presenters.ts` turns a
status into a chip, and `ContainerCard` gets a field.

- **The host filesystem, never `docker exec`.** A dev container's workspace is
  a bind mount of `devcontainer.local_folder`, so the checkout the container
  sees is the one on disk beside it. Two file reads, no Docker call, and an
  answer for a container that is STOPPED — which is when "which branch was that
  one on?" is most often asked. `git rev-parse` inside the container works only
  while it is running, only if git is installed in the image, and runs a
  program in a container this app did not build.
- **`readableHostFolder` normalises; `authorityFor` still must not.** The WSL
  arm becomes `\\wsl.localhost\<distro>\…` so Windows can open it. Safe here
  for the same reason it is safe in `comparableFolder`: nothing is launched from
  the result. A folder whose flavour does not match the host answers `undefined`
  rather than a guess.
- **Follow the `.git` FILE, not just the directory.** One worktree per agent is
  a common way to run several Claude Code sessions over one repository, and
  those are exactly the containers whose branch nobody can keep in their head.
  The pointer may be relative to the folder holding it.
- **The read is bounded** — four levels up, two seconds — because a host path
  can be a network share, a spun-down disk, or a UNC into a WSL distro that has
  stopped answering, all of which make `stat` block rather than fail.
- **`unknown` renders NOTHING, unlike the Claude badge's `unknown`.** That badge
  guards a click, so "we could not tell" has to be visible. A branch guards
  nothing, and `unknown` is the ordinary state of every card on a machine where
  the folders are not visible (boxwarden in its own dev container, a WSL path
  seen from macOS, a daemon over SSH) — a chip on all of them forever is how a
  chip stops being read. `none` and `unknown` stay separate arms regardless:
  one is an answer, the other is the absence of one.
- **One read per FOLDER, not per container.** Every service in a compose project
  carries the same label, so a five-service workspace would otherwise stat one
  `.git` five times a poll.

### Self-update

Once a day the main process asks GitHub for `/releases/latest` and, if
something newer exists, says which file this machine needs and how to install
it. Same split as everything else: `src/models/update.ts` is pure and holds the
whole decision — semver precedence, the payload parser, install-kind detection,
the asset match, the per-platform instructions. `src/main/update/github.ts` is
the one module that reaches the network, and it is the only one that imports
Electron; `src/main/update/check.ts` holds the clock and the cache, takes the
fetch as a parameter, and therefore has tests.

**It does not swap the application bundle, and that is the design, not a stage
of it.** `electron-updater` does exactly that and verifies a CODE signature to
decide it is safe; these builds have none — cosign is a different thing and does
not substitute — so Squirrel.Mac refuses the swap outright and everywhere else
it would overwrite a binary the OS never checked.

### Fetching and verifying the download

What it DOES do is the half that needs no certificate, in the pure
`src/models/download.ts` plus shells in `src/main/update/`:

1. **Plan** — resolve the artefact, its `<name>.sigstore.json` and
   `sha256sums.txt` out of the release. All three are release ASSETS, held to
   the same `RELEASE_URL_PREFIX` rule as everything else out of that payload,
   never URLs built by concatenation.
2. **Fetch** — stream to `userData/updates`, capped, with progress.
3. **Verify** — SHA-256 against the manifest, then the Sigstore bundle against a
   TUF-fetched trust root.
4. **Apply** — `shell.openPath` and let the OS install. Except the AppImage.

Six rules hold this together:

- **A missing signature is a REFUSAL, never a downgrade to checksum-only.**
  Otherwise an attacker who can add an asset to a release disables the signature
  check by omitting one. Same for a missing `sha256sums.txt`.
- **The certificate identity is the point.** Any workflow on GitHub can get a
  cert from the same issuer, so a bundle that merely verifies proves nothing.
  `signerIdentity` pins the SAN to
  `.github/workflows/release.yml@refs/tags/<tag>` and the issuer to GitHub's
  Actions token service. **That string is a contract with `release.yml`** —
  renaming the workflow, or moving the signing step into a reusable one, makes
  every installed copy refuse the next release.
- **`safeAssetFileName` is an allow-list and refuses rather than sanitises.** The
  name arrives over the network and becomes a path. Rewriting a hostile name
  into a safe one produces a file that no longer matches its line in
  `sha256sums.txt`, so the failure would surface as a bogus integrity error.
  No spaces: `electron-builder.yml` sets `nsis.artifactName` so the installer
  is `boxwarden-setup-<version>-<arch>.exe` rather than the spaced default,
  which is what lets the allow-list stay this narrow. First and last characters
  must be alphanumeric, which stops the trailing dot or space Windows strips
  _after_ validation.
- **`verifying` is a state of its own, and nothing is installable during it.**
  That is the window in which the whole file is on disk and unvouched-for. A
  file boxwarden wrote itself carries no `com.apple.quarantine` attribute, so
  Gatekeeper's first-launch check does not fire — **this verification is the
  only gate, not a second opinion.**
- **The AppImage is the one in-place update, and only via a same-directory
  rename.** An AppImage is one file the user owns; a copy interrupted halfway
  would leave them with a truncated binary and no working boxwarden.
- **A refusal to verify says nothing useful on purpose, so it says it to the
  log instead.** "We could not check this" must not read as "this is forged",
  which leaves the real cause with nowhere to go: the app is a Windows GUI
  process with no console, and nothing downstream reads the `cause`. Both
  failures are therefore `console.error`ed in `trust.ts`, and
  `scripts/check-sigstore.mjs` asks the same question from the command line —
  same library, same options, same cache directory — for a machine where
  rebuilding the app is not the fastest way to find out.
- **The trust root comes from TUF, not a vendored JSON.** Sigstore rotates keys;
  a pinned snapshot would silently turn every download into a failure on some
  Tuesday, and an update mechanism that disables itself is worse than none.

Five things the CHECK breaks on if they are forgotten:

- **A prerelease sorts BELOW the release it leads to.** Backwards, and everyone
  on the final 1.2.0 is prompted to "update" to the candidate it replaced.
- **The install KIND decides the instructions, not the platform.** Linux is a
  deb apt replaces in place and an AppImage the user overwrites by hand.
  `detectInstallKind` reads the AppImage runtime's own `APPIMAGE` variable and
  the install prefix, and answers `linux-unknown` rather than guessing.
- **The x64 deb is `amd64`.** electron-builder follows dpkg's architecture
  names for the deb and omits the architecture entirely from the default x64
  dmg and AppImage. One token table covers all of it; a per-target regex is how
  the deb ends up unmatched. Those filenames are an interface — renaming an
  artefact in `release.yml` breaks the match.
- **URLs from the response are checked against
  `https://github.com/sethcarney/boxwarden/releases/`, not `github.com`.**
  `shell.openExternal` only checks the origin, so origin alone would accept a
  link to any other repository on the site. The same parser guards the copy
  remembered in `preferences.json`, which is a file anything can write.
- **A failed check is not "up to date".** Separate arms, rendered differently,
  for the reason `ClaudeStatus` keeps `unknown` apart from `none`.

The check is skipped entirely when `app.isPackaged` is false, so `bun run dev`
and CI never contact GitHub — which also means `BOXWARDEN_FAKE_UPDATE=1` is the
only way to see the banner until a release exists. The fixture drives the real
`planDownload` over a fabricated release that carries its signature and checksum
assets, and simulates the fetch, so the progress bar and the Install button can
be worked on without a network — but it will not install anything.

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
- `auto` is resolved in `useTheme` (via the pure `resolveTheme`) so the light
  palette is written once and `data-theme` always names a concrete theme. The
  attribute is written in a `useLayoutEffect`, not a `useEffect`: the passive
  one runs after the first paint, so a light-theme user would see one frame of
  the dark palette on every launch.
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
- **Launching never goes through a shell**: `src/main/editor/launch.ts` and
  `src/main/terminal/launch.ts` use `spawn` with an argv array, never
  `shell: true`. The URI embeds a hex-encoded host path that originates from a
  container label (i.e. attacker-influenced by anyone who can create containers
  on the daemon), and the terminal command line embeds the user's startup
  command verbatim.

Full checklist and rationale: `docs/electron-security.md`. Read it before
changing `webPreferences`, adding an IPC channel, or loading new content into
the window.

## TypeScript / lint conventions

Two separate `tsconfig`s because the renderer has DOM and no Node, and
main/preload have the reverse — one config can't express both:

- `tsconfig.base.json` — shared strictness
- `tsconfig.node.json` — `src/main`, `src/preload`, `src/models`, `src/shared`
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

### The layering rule is linted, not just documented

`eslint-plugin-mvvm` enforces the three-part layering rule above. The layers
are named explicitly in `settings.mvvm` rather than left to the plugin's
generic conventions, so classification tracks this repo instead of guessing —
the defaults also read `services/`, `api/`, `stores/` and `domain/` as Model,
and a future `src/main/services/` would silently start being linted as a layer
it is not.

| Layer     | What matches                                                               |
| --------- | -------------------------------------------------------------------------- |
| Model     | `src/models/`                                                              |
| ViewModel | `src/renderer/viewmodels/`, plus the pure `.ts` directly under `renderer/` |
| View      | the `.tsx` under `src/renderer/`                                           |

`presenters.ts`, `format.ts`, `grouping.ts` and `view.ts` are ViewModel, not
unclassified: they are the derivations a View binds to, and naming them is what
makes the direction _checked_ — an unclassified module is exempt from the rule,
so leaving them out would let `presenters.ts` import a component with nothing
to say so.

`src/main` and `src/preload` are deliberately out of scope. They are the impure
shells behind the IPC boundary, not an MVVM layer.

Four things follow, and three of them are ordinary ESLint rules rather than the
plugin, because the plugin cannot see them:

- **`no-state-in-view` runs in `strict`, not the preset's `warn-business`.**
  That mode only fires when `useState` sits beside a `fetch`/axios/TanStack
  call, and this app reaches Docker over `window.boxwarden` — it would never
  fire at all.
- **A View may not import `renderer/api.ts`.** That is `no-api-in-view`
  expressed in this app's terms: the plugin knows fetch and axios, and the
  bridge here is `getApi()`.
- **`src/models/` may not import from `renderer/`, `main/` or `preload/`** —
  rule 1 above, as a lint error.
- **A ViewModel may not import a component.** The plugin classifies a View by
  file extension and resolves relative specifiers on disk; with
  `verbatimModuleSyntax` on, every import here is written `./Foo.js` while the
  file is `Foo.tsx`, which resolves to nothing, so `viewModelImportsView` and
  `modelImportsView` never fire. Model and ViewModel are directory-matched and
  survive it. The `no-restricted-imports` guard covers the gap by path.

Type-only imports from Model into a View stay legal
(`allowTypeImportsFromModel`). A View renders a `DevContainer`; banning the
type would only mean duplicating it.

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

**Test each layer at its own level, and only there.** The MVVM split exists so
that a behaviour has exactly one natural home:

| Layer     | Tested with                         | Fixtures                                  |
| --------- | ----------------------------------- | ----------------------------------------- |
| Model     | plain `vitest`, no DOM              | inline                                    |
| Presenter | plain `vitest`, no DOM              | `viewmodels/test-api.ts`                  |
| ViewModel | `renderHook` + jsdom, a fake bridge | `test-api.ts`, `test-notices.ts`          |
| View      | `render` + jsdom, a hand-built VM   | a literal `ProjectsViewModel` and friends |

Two rules that follow from it:

- **A View test asserts only on what is rendered.** When partitioning moved into
  `useProjects`, its test moved too — asserting the same fold through a DOM in
  `UnbuiltProjects.test.tsx` would have been testing it twice, slower.
- **Build the stub ViewModel outside the render callback.** `renderHook(() =>
useDiscovery(api, stubNotices(), …))` makes a new object every render, which
  gives every callback a new identity and re-runs the poll effect — the test
  then sees four `discover` calls where the app makes one.

## Working without Docker

```bash
BOXWARDEN_FAKE_DOCKER=1 bun run dev    # or: bun run dev:fake
```

Swaps in `FakeDockerBackend`, serving six fixture containers through the
**real** `mapContainer` (see the fixture table in `docs/development.md` for
what each one exercises — Windows paths, compose, unparseable labels, WSL,
etc.). The main process logs a loud warning when this is active; never let a
fake container list be mistaken for a real one.

It also swaps in `src/main/git/fake.ts`, so the branch chips have something to
render — the fixture folders do not exist on anyone's disk. Gated on the same
switch rather than one of its own, which is what stops a real container list
from ever picking up a fabricated branch.

`BOXWARDEN_FAKE_UPDATE=1` is the same bargain for the update banner
(`src/main/update/fake.ts`): a release one minor version above this build,
carrying every artefact the release workflow attaches, folded through the real
`foldUpdateStatus`. It touches neither the network nor `preferences.json`, and
warns just as loudly.

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

## Releasing

A `v*` tag runs `.github/workflows/release.yml`: verify, then one build job per
OS, then a single job that collects all three platforms' installers into one
**draft** GitHub release. `docs/releasing.md` is the procedure; four invariants
hold it together:

- **`package.json` is the only version.** electron-builder reads it and nothing
  else, so `scripts/check-release-version.mjs` fails the run unless the tag is
  exactly `v<that version>` — before three platforms spend ten minutes building
  a number nobody can correct, because a published tag cannot be moved. It also
  refuses `0.0.0`, the placeholder the whole MVP carried, which is a valid
  semver string and would otherwise sail through a tag-match check.
- **The build jobs never publish.** They run `bun run dist:<os> -- --publish
never` and upload workflow artefacts; one later job creates the release.
  Three parallel electron-builder publishers race to create "the" draft and the
  loser silently makes a second one.
- **`check:release-version` is not in `bun run check`.** Both of its assertions
  are false on an ordinary branch — no tag, and the placeholder version — so it
  would fail every PR. It runs once, on the tag.
- **CI CODE-signs nothing, and says so.** `CSC_IDENTITY_AUTO_DISCOVERY: false`
  is set deliberately: left unset, electron-builder searches an empty keychain
  and reports the failure as a warning inside a green log, so an unsigned
  release looks exactly like a signed one. The unsigned-install boilerplate in
  `releasing.md` goes into every release's notes until there is a certificate.
  This is a **different thing** from the cosign signatures below, and neither
  substitutes for the other.

`publish:` in `electron-builder.yml` describes where an update _would_ come
from, not how this repo publishes — it is what puts the right provider into the
`latest*.yml` manifests. Those are attached to every release even though
nothing reads them yet, because the build that would need to find them is the
one already installed.

### Signing and provenance

The `publish` job also signs, and the ordering is load-bearing: signatures are
produced **before** `gh release create` and attached in the same call, so there
is never a draft holding unsigned assets and no separate upload step that can
silently fail. Then a fourth job generates SLSA provenance.

- **One `<name>.sigstore.json` per artefact**, not the older `.sig` + `.pem`
  pair — cosign v3 removed `--output-signature` and `--output-certificate` from
  `sign-blob`. `.sigstore.json` is also one of the extensions Scorecard's
  `Signed-Releases` check recognises; `.bundle` is not.
- **`sha256sums.txt` is signed too**, and is generated before signing so it
  covers the installers rather than the signatures over them. It is also the
  subject list handed to the SLSA generator.
- **Provenance comes from a reusable workflow, not a step.** The guarantee is
  that it is produced somewhere the build cannot reach; a step in the build job
  could write its own.
- **That generator is the one action in this repo referenced by TAG, not SHA.**
  It reads `github.action_ref` at runtime to pick its own binary release, and a
  SHA resolves to nothing. It looks exactly like the mistake everything else
  here is guarding against, which is why the comment beside it is long.

## Supply chain

`docs/supply-chain.md` is the full picture, including the GitHub-side settings
that are not in any file. Four rules that touch code review:

- **Every third-party action is pinned to a full commit SHA with a `# vX.Y.Z`
  comment** — a tag is a pointer its owner can move, i.e. a standing grant of
  code execution on a runner holding this repo's token. Dependabot rewrites the
  SHA and the comment together. The SLSA generator is the single documented
  exception above.
- **Every workflow declares a top-level `permissions:`**, read-only, with
  writes granted per job. `contents: write` lives only in the job that creates
  the release.
- **`*.property.test.ts` files are fast-check property tests**, sitting beside
  the module they cover. They are not a second copy of the example tests: the
  example test names the attack, the property test finds the case nobody named.
  They already found one — `stripJsonc`'s trailing-comma pass was a regex over
  the whole document and rewrote a `,}` that was inside a string. Scorecard's
  `Fuzzing` check also detects them, by the `from 'fast-check'` import in any
  `.ts` file.
- **Adding a link to `advice.ts` still means adding its origin to
  `ALLOWED_EXTERNAL_ORIGINS`.** Unchanged, and unrelated to any of the above —
  it is listed here because it is the other closed set in this repo that fails
  silently.

## Docs

- `docs/architecture.md` — process model, path spaces, discovery, grouping (fuller version of the above)
- `docs/development.md` — Podman/rootless setup, fixtures, testing/lint rationale
- `docs/electron-security.md` — full security checklist and rationale
- `docs/supply-chain.md` — Scorecard, signed releases, and the GitHub settings that bind them
- `docs/running.md` — the three ways to run the app, troubleshooting table
- `docs/releasing.md` — cutting a version: the tag, the workflow, the draft
- `docs/roadmap.md` — what's unverified (no real Docker daemon or editor has touched this yet) and what's next

The README's status line matters: discovery/start-stop/open-in-editor are
unit-tested and UI-verified against fixtures, but **not yet verified against a
real Docker daemon or a real editor install**. The update check is in the same
position for a different reason — there are no releases yet, so nothing has
ever come back from `/releases/latest`.
