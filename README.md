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

## Docs

|                                                |                                                               |
| ---------------------------------------------- | ------------------------------------------------------------- |
| [Architecture](docs/architecture.md)           | Process model, the two path spaces, why the raw label matters |
| [Electron security](docs/electron-security.md) | The upstream checklist and where each item lands here         |
| [Development](docs/development.md)             | Commands, fixtures, the two TS projects, testing              |
| [Roadmap](docs/roadmap.md)                     | What is unproven, and what to build next                      |

## Licence

MIT.
