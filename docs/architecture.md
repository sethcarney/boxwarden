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
│  reaches exactly ten functions on window.boxwarden         │
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
│    ipc.ts     the ten handlers, sender-validated           │
└────────────────────────────────────────────────────────────┘

  src/models/   pure types, no I/O — shared by all three
  src/shared/   the IPC contract — shared by all three
```

## The layering rule

### 1. The Model is pure at its core

`src/models/` holds types and pure functions and imports nothing. Everything
that touches the outside world lives in `src/main/` and is written as a thin
shell around a pure function:

| Impure edge                    | Pure core it wraps                         |
| ------------------------------ | ------------------------------------------ |
| `docker/client.ts` (dockerode) | `docker/mapping.ts`, `docker/host-path.ts` |
| `docker/client.ts` (probing)   | `docker/endpoint.ts`                       |
| `editor/launch.ts` (spawn)     | `editor/uri.ts`                            |
| `editor/resolve.ts` (fs, exec) | `editor/targets.ts` (data)                 |
| `projects/scan.ts` (fs walk)   | `models/project.ts`                        |

That split is why the test suite needs no Docker daemon and no display: the
cores are covered by unit tests, and the shells are small enough to read.

`projects/scan.ts` is the one shell with tests of its own, against a temp
directory. The rule the suite keeps is "no daemon and no display", not "no
filesystem", and a directory walk's bugs — a depth limit off by one, a
`.devcontainer` variant silently dropped — do not appear anywhere else.

### 2. A ViewModel renders nothing

No module in `src/renderer/viewmodels/` imports `react-dom` or returns JSX.
They are React hooks — the idiomatic ViewModel in a function-component
codebase — and they hold every piece of state the UI has, every command it can
issue, and every value derived from the two.

`useAppViewModel()` composes five, kept apart because their lifetimes differ:

| Hook           | Owns                                               | Cadence           |
| -------------- | -------------------------------------------------- | ----------------- |
| `useDiscovery` | snapshot, busy set, start/stop/open, engine choice | polled every 5s   |
| `useProjects`  | scan, roots, unbuilt/built partition               | on open, on ask   |
| `useEditors`   | installed editors, the chosen one                  | read once         |
| `useNotices`   | the message bar and the copyable failed URI        | event-driven      |
| `useTheme`     | layout + theme, persisted to localStorage          | never touches IPC |

Plus two small ones — `useClock` (one timer for every relative timestamp on
screen) and `useCopyToClipboard` (a write that can be refused, and a timer that
must be cancelled on unmount).

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
about correctness depends on it.

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
  than adding a `startMany` channel. The IPC surface stays six narrow verbs,
  and a project is a handful of containers so the round trips do not matter.
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
container: `editor/resolve.ts` looks for `code` on the container's PATH, not
the host's. Use `BOXWARDEN_FAKE_DOCKER=1` for UI work, and run on the host to
exercise the real open-in-editor path.

## Further reading

- [Electron security checklist, and where each item lands in this repo](./electron-security.md)
- [Development workflow](./development.md)
- [Roadmap and known gaps](./roadmap.md)
