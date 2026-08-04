# boxwarden

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sethcarney/boxwarden/badge)](https://scorecard.dev/viewer/?uri=github.com/sethcarney/boxwarden)

Local dev container management. A desktop app that lists the dev containers on
your machine, reattaches your editor to them, and opens a shell inside them.

> **Status: early MVP.** Discovery, start/stop, open-in-editor and
> open-a-terminal are implemented and unit-tested, and the UI has been verified
> end to end against fixtures. They have **not** yet been run against a real
> Docker daemon, a real editor install, or a real terminal emulator on macOS or
> Windows — see [docs/roadmap.md](docs/roadmap.md#verified-and-unverified).

## What it does

- Finds containers carrying the `devcontainer.local_folder` label — the ones
  created by the Dev Containers extension or the `devcontainer` CLI. Ordinary
  containers are deliberately not listed.
- Shows project name, host folder, image, state, health, and published vs.
  exposed-only ports.
- Groups Docker Compose projects, so stopping a workspace does not leave its
  database running.
- Starts and stops them, individually or per project.
- Flags containers with a **Claude Code session running inside**, and says so on
  the Stop button — so stopping one out from under an agent mid-task is a
  deliberate act rather than an accident.
- Opens them in VS Code, VS Code Insiders, Cursor, or Windsurf — with a
  copyable URI fallback when launching fails.
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
- When Docker cannot be reached, names every socket it tried and why each one
  failed — rather than a bare "couldn't connect".

## Quick start

```bash
bun install
bun run dev
```

No Docker, or Docker is broken? Run against fixtures:

```bash
bun run dev:fake
```

## Install it

Grab an installer from [the releases page](https://github.com/sethcarney/boxwarden/releases)
— a dmg for macOS, an AppImage and a deb for Linux, an NSIS installer for
Windows, x64 and arm64 for each. Or build your own:

```bash
bun run dist          # installers for the host OS, into release/
```

The builds are **unsigned**, so each platform will interpose on first launch,
and there is no auto-update.
[The running guide](docs/running.md#3-installing-it-on-your-computer) walks
through both, and through uninstalling again;
[the release guide](docs/releasing.md) covers cutting a new one.

> There are no releases yet — v1 is the first. Until then, build it yourself.

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
| [Roadmap](docs/roadmap.md)                     | What is unproven, and what to build next                            |

## Licence

MIT.
