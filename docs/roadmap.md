# Roadmap

What the MVP does, what it does not, and what to build next. Ordered by what
unblocks the most.

## What works today

- Discovers dev containers on the local daemon by the
  `devcontainer.local_folder` label.
- Lists them with project name, host path, image, state, health, and published
  vs. exposed-only ports. Running first, then alphabetical.
- Start and stop.
- Open in VS Code / Insiders / Cursor / Windsurf via `vscode-remote://`.
- A diagnostics screen naming every socket that was tried and why each failed.
- Polls every 5s; actions re-read from Docker rather than patching optimistically.

## Verified and unverified

Verified here: the build, 66 unit tests, typecheck across both TS projects, and
a headless launch under `xvfb` against `BOXWARDEN_FAKE_DOCKER=1` — 6 cards
rendered, preload bridge live, IPC round-tripped, ports and compose tag correct.

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
insurance: every VS Code fork is *expected* to use `vscode-remote` and
`--folder-uri`, but Cursor and Windsurf have not been checked against a real
install. Confirm empirically. **If neither diverges, delete both fields** —
they are speculative generality until proven otherwise.

## 3. WSL host paths

`parseLocalFolder` cannot distinguish a native Linux path from a path inside a
WSL distro seen from a VS Code instance running in WSL: the label is identical
(`/home/me/proj`) and nothing else in the inspect output disambiguates it.

The domain already models this (`HostPath`'s `wsl` arm requires `distro`, so
the type refuses to hold a half-built WSL path). What is missing is resolution.
Planned order:

1. Container bind-mount source — the `Mounts` array often reveals the real host
   path.
2. Match against `wsl -l -q`.
3. Prompt once and cache.

When every strategy fails the path stays `unresolved`, never a guess.

## 4. Compose grouping

`DevContainerLabels.composeProject` is captured and shown as a tag, but actions
still operate on single containers — stopping a compose-based dev container
leaves its database sibling running. Group rows by project and act on the
group. The domain was shaped to allow this without a type change.

## 5. Replace polling with an event stream

The 5s poll is fine for a handful of containers and wasteful for a daemon with
hundreds. Docker's `/events` endpoint (`docker.getEvents()`) gives
start/stop/die/destroy pushes. Keep a slow poll as a reconciliation backstop —
event streams drop.

## 6. Rebuild and create

Needs `@devcontainers/cli`, which shells out to the `docker` binary. This is
exactly why `DockerEnvironment` probes the API and the CLI **separately** —
`api.ok` gates today's features, `cli.ok` gates these. The diagnostics panel
already reports CLI absence.

## 7. Packaging

`electron-builder` is not wired up; there is no distributable. Needs ASAR
integrity, code signing and notarisation on macOS, and an auto-update story or
an explicit decision not to have one.

## 8. Renderer tests

The pure layer is well covered; the components are not tested at all. Add
`@testing-library/react` with `vitest`'s `jsdom` environment. Highest-value
cases: the degraded row for an unresolved path, the disabled "Open" button with
its reason, and the diagnostics panel listing every attempt.

## 9. Lint and format

`.devcontainer/devcontainer.json` configures the ESLint and Prettier
extensions, and `editor.codeActionsOnSave` runs `source.fixAll.eslint` — but
**neither tool is installed and neither has a config file**. The editor
settings are currently inert. Add `eslint.config.js` (flat config, per
`eslint.useFlatConfig`) and `.prettierrc`, then wire both into `bun run check`.

## 10. Smaller things

- **Copy the URI** as a fallback when launching fails. `OpenInEditorResult`
  already carries `uri` on the failure arm for exactly this.
- **Attached containers.** Containers attached to rather than created by the
  extension use a different authority (`attached-container+<hex of JSON>`).
  Not handled.
- **Remote daemons.** `DockerTransport` models tcp and ssh and `parseDockerHost`
  parses them, but the host paths on a remote daemon belong to the remote
  machine — the editor URI would point at folders that do not exist locally.
  Either detect and disable opening, or say what it means.
- **`docker context`.** Only `DOCKER_HOST` and well-known sockets are read.
  Users who switch contexts with `docker context use` are not followed.
- **Accessibility.** No keyboard shortcuts, no focus management, no screen
  reader pass.
- **Window state.** Size and position are not persisted.
