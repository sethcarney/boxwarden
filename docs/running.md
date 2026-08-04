# Running boxwarden

Three ways to run it. They are not alternatives to each other — they answer
different questions, and most people end up using at least two.

| Mode                                                                            | What it gives you                                                      | Use it when                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| [Development, on the host](#2-development-on-the-host)                          | HMR, the real Docker daemon, real editors — everything the app touches | Changing the app                            |
| [Development, in the dev container](#1-the-dev-container-from-the-command-line) | The pinned toolchain, tests, lint. **No GUI, no editor launching.**    | Running checks, or a machine you keep clean |
| [An installed build](#3-installing-it-on-your-computer)                         | A normal desktop app in the dock, no terminal involved                 | Actually using it day to day                |

The dev container comes first because that is the shortest path from a clean
checkout to a working toolchain, and because it is the part with a CLI worth
knowing.

## Prerequisites

- **A container runtime.** Docker Engine, Docker Desktop, OrbStack, Colima,
  Rancher Desktop, or Podman. boxwarden probes for all of them; see
  `src/main/docker/endpoint.ts` for the order. Podman needs a little setup —
  [development.md](./development.md#podman-and-rootless-docker-hosts).
- **Node 22 and Bun**, for the host path. The dev container provides both.
- **VS Code** (or Insiders, Cursor, Windsurf) for anything involving an editor.

---

## 1. The dev container, from the command line

Two CLIs, doing two different jobs. Neither can do the other's:

| CLI            | Job                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `devcontainer` | Build and start a container from `.devcontainer/`, and tell you where the workspace landed inside it |
| `code`         | Attach an editor window to a container that already exists                                           |

Install them once:

```bash
npm i -g @devcontainers/cli        # or: bun add -g @devcontainers/cli
code --version                     # macOS: run "Shell Command: Install 'code' command in PATH" first
```

### The one command

```bash
bun run devcontainer:open
```

That is `scripts/devcontainer-open.mjs`, and it does four things:

1. `devcontainer up --workspace-folder .` — builds the image if needed, starts
   the container, runs `post-create.sh`. Idempotent: on an already-running
   container it returns the existing one in a second or two.
2. Reads `remoteWorkspaceFolder` out of that command's JSON result, rather than
   assuming `/workspaces/boxwarden`. The default only holds while
   `devcontainer.json` does not say otherwise.
3. Reads the `devcontainer.local_folder` label back off the container, so the
   URI is built from the string the tooling actually recorded — see
   [the raw label rule](./architecture.md#the-raw-label-rule) for why that
   distinction is the difference between reattaching and being offered a new
   container.
4. `code --folder-uri vscode-remote://dev-container+<hex>/workspaces/boxwarden`.

Options:

```bash
bun run devcontainer:open -- --editor cursor        # or code-insiders, windsurf
bun run devcontainer:open -- --print                # print the URI, launch nothing
bun run devcontainer:open -- --workspace-folder ~/code/other-repo
```

`--print` is the one to reach for when a window opens on the wrong thing: it
gives you the exact URI to inspect, paste, or hand to a different editor.

### The same thing by hand

Worth doing once, because it makes the shape of the URI obvious:

```bash
devcontainer up --workspace-folder .
# ...
# {"outcome":"success","containerId":"9d2f...","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/boxwarden"}

code --folder-uri "vscode-remote://dev-container+$(printf %s "$PWD" | od -An -tx1 | tr -d ' \n')/workspaces/boxwarden"
```

The authority is hex-encoded UTF-8 of the **host** folder path — an encoding,
not a hash, which is why the same folder always produces the same authority and
why VS Code can find the window that already has it open. Decode any URI you are
suspicious of:

```bash
python3 -c "import sys,binascii; print(binascii.unhexlify(sys.argv[1]).decode())" <hex>
```

### Running commands without opening a window

```bash
devcontainer exec --workspace-folder . bun run check
devcontainer exec --workspace-folder . bun run test
```

This is the CI-shaped way to use the container: no editor, no GUI, exit code
straight back to your shell.

### What works in there, and what does not

The container uses **docker-outside-of-docker**, so it is bind-mounted onto the
host's container runtime and sees the developer's real dev containers. The main
process, the Docker code, and the whole test suite behave as they would on the
host.

Two things deliberately do not work:

- **The Electron GUI.** No X11 or Wayland forwarding is configured — see the
  closing comment in `devcontainer.json`. `bun run dev` inside the container
  starts Vite and then fails to open a window.
- **Opening an editor.** `editor/resolve.ts` looks for `code` on the
  _container's_ PATH. Even if it found one, the window would be attached to the
  wrong machine.

So: checks and main-process work inside, GUI work on the host. Which is the
next section.

---

## 2. Development on the host

```bash
bun install          # electron's postinstall fetches a ~100MB binary
bun run dev
```

`bun run dev` starts electron-vite: the renderer hot-reloads, and edits to main
or preload restart the Electron process. What you should see is a window
listing the dev containers on your machine — including, if you started it that
way, the one you are editing in.

No Docker, or Docker is broken, or you are working on the UI:

```bash
bun run dev:fake     # BOXWARDEN_FAKE_DOCKER=1 — six fixture containers
```

The main process logs a loud warning when fixtures are on. A fake container list
the user believes is real is the worst failure this app has.

Bun is the package manager and script runner only, never the runtime —
[development.md](./development.md) explains why that is not revisitable, and
lists the rest of the commands.

---

## 3. Installing it on your computer

### Download one

[The releases page](https://github.com/sethcarney/boxwarden/releases) carries
an installer for each platform, built by
[the release workflow](../.github/workflows/release.yml) on the OS it targets.
Take the one for your machine and skip to [Install it](#install-it) — the
caveats there apply exactly the same, because these are the same artefacts
`bun run dist` produces locally.

There are no releases yet; v1 is the first. [releasing.md](./releasing.md) is
how one gets cut.

### Build the installers

```bash
bun run dist          # host OS, every configured target
bun run dist:mac      # or :linux, or :win
bun run package       # unpacked directory only — no installer, fastest way to check a build
```

Each of those runs `electron-vite build` first, then electron-builder over the
result. Configuration is `electron-builder.yml`; artefacts land in `release/`,
which is gitignored.

**Cross-building mostly does not work.** A dmg needs macOS. An NSIS installer
built off Windows needs Wine. Linux targets build on Linux. Build on the OS you
are targeting, or in CI on that OS.

| OS      | Artefacts in `release/`                                                      |
| ------- | ---------------------------------------------------------------------------- |
| macOS   | `boxwarden-<version>.dmg`, `-arm64.dmg`, matching `.zip`s                    |
| Linux   | `boxwarden-<version>.AppImage`, `boxwarden_<version>_amd64.deb` (plus arm64) |
| Windows | `boxwarden Setup <version>.exe`                                              |

### Install it

**macOS.** Open the dmg, drag boxwarden to Applications. The build is
**unsigned and un-notarised** unless you have a Developer ID in your keychain,
so Gatekeeper will refuse it on first launch — "boxwarden is damaged" or
"cannot be opened because the developer cannot be verified". Right-click the app
and choose _Open_, or:

```bash
xattr -dr com.apple.quarantine /Applications/boxwarden.app
```

Do that only for a build you produced yourself. It is exactly the step you
should be suspicious of when a stranger tells you to run it.

**Linux — prefer the `.deb`** on Debian and Ubuntu:

```bash
sudo apt install ./release/boxwarden_0.0.0_amd64.deb
```

The deb's post-install script does two things the AppImage cannot: it sets up
`chrome-sandbox` correctly for kernels without unprivileged user namespaces, and
it installs an AppArmor profile for Ubuntu 24.04, which otherwise blocks
Chromium's sandbox. boxwarden calls `app.enableSandbox()` and has no
`--no-sandbox` escape hatch, so on Ubuntu 24.04 the AppImage may refuse to
start with a message about the SUID sandbox helper. The AppImage is there for
distributions where nothing installs anything:

```bash
chmod +x release/boxwarden-0.0.0.AppImage
./release/boxwarden-0.0.0.AppImage
```

**Windows.** Run `boxwarden Setup <version>.exe`. It is a per-user install, so
no UAC prompt and no admin rights, and it lets you choose the directory. The
build is unsigned, so SmartScreen will interpose — _More info_ → _Run anyway_.

### Uninstall

| OS      |                                                     |
| ------- | --------------------------------------------------- |
| macOS   | Delete `/Applications/boxwarden.app`                |
| Linux   | `sudo apt remove boxwarden`, or delete the AppImage |
| Windows | Settings → Apps → boxwarden → Uninstall             |

### Updates

boxwarden asks GitHub once a day whether a newer release exists. When there is
one it says so, above the container list, with the exact file for the platform
and install kind you are on and the command to install it — `sudo apt install
./boxwarden_<version>_amd64.deb` for the deb, `chmod +x` for the AppImage, drag
to Applications for the dmg, run the installer for Windows.

It can also **fetch the file for you and check it**: the download is verified
against the release's `sha256sums.txt` and against the cosign signature beside
it, whose certificate has to name this repository's release workflow at that
exact tag. Only then does the Install button appear, and all it does is hand the
file to your operating system's installer — you still complete the install.

What it does **not** do is replace its own application bundle, and it will not
while the builds carry no CODE signature: Squirrel.Mac refuses an unsigned swap
outright, and everywhere else it would mean overwriting a binary on the strength
of a download the OS never checked. The one exception is the AppImage, which is
a single file you own — there boxwarden replaces the file and relaunches, after
the same two checks.

If a release is missing its signature or its checksum manifest, boxwarden
refuses to download it and points you at the release page instead.

Two controls, both in the footer line that names your version:

- **Not now** on the banner hides it for that version. The footer still says the
  update exists, and clicking the footer brings the banner back.
- **Stop checking for updates** turns the daily check off for good. It is the
  only outbound network request boxwarden makes, so if you would rather it made
  none, that is the switch. The footer then reads `update checks off`, and
  clicking it turns them back on and looks straight away.

The check is skipped entirely in a development build (`bun run dev`), where
there is no released version to compare against.

---

## First run

You should get a window listing every container carrying the
`devcontainer.local_folder` label, running ones first, compose projects framed
as a group. If that is not what you see:

Before working down this table, read the advice panels at the top of the
window. They are generated from what discovery actually found and are more
specific than anything here — including the exact command to run.

Each panel folds shut by clicking its title, and **Hide** takes one off this
screen for good. Nothing is lost that way: the **Setup** tab in the header
lists every advisory, hidden ones included, alongside the full list of sockets
boxwarden tried on the last scan — which is the place to look when one of two
engines is missing from an otherwise working app. "Show all again" there puts
everything back.

| Symptom                                                     | What it means                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| "Can't reach a container engine", with a list of sockets    | Nothing answered. The panel names every socket tried and why each failed; the advice above it says what to install or start.               |
| Empty list, engine fine                                     | You have no dev containers, or none are labelled. Ordinary containers are deliberately not listed.                                         |
| Empty list, and the engine picker is set to one engine      | That is the selection doing its job. Switch it back to "All engines" — if the engine has stopped answering, an advisory says so.           |
| On Windows, a WSL distro's containers are missing           | Almost always socat, the relay boxwarden needs to reach into a distro. The advisory names the distro and the install command.              |
| Every editor shows "(not found)"                            | No editor CLI resolved. On macOS run "Shell Command: Install 'code' command in PATH"; see `src/main/editor/targets.ts` for what is probed. |
| Open works, but VS Code offers to build a **new** container | The URI's host path does not match the label byte for byte. `bun run devcontainer:open -- --print` shows you what it should be.            |
| A greyed, dashed row                                        | That container's label could not be parsed. The row shows the raw label and the reason; it is kept rather than dropped on purpose.         |
| Podman, and nothing appears                                 | [development.md](./development.md#podman-and-rootless-docker-hosts).                                                                       |

### Choosing an engine

By default boxwarden connects to **every** container engine it can reach and
merges their container lists, deduplicating by container id. On a machine with
one engine you will never notice; on Windows, where a podman machine behind a
named pipe plus a rootless podman inside a WSL distro is an ordinary setup, it
is the difference between seeing your containers and not.

Once two engines answer, an **Engine** picker appears in the header. Narrowing
to one restricts the list, and start/stop/open with it. The choice is saved
between runs.

## What has actually been verified

The packaged Linux build has been run headlessly against fixtures and renders
the full list correctly — asar, sandboxed preload, IPC and all. The build,
the installers and the deb's control scripts have been inspected.

Not verified, because the machine this was built on has no Docker socket and no
editor installed: discovery against a real daemon, whether the
`vscode-remote://` URI reattaches rather than offering to build, and editor
binary resolution on any OS. Signing and notarisation are not configured at
all, and the update check has never seen a real release — there are none yet.
[roadmap.md](./roadmap.md) is the honest list.

The engine picker and the setup advice are unit-tested and exercised against
the fixtures, which is a real bar — the advice engine is pure, so every branch
of it is covered — but the Windows-specific probes underneath them are not.
`wsl --status` as the "is WSL installed" signal, and the exact behaviour of
`wsl --list --quiet` on a machine with no distribution, have been reasoned
about and not observed. Both are in `src/main/docker/wsl.ts` and both need a
real Windows machine to confirm.
