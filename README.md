# boxwarden

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sethcarney/boxwarden/badge)](https://scorecard.dev/viewer/?uri=github.com/sethcarney/boxwarden)

Local dev container management. A desktop app that lists the dev containers on
your machine, reattaches your editor to them, and opens a shell inside them.

> **Status: working, and deliberately pre-1.0.** Everything below has been
> exercised on real machines — macOS, Linux and Windows, against real container
> engines, real editor installs and real terminal emulators — on top of 843 unit
> and component tests that run on every push.
>
> What is still missing is everything about _trusting_ a build somebody else
> made. The macOS and Windows installers are **not code-signed or notarised**,
> so each platform interposes on first launch, and only the x64 builds have been
> run — arm64 is packaged on every release and has never been launched. Those
> two, plus room for the interfaces to move, are what the `0.x` is for. See
> [docs/roadmap.md](docs/roadmap.md#what-has-been-verified).

## What it does

- Finds containers carrying the `devcontainer.local_folder` label — the ones
  created by the Dev Containers extension or the `devcontainer` CLI. Ordinary
  containers are deliberately not listed.
- Shows project name, host folder, image, state, health, and published vs.
  exposed-only ports.
- Groups Docker Compose projects, so stopping a workspace does not leave its
  database running.
- Starts and stops them, individually or per project.
- Shows the **branch each workspace is on**, read from the checkout on your own
  disk — so a row of cards from the same repository is not four identical names.
- Flags containers with a **Claude Code session running inside**, and says so on
  the Stop button — so stopping one out from under an agent mid-task is a
  deliberate act rather than an accident.
- Opens them in VS Code, VS Code Insiders, Cursor, or Windsurf — with a
  copyable URI fallback when launching fails.
- Says which of those is **already attached**, with that editor's own mark, and
  turns the button into **Focus** with a quieter **New window** beside it. The
  Stop button says so too: an agent is _ended_ by stopping a container, a window
  is _stranded_ by it.
- Opens a shell inside a running container, in your own terminal emulator —
  Terminal.app, iTerm2, GNOME Terminal, Konsole, kitty, WezTerm, Alacritty,
  Windows Terminal and others — with a copyable `docker exec` line when
  launching fails.
- Remembers a **startup command** per container, run inside it before the
  interactive shell each time you open a terminal. Stored against the host
  folder, so it survives a rebuild.
- **Finds the ones you have not built yet.** A container only exists after
  someone builds it, so a machine full of freshly cloned repos looks empty.
  boxwarden also scans your folders for `devcontainer.json`, lists the projects
  no container claims, and opens the folder so your editor can offer "Reopen in
  Container". Where it looks is up to you — add a folder from the panel.
- Connects to **every** container engine that answers — Docker Desktop,
  OrbStack, Colima, Rancher Desktop, rootless Docker, Podman, including Podman
  inside a WSL distro — and merges their lists. A picker appears once two are
  reachable.
- When one cannot be reached, names every socket it tried and why each one
  failed — rather than a bare "couldn't connect" — and, where it can, the exact
  command that fixes it. A **Setup** tab keeps that inventory and every
  advisory, including ones you have hidden from the main screen.

## Install it

Grab an installer from [the latest release](https://github.com/sethcarney/boxwarden/releases/latest)
— a dmg for macOS, an AppImage and a deb for Linux, an NSIS installer for
Windows, x64 and arm64 for each. On Debian and Ubuntu prefer the deb: its
post-install script sets up `chrome-sandbox` and installs the AppArmor profile
Ubuntu 24.04 needs, neither of which an AppImage can do.

Every artefact is cosign-signed and the set carries SLSA provenance —
[SECURITY.md](SECURITY.md#release-verification) has the commands. That is **not**
the same thing as a code signature, though, and boxwarden has none: each platform
will interpose on first launch — right-click _Open_ on macOS, _More info_ → _Run
anyway_ on Windows. [Why the two are different.](SECURITY.md#what-signing-does-not-do)

Once installed, boxwarden checks GitHub once a day for a newer release and tells
you how to install it on the platform and install kind you are actually on. It
does not download or install anything itself, and the check can be turned off
from the footer — it is the only outbound request the app makes.
[The running guide](docs/running.md#3-installing-it-on-your-computer) walks
through all of that, and through uninstalling again.

## Run it from source

```bash
bun install
bun run dev
```

No Docker, or Docker is broken, or you are working on the UI? Run against
fixtures — six containers covering the cases least likely to be on your own
machine:

```bash
bun run dev:fake
```

`bun run dist` builds installers for the host OS into `release/`;
[the release guide](docs/releasing.md) covers cutting a real one.

## Work on it in its own dev container

```bash
bun run devcontainer:open
```

`devcontainer up` to build and start it, then `code --folder-uri` to attach —
the same `vscode-remote://` URI the app's own Open button builds. Add
`-- --editor cursor` for a fork, or `-- --print` to see the URI instead of
launching. [Details](docs/running.md#1-the-dev-container-from-the-command-line).

## Docs

|                                                |                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| [Running](docs/running.md)                     | The dev container from the CLI, development on the host, installing |
| [Releasing](docs/releasing.md)                 | Cutting a version: the tag, the workflow, the draft                 |
| [Architecture](docs/architecture.md)           | Process model, the two path spaces, why the raw label matters       |
| [Electron security](docs/electron-security.md) | The upstream checklist and where each item lands here               |
| [Supply chain](docs/supply-chain.md)           | Scorecard, signed releases, and the GitHub settings that bind them  |
| [Development](docs/development.md)             | Commands, fixtures, the two TS projects, testing                    |
| [Roadmap](docs/roadmap.md)                     | What is verified, what is not, and what to build next               |

## Licence

MIT.
