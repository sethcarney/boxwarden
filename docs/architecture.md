# Architecture

boxwarden is an Electron desktop app that lists the dev containers running on
your machine and reattaches an editor to them.

```
┌── renderer (Chromium, sandboxed, no Node) ────────────────┐
│  React UI — src/renderer/                                  │
│  reaches exactly five functions on window.boxwarden        │
└───────────────────────┬────────────────────────────────────┘
                        │ contextBridge, structured clone
┌───────────────────────┴────────────────────────────────────┐
│  preload — src/preload/index.ts                            │
│  no logic, only ipcRenderer.invoke wrappers                │
└───────────────────────┬────────────────────────────────────┘
                        │ ipcMain.handle
┌───────────────────────┴────────────────────────────────────┐
│  main (Node) — src/main/                                   │
│    docker/   endpoint discovery, dockerode, inspect→domain │
│    editor/   binary resolution, URI building, spawn        │
│    ipc.ts    the five handlers, sender-validated           │
└────────────────────────────────────────────────────────────┘

  src/domain/   pure types, no I/O — shared by all three
  src/shared/   the IPC contract — shared by all three
```

## The layering rule

`src/domain/` holds types and pure functions and imports nothing. Everything
that touches the outside world lives in `src/main/` and is written as a thin
shell around a pure function:

| Impure edge | Pure core it wraps |
| --- | --- |
| `docker/client.ts` (dockerode) | `docker/mapping.ts`, `docker/host-path.ts` |
| `docker/client.ts` (probing) | `docker/endpoint.ts` |
| `editor/launch.ts` (spawn) | `editor/uri.ts` |
| `editor/resolve.ts` (fs, exec) | `editor/targets.ts` (data) |

That split is why the test suite needs no Docker daemon and no display: 66
tests cover the cores, and the shells are small enough to read.

## Two path spaces

The single most error-prone thing this app does is handle paths, because there
are two filesystems in play and they look alike:

- **Host paths** — what the developer's OS sees. `HostPath` in the domain,
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
   `Health`, which the domain's runtime union requires.
5. Map to `DevContainer` via the pure `mapContainer`.

Step 2 keeps every attempt because `DockerEnvironment.attempts` **is** the
diagnostics UI. Probing five sockets and reporting only "couldn't connect to
Docker" is what makes this class of tool infuriating; naming the socket that
was missing turns a support thread into a glance.

## Why containers are never dropped

A container whose label cannot be parsed still appears in the list — greyed,
dashed border, showing the raw label and the reason. A row that explains
itself is diagnosable; a container silently missing from the list produces a
bug report nobody can act on.

## Running inside a dev container

This repo's own devcontainer uses **docker-outside-of-docker**, so boxwarden
running inside it talks to the *host's* daemon and sees the developer's real
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
