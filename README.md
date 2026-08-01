# boxwarden

Local dev container management. A desktop app that lists the dev containers on
your machine and reattaches your editor to them.

> **Status: early MVP.** Discovery, start/stop, and open-in-editor are
> implemented and unit-tested, and the UI has been verified end to end against
> fixtures. They have **not** yet been run against a real Docker daemon or a
> real editor install — see [docs/roadmap.md](docs/roadmap.md#verified-and-unverified).

## What it does

- Finds containers carrying the `devcontainer.local_folder` label — the ones
  created by the Dev Containers extension or the `devcontainer` CLI. Ordinary
  containers are deliberately not listed.
- Shows project name, host folder, image, state, health, and published vs.
  exposed-only ports.
- Groups Docker Compose projects, so stopping a workspace does not leave its
  database running.
- Starts and stops them, individually or per project.
- Opens them in VS Code, VS Code Insiders, Cursor, or Windsurf — with a
  copyable URI fallback when launching fails.
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

```bash
bun run dist          # installers for the host OS, into release/
```

macOS gets a dmg, Linux an AppImage and a deb, Windows an NSIS installer. The
builds are unsigned, so each platform will interpose on first launch —
[the running guide](docs/running.md#3-installing-it-on-your-computer) walks
through that, and through uninstalling again.

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
| [Architecture](docs/architecture.md)           | Process model, the two path spaces, why the raw label matters       |
| [Electron security](docs/electron-security.md) | The upstream checklist and where each item lands here               |
| [Development](docs/development.md)             | Commands, fixtures, the two TS projects, testing                    |
| [Roadmap](docs/roadmap.md)                     | What is unproven, and what to build next                            |

## Licence

MIT.
