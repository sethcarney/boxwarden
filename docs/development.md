# Development

How the pieces fit and why they are the way they are. For getting the thing
_running_ — opening the dev container from a terminal, developing on the host,
building and installing it — see [running.md](./running.md).

## Prerequisites

Node 22 and Bun. Both are provided by the dev container
(`.devcontainer/devcontainer.json`); on the host, match the versions pinned
there.

Bun is the package manager and script runner **only** — it is never the
runtime. Electron ships its own Node inside Chromium and executes main and
renderer code in _that_ interpreter; `bun run dev` merely spawns the electron
binary. See the long comment in `devcontainer.json` for why this is not a
preference that can be revisited.

## Podman and rootless Docker hosts

The dev container bind-mounts the host's container-runtime socket in
(docker-outside-of-docker — see `devcontainer.json` for why it is not
docker-in-docker). The feature hardcodes the **host** side of that mount to
`/var/run/docker.sock`, which does not exist when the runtime is rootless:

| Host runtime                   | Socket                                |
| ------------------------------ | ------------------------------------- |
| Docker Engine (rootful)        | `/var/run/docker.sock` — the default  |
| Docker Desktop (incl. Windows) | `/var/run/docker.sock` via its shim   |
| Podman (rootless, the default) | `$XDG_RUNTIME_DIR/podman/podman.sock` |
| Docker rootless mode           | `$XDG_RUNTIME_DIR/docker.sock`        |

`devcontainer.json` restates the mount so the host path can be redirected with
`BOXWARDEN_DOCKER_SOCKET`. For rootless Podman on WSL or Linux:

```bash
systemctl --user enable --now podman.socket        # creates the socket
ls -l "${XDG_RUNTIME_DIR}/podman/podman.sock"      # confirm it exists

echo 'export BOXWARDEN_DOCKER_SOCKET="${XDG_RUNTIME_DIR}/podman/podman.sock"' >> ~/.bashrc
```

The variable is read from the environment of whatever launched the editor, not
from inside the container, so it has to be exported **before** the editor's
server starts. Reopening the window is usually enough; if the variable is still
unset, the WSL server is holding the old environment — `wsl --shutdown` from
Windows (or restarting VS Code entirely) picks it up. `env | grep BOXWARDEN` in
a VS Code terminal on the host side is the quick way to tell.

Unset it to go back to Docker; do not set it to the empty string. The CLI's
default only applies when the variable is _absent_, and an empty value expands
to an empty mount source.

Podman also needs, in VS Code settings:

```json
"dev.containers.dockerPath": "podman",
"dev.containers.dockerComposePath": "podman-compose"
```

`--userns=keep-id` and `--security-opt label=disable` are added by the Dev
Containers extension itself when the runtime is Podman on Linux; they do not
belong in this repo's config.

**What the failure looks like if the socket is wrong.** The image builds fine
and then the container exits during startup, so the error arrives at the very
end of a run that looked healthy:

```
Error: Command failed: podman run ... --entrypoint /bin/sh <image> -c echo Container started
Exit code 1
```

The feature's entrypoint (`/usr/local/share/docker-init.sh`) runs
`stat -c '%g' /var/run/docker-host.sock` under `set -e` to find the socket's
group, and nothing at that path kills the entrypoint before it ever reaches
`exec "$@"` — which is why the message names the container command rather than
the socket. Scroll **up** in the Dev Containers log for the real line: either a
`stat` error, or a mount error from Podman about the missing source.

Two related notes for Podman specifically. Under `--userns=keep-id` a
newly-created named volume can come up root-owned, which is what the
writability reclaim at the top of `post-create.sh` is for. And whichever socket
gets mounted is the one the app itself talks to, so on a Podman host boxwarden
is exercising Podman's Docker-compatible API — `endpoint.ts` already probes
`$XDG_RUNTIME_DIR/podman/podman.sock`, so this is a supported configuration
rather than a workaround.

`bun run check:devcontainer` asserts the mount is still present and still
parameterized.

## Commands

```bash
bun install          # electron's postinstall downloads a ~100MB binary
bun run dev          # electron-vite dev server, HMR on the renderer
bun run dev:fake     # same, against fixtures instead of a real daemon
bun run build        # bundles main, preload, renderer into out/
bun run start        # preview the production build
bun run test         # vitest, no Docker or display required
bun run typecheck    # both halves — node and web configs
bun run lint         # eslint, type-aware
bun run format       # prettier --write
bun run check        # typecheck + lint + format + test + devcontainer assertions

bun run package      # build + electron-builder --dir: an unpacked app, no installer
bun run dist         # build + installers for the host OS, into release/
bun run dist:mac     # ...or :linux, or :win

bun run devcontainer:open   # devcontainer up, then attach an editor to it
```

The last four are covered in [running.md](./running.md); `electron-builder.yml`
is where the packaging decisions live.

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

| Fixture          | What it exercises                                                      |
| ---------------- | ---------------------------------------------------------------------- |
| `webapp`         | Running, healthy, one published and one unpublished port               |
| `api-service`    | Cleanly exited                                                         |
| `platform`       | Compose-managed — the `compose` tag                                    |
| `reporting-tool` | Windows host path, no `WorkingDir` → `/workspaces/<basename>` fallback |
| `legacy-thing`   | Unparseable label → degraded row, exit code 137                        |
| `infra-scripts`  | Paused, WSL UNC path                                                   |

The fake also reports **three** reachable engines (a Docker socket, a podman
machine pipe, and a podman inside a WSL distro) and a WSL status with one distro
missing socat. The fixtures round-robin across those engines, so the engine
picker visibly filters the list rather than being a setting with no observable
effect.

That is deliberately the awkward arrangement rather than the tidy one: the
engine picker and every WSL advisory were otherwise unreachable without owning a
Windows machine in a particular state of disrepair, and those are exactly the
screens that have to be right for a user whose setup does not work.

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
_absent key_, not `undefined`. Hence the conditional spreads throughout
`mapping.ts` and `endpoint.ts`:

```ts
...(health === undefined ? {} : { health }),
```

## Testing

`vitest run`. The suite covers the pure layer — label parsing, inspect
mapping, URI construction, endpoint ordering, display formatting — so it needs
neither a daemon nor a display and runs anywhere.

The one impure exception is `src/main/projects/scan.test.ts`, which builds a
tree of `.devcontainer` directories under `mkdtemp` and removes it afterwards.
The rule the suite keeps is "no daemon and no display", not "no filesystem",
and a directory walk is precisely the code whose bugs — a depth limit off by
one, a `.devcontainer/<variant>/` silently dropped, `node_modules` walked into
— appear nowhere but against a real filesystem.

Functions that would otherwise read the clock take `now` as a parameter
(`relativeTime`, `statusLabel`), and platform-dependent functions take
`platform`/`homedir` as parameters (`candidateEndpoints`). Both are so that
tests assert on fixed values instead of freezing globals.

Component tests opt into jsdom per file with a docblock:

```ts
// @vitest-environment jsdom
```

Per-file rather than a glob because jsdom costs about a second of setup, and
paying it on every mapping test would triple the suite's runtime for nothing.

`src/renderer/test-fixtures.ts` builds `DevContainer` values directly rather
than running `mapContainer` over inspect JSON. That is deliberate: the mapper
lives in `src/main`, which the renderer's tsconfig does not include, and
reaching across that boundary in a test would quietly undo the separation the
two TypeScript projects exist to enforce.

## Verifying the UI headlessly

The app was smoke-tested in CI-like conditions with `xvfb-run` plus a
screenshot capture. Two gotchas if you repeat it:

- `app.enableSandbox()` means `--no-sandbox` is refused, so the app **cannot
  run as root**. Run as an unprivileged user and ensure
  `node_modules/electron/dist/chrome-sandbox` is `root:root` mode `4755`.
- Electron needs a D-Bus session for some subsystems; the errors it logs
  without one are noise, not failures.

## Linting

ESLint runs with type-aware rules (`strictTypeChecked` +
`stylisticTypeChecked`). The rules that earn their keep in an app that is
mostly async I/O are `no-floating-promises` and `no-misused-promises`;
`void somePromise()` is the intended way to say "fire and forget on purpose".

Config splits by environment the same way the tsconfigs do, so a stray
`document` in main-process code is an error rather than something that
typechecks and crashes at runtime.

Four rules are deliberately relaxed, each with the reason inline in
`eslint.config.js`: `restrict-template-expressions` allows numbers,
`no-confusing-void-expression` allows arrow shorthand, `dot-notation` allows
index-signature access (`process.env['FOO']`), and
`switch-exhaustiveness-check` accepts a `default` as covering a union.

## Before committing

```bash
bun run check
```
