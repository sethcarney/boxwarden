# Architecture

boxwarden is an Electron desktop app that lists the dev containers running on
your machine, reattaches an editor to them, and finds the ones on disk that
have never been built.

The app follows **MVVM**, and Electron's process boundaries line up with it:
the View and ViewModel are the renderer, the Model is the main process plus the
pure types both sides share.

```
┌── VIEW — renderer (Chromium, sandboxed, no Node) ──────────┐
│  src/renderer/views/       layout only, no state, no logic │
│  src/renderer/components/  leaf presentational components  │
│  src/renderer/App.tsx      composition root, two lines     │
└───────────────────────┬────────────────────────────────────┘
                        │ props and callbacks
┌── VIEWMODEL ──────────┴────────────────────────────────────┐
│  src/renderer/viewmodels/   state, commands, derivations   │
│  src/renderer/presenters.ts pure string/flag derivations   │
│  src/renderer/grouping.ts   pure compose folding           │
│  reaches exactly eighteen functions on window.boxwarden    │
└───────────────────────┬────────────────────────────────────┘
                        │ contextBridge, structured clone
┌───────────────────────┴────────────────────────────────────┐
│  preload — src/preload/index.ts                            │
│  no logic, only ipcRenderer.invoke wrappers                │
└───────────────────────┬────────────────────────────────────┘
                        │ ipcMain.handle
┌── MODEL — main (Node) ─┴───────────────────────────────────┐
│  src/main/                                                 │
│    docker/    endpoint discovery, dockerode, inspect→model │
│    editor/    binary resolution, URI building, spawn       │
│    projects/  the filesystem walk for unbuilt projects     │
│    ipc.ts     the eighteen handlers, sender-validated      │
└────────────────────────────────────────────────────────────┘

  src/models/   pure types, no I/O — shared by all three
  src/shared/   the IPC contract — shared by all three
```

## The layering rule

### 1. The Model is pure at its core

`src/models/` holds types and pure functions and imports nothing. Everything
that touches the outside world lives in `src/main/` and is written as a thin
shell around a pure function:

| Impure edge                      | Pure core it wraps                         |
| -------------------------------- | ------------------------------------------ |
| `docker/client.ts` (dockerode)   | `docker/mapping.ts`, `docker/host-path.ts` |
| `docker/client.ts` (probing)     | `docker/endpoint.ts`                       |
| `editor/launch.ts` (spawn)       | `editor/uri.ts`                            |
| `editor/resolve.ts` (fs, exec)   | `editor/targets.ts` (data)                 |
| `projects/scan.ts` (fs walk)     | `models/project.ts`                        |
| `git/status.ts` (fs reads)       | `models/git.ts`                            |
| `ssh-agent.ts` (env, fs, exec)   | `models/advice.ts`, `models/ssh-agent.ts`  |
| `update/github.ts` (net)         | `models/update.ts`                         |
| `update/check.ts` (clock, cache) | `models/update.ts`                         |

That split is why the test suite needs no Docker daemon and no display: the
cores are covered by unit tests, and the shells are small enough to read.

`projects/scan.ts` and `git/status.ts` are the shells with tests of their own,
against a temp directory. The rule the suite keeps is "no daemon and no
display", not "no filesystem", and the bugs those two have — a depth limit off
by one, a `.devcontainer` variant silently dropped, a worktree pointer not
followed — do not appear anywhere else.

### 2. A ViewModel renders nothing

No module in `src/renderer/viewmodels/` imports `react-dom` or returns JSX.
They are React hooks — the idiomatic ViewModel in a function-component
codebase — and they hold every piece of state the UI has, every command it can
issue, and every value derived from the two.

`useAppViewModel()` composes ten, kept apart because their lifetimes differ:

| Hook              | Owns                                                        | Cadence           |
| ----------------- | ----------------------------------------------------------- | ----------------- |
| `useDiscovery`    | snapshot, busy set, start/stop/open/terminal, engine choice | polled every 5s   |
| `useProjects`     | scan, roots, unbuilt/built partition                        | on open, on ask   |
| `useEditors`      | installed editors, the chosen one                           | read once         |
| `useTerminals`    | installed emulators, the chosen one, startup commands       | read once         |
| `useNotices`      | the message bar and the copyable fallback                   | event-driven      |
| `useClaudeStatus` | Claude Code presence per container                          | polled every 15s  |
| `useGitStatus`    | the branch each workspace folder is on                      | polled every 30s  |
| `useUpdate`       | the release check, its banner and its off switch            | asked hourly      |
| `useAdvisories`   | which advice is hidden, which screen is showing             | never touches IPC |
| `useTheme`        | layout + theme, persisted to localStorage                   | never touches IPC |

`useTerminals` owns the emulator list and the startup commands but not
`openTerminal`, which lives in `useDiscovery` with the other container actions:
they share one busy set, and two independent sets would let one re-enable a
button the other still considers busy.

Plus three small ones — `useClock` (one timer for every relative timestamp on
screen), `useCopyToClipboard` (a write that can be refused, and a timer that
must be cancelled on unmount), and `useStartupCommandDraft`.

The last is the one that shows the layer is about direction rather than about a
single object. It is **not** composed into `useAppViewModel`: one instance lives
with each startup-command field, because the draft is where the text cursor is,
and hoisting it would re-render every card on every keystroke to hold a value
only one of them can see. It is still a ViewModel — the rules about when an
edit commits and when it is thrown away are decisions, and a View decides
nothing. `mvvm/no-state-in-view` is what keeps that from drifting back into the
component.

The payoff is that the layer is testable with `renderHook` and a fake
`BoxwardenApi`: `viewmodels/useDiscovery.test.ts` asserts that a start marks its
container busy, that `startAll` uses `allSettled` and reports the failures
together, and that an engine change re-reads immediately — none of which
required a browser, a daemon, or a rendered card.

### 3. A View decides nothing

If a string needs an `if`, it belongs in `presenters.ts` and reaches the View
through a ViewModel field. `presenters.ts` is where the header chip's "+1", the
empty-list sentence, the "not built yet" summary and the disabled-button reason
are computed — all pure, all tested without a DOM.

The rule is easiest to see in what left the components:

| Was                                           | Is now                               |
| --------------------------------------------- | ------------------------------------ |
| `engineTitle`/`engineCount` inline in JSX     | `presenters.engineChip`              |
| `summarise()` inside `UnbuiltProjects`        | `presenters.summariseProjects`       |
| `openBlockedReason` inside `ContainerCard`    | `presenters.openBlockedReason`       |
| `partitionProjects` memo in `UnbuiltProjects` | `useProjects.unbuilt` / `.built`     |
| clipboard handler inline in `App.tsx`         | `useNotices.copyFailedUri`           |
| 674-line `App.tsx`                            | `App.tsx` (2 lines) + `views/` + VMs |

## Two path spaces

The single most error-prone thing this app does is handle paths, because there
are two filesystems in play and they look alike:

- **Host paths** — what the developer's OS sees. `HostPath` in the models layer,
  with `posix` / `windows` / `wsl` arms.
- **Container paths** — what's inside the container. `ContainerPath`, a
  branded string.

The editor URI consumes one of each:

```
vscode-remote://dev-container+<hex of host path>/<container path>
```

As two bare strings, transposing them compiles cleanly and only misfires on
someone else's OS. The branding makes it a type error.

### The raw label rule

`devcontainer.local_folder` is parsed into a `MaybeHostPath` **for display
only**. The editor URI is always built from the **raw label string, byte for
byte** — see `src/main/editor/uri.ts`.

The Dev Containers extension wrote that label by hex-encoding a specific
string, and it only recognises the container again if the URI decodes to the
identical string. Normalising `C:/x` to `C:\x`, trimming a trailing slash, or
lowercasing a drive letter each produce a valid-looking URI pointing at a
container that does not exist — so VS Code offers to build a new one. The
`does not normalise the host path` test in `uri.test.ts` is what pins this.

The corollary: `parseLocalFolder` is free to be opinionated, because nothing
about correctness depends on it. `comparableFolder` (matching a project against
a container) and `readableHostFolder` (finding the checkout to read a branch
from) both normalise, and both are safe for the same reason: nothing is
launched from what they return.

## Discovery

1. Build an ordered candidate list (`endpoint.ts`). `DOCKER_HOST` first when
   set and parseable, then the platform's well-known sockets — Docker Desktop,
   OrbStack, Colima, Rancher Desktop, rootless, Podman.
2. Probe each with `docker.version()` until one answers. Every attempt is
   kept, not just the winner.
3. `listContainers` filtered server-side on the existence of the
   `devcontainer.local_folder` label.
4. `inspect` each hit — the list summary lacks `StartedAt`, `ExitCode` and
   `Health`, which the model's runtime union requires.
5. Map to `DevContainer` via the pure `mapContainer`.

Step 2 keeps every attempt because `DockerEnvironment.attempts` **is** the
diagnostics UI. Probing five sockets and reporting only "couldn't connect to
Docker" is what makes this class of tool infuriating; naming the socket that
was missing turns a support thread into a glance.

## Choosing an engine

Discovery connects to **every** engine that answers and unions their container
lists. That is right by default — a Windows machine routinely has a podman
machine behind a named pipe and a rootless podman inside a WSL distro, and the
user thinks of those as "my dev containers", not as two inventories. Duplicates
are collapsed by container id, which is engine-unique.

It is wrong often enough to need an override, so `EngineSelection`
(`models/engine.ts`) is either `all` or one `EngineId`:

- **`EngineId` is derived from the transport**, not assigned — `unix:/var/run/docker.sock`,
  `wsl:dev:/run/user/1000/podman/podman.sock`. There is nowhere to persist an
  assigned id between runs, and the transport is what the selection means.
  Deliberately not the runtime kind: a machine can run two Docker Engines.
- It is **kept apart from `describeTransport`**, which is prose for the
  diagnostics panel. The id is written to the preferences file, so a
  copy-editing pass on the UI must not silently reset everyone's choice.
- The selection lives on the **backend**, not on the list call, so `start` and
  `stop` act on the same engines the user is looking at.
- Probing still tries **every** candidate regardless of the selection. Narrowing
  the probe would make the selection impossible to change once made, because the
  picker can only offer engines that were tried.
- A selection naming an engine that has gone away resolves to an **empty list**,
  never a silent fall back to the others — with the `selected-engine-unreachable`
  advisory to explain it.

Persisted by `main/preferences.ts` into `app.getPath('userData')`, and applied
before the window exists so the first scan honours it.

## Setup advice

`models/advice.ts` turns a `DockerEnvironment` into a list of `Advice` — title,
body, copyable commands, documentation links. It is pure, and the main process
computes it at discover time and ships it in the snapshot.

Pure because every branch describes a machine in a specific state of disrepair,
and the only other way to see one is to own that machine. Reproducing "Windows
with WSL installed but no distribution" on demand is not something a test suite
can do; constructing the record that describes it is trivial.

In the main process rather than the renderer because the inputs — the platform,
whether WSL is installed, whether a distro has socat — are things only the main
process knows. Shipping the advice rather than the raw facts also keeps the
wording in one tested function instead of spread across JSX.

Two rules for anything added there:

- **Every advisory names what is wrong AND what to type.** One that only
  describes the problem belongs in the diagnostics list instead.
- **A link's origin must also be in `ALLOWED_EXTERNAL_ORIGINS`** in
  `main/index.ts`. That set is closed on purpose — advisory text is built from
  probe results, which anyone who can create a container on the daemon can
  influence — so a link added without its origin renders and does nothing.

The commands are shown, never run. They reboot machines, install system
components and use `sudo`; an app that fires those from a button press is not
one to trust with a Docker socket.

### Hiding an advisory, and the setup page

An advisory panel that is always there is one nobody reads on the day it says
something urgent. So a card can be folded shut, and it can be put away
entirely — but **nothing is ever destroyed**, and that is the rule the whole
feature rests on.

- **Collapsing** folds the body away and leaves the title. Per-card, per-run,
  and the default follows severity: `error` and `warning` start open because
  they are why the user is looking at the window, `info` starts folded
  (`renderer/advisories.ts`, `startsExpanded`).
- **Hiding** takes the card off the main screen and persists, keyed on
  `Advice.id`. The advisory is still computed, still counted in the header, and
  still listed in full on the **setup page** — reachable from the header
  whether or not anything is wrong.

Three things follow, and each is pinned by a test:

- **`onHide` is only passed where there is somewhere else to read it.** The
  setup page's hidden list gets `onRestore` instead; a Hide button there would
  be the one control in this app that does nothing.
- **A hidden id is kept even when nothing matches it.** The condition behind an
  advisory comes and goes — a distro is started, an engine restarted — and
  pruning on load would un-hide it the first time the machine was briefly
  healthy.
- **The header counts active advisories and the tooltip accounts for the hidden
  ones.** A count of zero on a tab hiding four warnings is the one lie this
  feature could tell.

The setup page also carries `<EndpointAttempts>`, the same socket list
`<DockerUnavailable>` shows — but there it is evidence for a failure and only
appears when nothing answered, while here it is a standing inventory shown
while everything works. That is what answers "boxwarden found one of my two
engines; which one did it miss?"

Hiding lives in `localStorage` and not `preferences.json`, for the same reason
the layout does: the main process makes no decision from it, so putting it in
the preferences file would buy a sixteenth IPC verb nothing.

## SSH agent forwarding

The difference between `git push` working and a container that looks completely
healthy and cannot reach a private repo. It fails silently, and it fails
differently on every OS, so it is answered in two independent halves.

**Per container** — `models/ssh-agent.ts` folds `Config.Env` and the mount
destinations from the inspect response discovery already reads into an
`SshAgentState`, carried on `DevContainer.sshAgent`. No extra Docker call, no
new IPC verb. Three arms, and the middle one is the point:

| Arm                  | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `forwarded`          | `SSH_AUTH_SOCK` is set and something is mounted there          |
| `declared-unmounted` | The variable is set and the socket it names does not exist     |
| `absent`             | No agent declared — ordinary, usually correct, renders nothing |

`declared-unmounted` is the state a user cannot diagnose alone: `env | grep
SSH` agrees with every tutorial they will find, and the socket behind it is not
there. `absent` renders no badge at all, because an indicator on every card is
one nobody reads.

Mount matching accepts an ancestor **directory** as well as an exact
destination, so a setup sharing the agent socket's parent still reads as
`forwarded`. The bias is one-directional on purpose: erring towards `forwarded`
costs a warning we did not raise, erring the other way costs the credibility of
every warning we do.

**The environment rule, non-negotiable.** A container's `Config.Env` holds
registry credentials, database passwords and API tokens. Exactly one variable
is read out of it, in `mapContainer`, and the array is never bound to a name
that outlives that call — it must never reach `DevContainer`, cross IPC, land
in a snapshot, or appear in a log line. `mapContainer does not carry any
environment variable other than SSH_AUTH_SOCK` in `mapping.test.ts` asserts it
over the serialised result, so a future field that copies the env fails there
rather than shipping.

**Per host** — `adviseSshAgent` in `models/advice.ts`, from a probe in
`main/ssh-agent.ts` (`SSH_AUTH_SOCK` and whether that path exists on
macOS/Linux; `Get-Service ssh-agent` on Windows, where the service ships
disabled). The probe is cached for 30s because discovery polls every five
seconds and spawning PowerShell on that cadence is not a reasonable thing for a
background poll to do.

Two rules specific to it:

- **Severity is never `error`.** Plenty of dev containers have no business
  talking to a remote. `warning` only for a container in front of the user that
  declares a socket it does not have; `info` otherwise. An advisory that nags
  every developer who does not need SSH teaches people to skip the panel that
  will one day matter.
- **When boxwarden runs inside its own dev container**, `process.env` describes
  the container, not the developer's machine — so the host branch is suppressed
  entirely, and the container-side warning (which reads the inspected
  container, and is unaffected) says on which machine to run the commands.

## WSL is part of the environment, not a detail of it

On Windows, `DockerEnvironment.wsl` carries a `WslStatus`:
`not-installed` → `no-distros` → `none-running` → `ready`, with a per-distro
report of socat, podman and the socket found.

It is modelled rather than logged because for dev containers WSL **is** the
setup. Linux containers need a Linux kernel, and every mainstream engine on
Windows runs inside WSL2. So "no container engine found" and "WSL is not
installed" are the same finding at two levels of detail, and only discovery is
in a position to tell them apart.

The case that most justifies the type: a distro with an engine and **no socat**.
WSL projects a distro's filesystem over 9P, and 9P cannot carry unix domain
sockets, so boxwarden needs a relay process on the Linux side. Without it those
containers are invisible — the list renders, looks complete, and is quietly
short. That advisory is shown even when another engine is working fine, because
nothing else on screen would suggest anything is wrong.

## Compose projects are one object

A compose-based dev container is several containers — workspace, database,
maybe a cache. `renderer/grouping.ts` folds the flat list into
`ContainerGroup`, a union of `single` and `compose`, and the UI renders a
project as one framed group with its own Start all / Stop all.

Two decisions worth knowing:

- **Group actions loop over the existing single-container IPC calls** rather
  than adding a `startMany` channel. The IPC surface stays narrow, and a
  project is a handful of containers so the round trips do not matter.
  `Promise.allSettled`, not `all` — one service failing should not abandon its
  siblings half-started.
- **A project takes the position of its first member**, so the caller's
  running-first sort still governs. Sorting groups separately would sink a
  project whose workspace is running below stopped singles because of one
  stopped sibling.

The known gap: grouping only sees containers carrying
`devcontainer.local_folder`. A compose sibling without that label is invisible
to it, so "Stop all" will miss it. See the roadmap.

## Layout and theme

The list is drawn in one of three layouts — `grid` (columns, the default),
`list` (one full-width card each) and `rows` (one line each) — under a `dark`,
`light` or system-following theme. `renderer/view.ts` holds the types, the
parsing and `resolveTheme`; the choice is an attribute on two elements
(`data-layout` on the list, `data-theme` on `<html>`) and everything else is
CSS.

Three decisions worth knowing:

- **One set of components, three column definitions.** `data-layout` selects
  grid tracks in `styles.css`; the cards themselves are the same markup. A
  layout that forked the components would be three places to update every time
  a card gains a field. The one exception is `ContainerCard`'s `dense` prop,
  which shortens a label that cannot fit on one line — and it only shortens,
  the full text stays in the `title`.
- **It is persisted in `localStorage`, not the preferences file.**
  `engineSelection` earned its place there (and its IPC verb) because the main
  process has to honour it before the window exists. Nothing outside the
  renderer has any use for the layout, so putting it in the preferences file
  would mean a seventh IPC verb bought nothing.
- **`auto` is resolved in the renderer**, not with a second
  `prefers-color-scheme` block in the stylesheet, so the light palette is
  written once and `data-theme` always names a concrete theme.

The narrow breakpoints (700px, 460px) mostly move one token: `--gutter`. This
is a utility that gets dragged small and docked to the side of a screen, and
reclaiming the padding is most of what makes that width usable.

## Projects that have not been built yet

Everything above is a view of the Docker daemon, and a dev container only
appears there once someone has built it. That leaves boxwarden blind to the
case it is most obviously wanted for: a machine with a dozen repos cloned and
nothing built, where the honest report is "no dev containers found".

So there is a second, slower source of truth — the filesystem.

- **`src/models/project.ts`** is pure: what a project is, which directories are
  never worth entering, how to read a `name` out of JSONC, and how to decide
  whether a folder already has a container.
- **`src/main/projects/scan.ts`** does the walk, bounded three ways — depth
  (3 levels below a root), wall clock (10s), and result count (250). Hitting any
  of them sets `truncated`, which the UI says out loud. A truncated scan that
  looked complete would send a user hunting for why their project is missing.
- **Scan roots** default to `$HOME`, plus `/workspaces` on Linux (where the Dev
  Containers spec mounts the workspace, so boxwarden inside a dev container
  finds the repo it is running from). The user adds more through the OS folder
  picker; the list is persisted in `preferences.json`.

Three details that are easy to get wrong:

- **Identity is the config path, not the folder.**
  `.devcontainer/<variant>/devcontainer.json` is how the spec spells "this repo
  ships more than one dev container", and keying on the folder drops all but the
  first.
- **`devcontainer.json` is JSONC.** The file VS Code generates opens with a
  comment, so `JSON.parse` fails on a large share of real configs. `stripJsonc`
  tracks string state rather than using a regex, because every image reference
  with a registry host in it contains `//`.
- **Matching a project to a container normalises the path; building a URI never
  does.** `comparableFolder` folds case and separators on Windows because the
  extension and the directory walk disagree about them. That is safe precisely
  because nothing is launched from the result — see the raw label rule above for
  the case where it would not be.

The panel offers and does not act. Opening the folder locally is a real button,
because the editor's own "Reopen in Container" prompt is the supported path;
building is a **copy** button for `devcontainer up`, because that command pulls
images and runs `postCreateCommand` out of whatever the user last cloned.

`folderUri` in `editor/uri.ts` builds the local-open URI, and the WSL arm is the
one that matters: a `file:` URI pointing at `\\wsl.localhost\Ubuntu\...` opens
the repo over 9P as a Windows share, with the wrong file modes and no Linux
toolchain. It emits `vscode-remote://wsl+Ubuntu/...` instead.

## Opening a terminal

"Open a shell in this container" is `docker exec -it <id> sh -c <bootstrap>
<script>` running inside a terminal window. Neither half is uniform, and the
assembly is pure — `src/main/terminal/command.ts` — with `launch.ts` doing
nothing but spawning the result.

**Which daemon.** boxwarden connects to _every_ engine that answers, and the
engine selection above narrows what it lists without reaching the CLI. So the
endpoint the container was last seen on becomes `-H unix://…` (or `--url` for
podman). Without it, `docker exec` on a machine with two engines reports "no
such container" for one that is plainly on screen. A socket inside a WSL distro
cannot be opened from Windows at all, so that arm runs
`wsl.exe -d <distro> --exec` and names the CLI bare, on the Linux side —
`--exec` and not `--`, for the reason in "The argv rule" below.

**The argv rule.** An argv array is only inert if every layer between here and
the container passes it along unchanged. On Linux and macOS that holds. On
Windows two layers rewrite it:

- **Windows Terminal** does not forward an argv. `wt new-tab a b c` JOINS the
  remaining arguments back into one command line, wrapping an argument in double
  quotes if it contains a space and doing nothing about the double quotes
  already inside it — so an argument holding `exec "${BASH:-sh}"` closes wt's
  quoting early and the rest is re-split by CreateProcess. `;` is separately
  wt's own subcommand separator.
- **`wsl.exe`** hands a command line to the distro's DEFAULT SHELL unless
  `--exec` is given, so the payload was parsed by bash on the Linux side before
  `docker` ever saw it.

So: **no element of the launch argv may contain a double quote, a newline or a
semicolon.** Spaces are fine — every layer handles those. The rule is kept by
ENCODING the script (base64, `encodeShellScript`) rather than by escaping it,
because escaping means modelling three parsers correctly and encoding means
modelling none. The bootstrap decodes it into a file inside the container and
runs `bash -l` on that; the script's first line removes the file again.

This is the second attempt at the same bug. The first — passing the script as
`$0` and re-execing `bash -lc "$0"` — was correct and never arrived, because
the BOOTSTRAP contained the double quotes, so it was the bootstrap that came
out mangled and `sh` ran the profile after all. The symptom was identical both
times: a terminal opened at `/` instead of the workspace, showing raw prompt
escape sequences. A property test now asserts the rule over the whole argv, on
every transport, with a hostile startup command in it.

**Which terminal, and how it wants to be told.** `terminal/targets.ts` is a
table of twelve emulators with three invocation styles:

| Style            | Example                           | What crosses                  |
| ---------------- | --------------------------------- | ----------------------------- |
| `argv`           | `gnome-terminal -- docker exec …` | argv elements, nothing parsed |
| `command-string` | `x-terminal-emulator -e "…"`      | one POSIX-quoted string       |
| `applescript`    | Terminal.app, iTerm2              | one string, quoted twice      |

`argv` is the default because it is structurally safe. The other two exist
because those emulators accept nothing else — Terminal.app and iTerm2 have no
command-line interface at all — and they are the reason `posixQuote` and
`appleScriptString` are pure functions with tests rather than template literals
at the call site. iTerm2 gets its own AppleScript dialect: 3.x dropped
`do script`, and sending it anyway compiles and silently does nothing.

The table is ordered by preference, and that ordering is load-bearing twice:
Terminal.app ships with macOS, so probing it before iTerm2 would leave iTerm2
permanently unreachable as a default; `x-terminal-emulator` and `xterm` are
always present on a Linux desktop, so they go last.

**Where the shell starts.** `docker exec` begins in the image's `WorkingDir`,
which for most base images is `/` — so a terminal opened on a workspace lands
nowhere near it. The script's first line is a `cd` to `workspaceFolder`, which
also means the startup command below runs from the workspace rather than from
the root.

It is a `cd` rather than `docker exec -w`, and that is the interesting choice.
`-w` is the tidier mechanism, but `workspaceFolder` is not always known: its
third source is the `/workspaces/<basename>` convention, i.e. a guess (see
`resolveWorkspaceFolder`). A `-w` at a path that does not exist makes the daemon
refuse the exec outright, and most emulators close the window of a command that
exited immediately — so clicking Terminal would appear to do nothing at all. A
`cd` that fails degrades to exactly the old behaviour, with one line on stderr
naming the folder it could not enter. The path is quoted like everything else
here, because it comes from a container label rather than from the user.

**The startup command.** A per-container command, run inside the container
before the interactive shell each time a terminal opens. It is deliberately
shell code — that is the feature — and it is deliberately shell code on the
_container's_ side of the boundary: it travels encoded, as a single argv
element, the whole way, and where an emulator forces it into a string, the
quoting above is what keeps it inert on the host. It is not backgrounded, so a dev server holds
the window and shows its output, and interrupting it lands in a shell rather
than closing the terminal.

It is stored by `containerSettingsKey`, which is the host folder rather than
the container id: rebuilding a dev container is the most common thing anyone
does to one, and it recreates the container under a new id. A startup command
that evaporates on rebuild is worse than none. Compose members append their
container name, since every service in a project shares one folder label. The
map lives in `preferences.json` beside the engine selection and the scan roots.

## Claude Code presence

A card says what the container _is_. It also says, when it can, what is
happening inside it — specifically whether a Claude Code session is running,
how many, and how long each has been up. Stopping a container out from under a
running agent is the failure this prevents, and "Stop all" on a compose group
is where it matters most, because that button reaches services whose own card
nobody looked at.

The detection is one read-only Docker call, `GET /containers/{id}/top`, and the
pure `parseClaudeProcesses` in `src/models/claude.ts` does everything else.
Four constraints fall out of that API and are the whole difficulty of the
feature:

- **`top` answers only for a live container.** Created, exited, dead and
  removing all error. Those map to a `not-applicable` arm, never to "no
  session" — a stopped container has no process table, which is not the same as
  an empty one.
- **The column layout differs between engines.** Docker's default is `ps -ef`
  (`UID PID PPID C STIME TTY TIME CMD`), Podman's is
  `USER PID PPID %CPU ELAPSED TTY TIME COMMAND`. The response carries `Titles`
  alongside `Processes`, and the parser finds every column **by title**.
  Indexing produces a parser that works on its author's machine and mislabels
  every session on someone else's.
- **`STIME` and `ELAPSED` are not the same quantity.** One is a wall-clock start
  time, the other a duration. They occupy separate fields on `ClaudeSession`,
  and the UI says "since 10:31" or "up 1h12m" accordingly.
- **The CLI is a Node process.** It appears as
  `node …/@anthropic-ai/claude-code/cli.js`, so matching on a process named
  `claude` misses the common case; matching any token containing "claude" fires
  on an ordinary `/workspaces/claude-notes` checkout. The rule is the package
  path, plus an executable whose basename is exactly `claude`.

An engine layout the parser cannot read becomes `{ kind: 'unknown', reason }`
and renders as a badge that says so. It deliberately does **not** collapse into
"nothing running": the absence of a badge is how a card says stopping is safe,
and "we could not tell" must not borrow that meaning.

Scope is presence, not activity. Working vs. idle vs. waiting on a permission
prompt would mean parsing session transcripts or the IDE lock files under the
container's `~/.claude`, neither of which is a versioned interface, and both of
which would need the container's home directory located first.

### Why it is its own verb, on its own clock

`claudeStatus(ids)` is batched and separate from `discover()` for the same
reason `scanProjects` is: cadence. Discovery polls every 5s; a `top` per live
container folded into it would multiply that poll's Docker traffic by the length
of the list, to re-derive an answer that changes when a person starts an agent.
`useClaudeStatus` runs at 15s instead, skips ticks while the window is hidden —
the discovery poll does not, because the container list is what a user comes
back to look at, whereas this exists to guard a click — and takes an immediate
reading when the window is shown again.

Ids are validated against the main process's own last container list before any
Docker call, the same rule as `openInEditor` taking an id rather than a
`DevContainer`.

## The workspace branch

Each card says which branch its workspace folder is checked out on. The answer
comes from the **host filesystem**, not from inside the container: a dev
container's workspace is a bind mount of `devcontainer.local_folder`, so the
checkout the container sees is the checkout on disk beside it. Two small file
reads, no Docker call, and an answer for a container that is stopped — which is
when "which branch was that one on?" is most often asked.

`docker exec git rev-parse` was the alternative and is worse in every direction:
it runs a program inside a container this app did not build, works only while
the container is running, and needs git installed in the image. Same trade as
`top` versus `exec` for Claude Code presence, one step further — here there is
nothing to call at all.

`src/models/git.ts` is the pure half: `parseGitHead` (a symbolic ref, or a
detached commit), `parseGitDirPointer` (the `gitdir:` file git writes for a
**worktree** — one worktree per agent is a common way to run several sessions
over one repository), and `readableHostFolder`, which answers where to look or
`undefined` when the folder belongs to another operating system.
`src/main/git/status.ts` does the file reads: walk up at most four levels
looking for a `.git`, follow the pointer if it is a file, read `HEAD`, and cap
the whole thing at two seconds so an unresponsive network share or a stopped
WSL distro degrades to "could not tell" instead of holding the batch open.

Four arms, and they do **not** collapse the way the Claude Code badge's do:

| Arm        | Means                              | Renders   |
| ---------- | ---------------------------------- | --------- |
| `branch`   | on a branch                        | the name  |
| `detached` | no branch checked out              | short sha |
| `none`     | that folder is not a git checkout  | nothing   |
| `unknown`  | we could not look, with the reason | nothing   |

`unknown` renders nothing where the Claude badge renders a question mark, and
the difference is the stake. That badge guards a click — a card with no badge is
a card saying stopping is safe — so "we could not tell" has to be visible. A
branch guards nothing, and `unknown` is the ordinary state of every card on a
machine where the folders are not visible: boxwarden running inside its own dev
container, a WSL path seen from macOS, a daemon reached over SSH. A chip on
every card, forever, on a machine where nothing is wrong is how a chip stops
being read.

`gitStatus(ids)` is batched, on a 30s clock, and takes **ids, never folders**.
That rule is sharper here than anywhere else in the IPC surface: what an id
resolves to is a path on the user's disk that this process then opens. The main
process reads only paths its own last scan produced, and reads each folder
**once** per batch — every service in a compose project carries the same label,
so a five-service workspace would otherwise stat one `.git` five times a poll.

## Checking for a new boxwarden

Once a day the main process asks GitHub for `/releases/latest`, compares it
against `app.getVersion()`, and — if there is something newer — says which file
this machine needs, links to it, and lists the steps to install it.

It CHECKS. It does not download and it does not install, and that is the whole
feature rather than the first stage of one.

The reason starts with a constraint that has always been true: it cannot swap
the application in place. `electron-updater` does exactly that and verifies a
CODE signature to decide it is safe; these builds have none, so Squirrel.Mac
would refuse the swap and everywhere else it would overwrite a binary the OS
never checked. See
[roadmap](./roadmap.md#6-packaging--signing-notarisation-updates).

Given that, an in-app download ends where a browser download ends — at an
installer the user runs and clicks through a Gatekeeper or SmartScreen warning.
boxwarden did have one, fetching the artefact and verifying it against
`sha256sums.txt` and a Sigstore bundle chained to a TUF-fetched trust root. It
was removed, and the reasoning is worth keeping because the feature looks
obviously worth having until you price it:

- The saving over the link was **one download in a browser**. Both paths end at
  the same installer and the same OS warning.
- The cost was three crypto dependencies in the main process, a BoringSSL
  compatibility shim (Electron's crypto cannot verify an EC signature without
  being told the digest, which Node's OpenSSL infers), and a hard runtime
  dependency on `tuf-repo-cdn.sigstore.dev` — a different host from GitHub, so a
  network that permits one may block the other.
- The failure mode was the wrong shape. Unable to reach the trust root, the app
  REFUSED to install and said so in words no user can distinguish from "this
  release is forged". An updater that works on some networks and cries tampering
  on others is worse than one that hands you a link.

Verification did not disappear; it moved out of the critical path. Every release
still carries `sha256sums.txt` and one `.sigstore.json` per artefact, and the
release notes carry the commands to check them. On a network that blocks
Sigstore, that costs a user one optional manual step instead of the entire
update path.

The way back is a code-signing certificate plus `electron-updater`, which does
the download, the verification and the swap together — not a hand-rolled fetch,
which is a worse version of what the certificate gives you outright.

The same shell-around-a-core split as everything else. `src/models/update.ts`
is pure and holds all of it — semver precedence, the GitHub payload parser, the
install-kind detection, the asset match and the per-platform instructions —
while the shell is split in two: `src/main/update/github.ts` makes the request
and is the only module here that imports Electron, and
`src/main/update/check.ts` holds the daily gate, the cache and the dismissal —
taking the fetch as a parameter, which is what lets it be tested without a
network.

Five things this feature will break on if they are forgotten:

- **A prerelease sorts BELOW the release it leads to.** Get that backwards and
  everyone on the final 1.2.0 is prompted to "update" to the candidate it
  replaced.
- **The install KIND decides the instructions, not the platform.** Linux ships
  as a deb that apt replaces in place and as an AppImage the user overwrites by
  hand. `detectInstallKind` reads the AppImage runtime's own `APPIMAGE`
  variable and the install prefix, and answers `linux-unknown` rather than
  guessing — telling somebody to `sudo apt install` a file they never
  downloaded is worse than saying nothing.
- **The x64 deb is `amd64`.** dpkg names packages with Debian's architecture
  and electron-builder follows it, while the x64 AppImage beside it has no
  architecture in its name at all. One token table covers both; a per-target
  regex is how the deb ends up unmatched.
- **Every URL in the response is checked against
  `https://github.com/sethcarney/boxwarden/releases/`, not against
  `github.com`.** `shell.openExternal` only checks the origin, so origin alone
  would accept a link to any other repository on the site. The same parser
  guards the copy remembered in `preferences.json`.
- **A failed check is not "up to date".** They are separate arms of
  `UpdateStatus` and they render differently, for the reason `ClaudeStatus`
  keeps `unknown` apart from `none`: an app that reports a check it could not
  complete as a clean bill of health is one nobody should believe the next
  time.

The check is skipped entirely when `app.isPackaged` is false, so development
runs and CI never contact GitHub. `BOXWARDEN_FAKE_UPDATE=1` serves an invented
release through the real folding, which is how the banner is worked on before
any release exists.

## Why containers are never dropped

A container whose label cannot be parsed still appears in the list — greyed,
dashed border, showing the raw label and the reason. A row that explains
itself is diagnosable; a container silently missing from the list produces a
bug report nobody can act on.

## Running inside a dev container

This repo's own devcontainer uses **docker-outside-of-docker**, so boxwarden
running inside it talks to the _host's_ daemon and sees the developer's real
containers. Two consequences:

1. Any path handed to the Docker API is interpreted by the host daemon. Paths
   inside this container are meaningless to it.
2. Containers stopped from the UI are the developer's actual containers.

Launching an editor is the part that does **not** work from inside the dev
container: resolution looks for `code` on the container's PATH, not the host's.
Opening a terminal fails the same way and for the same reason — it looks for a
terminal emulator on the container's PATH, and there is no display to open a
window on regardless. Use `BOXWARDEN_FAKE_DOCKER=1` for UI work, and run on the
host to exercise the real launch paths.

## Further reading

- [Electron security checklist, and where each item lands in this repo](./electron-security.md)
- [Development workflow](./development.md)
- [Roadmap and known gaps](./roadmap.md)
