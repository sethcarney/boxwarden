# Electron security checklist

Primary reference:
**<https://www.electronjs.org/docs/latest/tutorial/security>** — in particular
[§4 Enable process sandboxing](https://www.electronjs.org/docs/latest/tutorial/security#4-enable-process-sandboxing).

Read that page before changing `webPreferences`, adding an IPC channel, or
loading anything into a window. This file records where each item lands in
this repo so a reviewer can check the claim rather than take it on trust.

## Where the settings live

| Item                                           | Setting                                                                        | Where                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1. Only load secure content                    | Renderer is local; `connect-src 'none'` in production                          | `src/main/index.ts` (CSP)                      |
| 2. No Node integration for remote content      | `nodeIntegration: false`, plus the worker and sub-frame variants               | `src/main/index.ts`                            |
| 3. Enable context isolation                    | `contextIsolation: true`                                                       | `src/main/index.ts`                            |
| 4. **Enable process sandboxing**               | `sandbox: true` **and** `app.enableSandbox()`                                  | `src/main/index.ts`                            |
| 5. Handle permission requests                  | `setPermissionRequestHandler` / `setPermissionCheckHandler`, both blanket deny | `src/main/index.ts`                            |
| 6. Do not disable `webSecurity`                | `webSecurity: true`                                                            | `src/main/index.ts`                            |
| 7. Define a CSP                                | Response header, plus a `<meta>` fallback                                      | `src/main/index.ts`, `src/renderer/index.html` |
| 8. Do not allow insecure content               | `allowRunningInsecureContent: false`                                           | `src/main/index.ts`                            |
| 9. No experimental features                    | `experimentalFeatures: false`                                                  | `src/main/index.ts`                            |
| 10. No `enableBlinkFeatures`                   | Never set                                                                      | —                                              |
| 11/12. WebView hardening                       | `webviewTag: false`, `will-attach-webview` prevented                           | `src/main/index.ts`                            |
| 13. Limit navigation                           | `will-navigate` blocked except the dev server                                  | `src/main/index.ts`                            |
| 14. Limit new windows                          | `setWindowOpenHandler` returns `deny` unconditionally                          | `src/main/index.ts`                            |
| 15. `shell.openExternal` only on trusted input | Closed origin allow-list; never a renderer-chosen URL                          | `src/main/index.ts`                            |
| 16. Current Electron                           | Electron 43                                                                    | `package.json`                                 |
| 17. Validate IPC senders                       | `isTrustedSender` compares the `WebContents` object                            | `src/main/ipc.ts`                              |
| Spawning, generally                            | argv arrays only, never `shell: true`, for editors and terminals alike         | `src/main/{editor,terminal}/launch.ts`         |

Several of these are already Electron 43 defaults. They are written out anyway:
a default that flips in a future major is the kind of regression nobody
notices, and an explicit `sandbox: true` states an intent a reviewer can check.

## Three consequences worth knowing before you edit

### A sandboxed preload must be CommonJS

`sandbox: true` means the preload can only import `electron` and a small
polyfilled subset of Node — no `fs`, no `child_process` — and it **must be
CommonJS**. ESM preloads only work with the sandbox disabled.

`package.json` sets `"type": "module"`, so the preload build is forced to `cjs`
with a `.cjs` extension in `electron.vite.config.ts`, and `src/main/index.ts`
points at `../preload/index.cjs`.

**The failure mode is silent**: the preload fails to load, `window.boxwarden`
is `undefined`, and the UI would otherwise render an empty container list as
though the machine had none. `src/renderer/api.ts` turns that into an explicit
error screen naming this exact cause.

### Sender validation is object identity, not URL matching

```ts
isTrustedSender: (contents) => contents === mainWindow?.webContents;
```

`ipcMain.handle` will answer _any_ frame in the app. A URL comparison invites a
near-miss — a frame that merely claims the right origin. Comparing the object
is exact.

The same reasoning explains why `openInEditor` takes a **container id**, not a
`DevContainer`: accepting the whole object would mean spawning a process
against a host path the renderer supplied. The main process looks up its own
copy from the last scan instead.

`openTerminal` follows it twice over. It takes an id, and it does **not** take
the startup command — the main process reads its own stored copy, keyed off its
own copy of the container. `setStartupCommand` is the same shape from the other
direction: the renderer sends the command text, and the main process derives
the key it is filed under. A renderer cannot write a startup command against a
folder it invented, nor run one it merely claimed was stored.

### The renderer never names a path

The unbuilt-projects feature added four verbs, and all four keep filesystem
paths on the main side of the bridge:

- `openProject` takes a **`ProjectId`**, looked up in the main process's own
  copy of the last scan — the same pattern as `openInEditor`, for the same
  reason. Nothing is spawned against a path that arrived over IPC.
- `addProjectRoot` takes **no argument at all**. The renderer can ask for the
  OS folder picker to be shown; the user names the folder, in a dialog the
  renderer cannot see or drive. A `addProjectRoot(path)` would let a
  compromised renderer point a recursive walk at anything readable.
- `removeProjectRoot` does accept a string, and that is fine because it can only
  ever _narrow_ what is scanned.
- `scanProjects` reads directory names and the `name` field of each config. It
  reports what it could not read, and never sends file contents to the renderer.

### Reading a container's processes uses `top`, never `exec`

`claudeStatus` answers "is a Claude Code session running in here" from
`GET /containers/{id}/top`. That endpoint is read-only: no shell, no writes, no
code executed inside the container.

An `exec` running `ps | grep claude` would be the obvious alternative and is
strictly worse. It runs a process in the container, needs a shell string
assembled from data the app does not control, and buys nothing `top` does not
already give. The container's process table is **attacker-influenced** — a
command line is chosen by whoever started the process, and anyone who can create
containers on the daemon can put an arbitrary string in it. Through `top` that
string is inert data handed to a pure parser; through an `exec` shell string it
is a much larger surface for the same answer.

The parser treats it as untrusted accordingly: it never evaluates the command,
only matches path segments in it, and any shape it cannot read becomes an
`unknown` status rather than a throw.

`claudeStatus` also takes container **ids**, validated against the main
process's own last scan before any Docker call reaches them — the same rule as
`openInEditor` above and `openProject` beside it.

### Launching an editor never goes through a shell

`src/main/editor/launch.ts` uses `spawn` with an argv **array** and never
`shell: true`. The URI embeds a hex-encoded host path originating in a
container label, so it is attacker-influenced by anyone who can create
containers on the daemon. Through argv it is inert data; through a shell string
it would be command injection.

`shell.openExternal` is deliberately _not_ used for this — it would hand the
URI to whatever is registered for the scheme. It is used only for the
allow-listed documentation origins.

### Nor does opening a terminal

`src/main/terminal/launch.ts` follows the same rule with a sharper edge: what
it launches is, by design, a command line containing user-authored shell code —
the container's startup command. That code is meant to run inside the
container, and `shell: true` would run a copy of it on the host first.

Wherever the terminal emulator accepts an argv array, containment is
structural: every part stays a separate element and nothing is ever parsed as
syntax. Two emulators make that impossible — macOS Terminal and iTerm2 have no
command-line interface, only AppleScript — and for those the guarantee is
`posixQuote` and `appleScriptString` in `src/main/terminal/command.ts`. Both
wrap rather than escape a denylist, both are pure, and both are covered by
tests that feed them a deliberately hostile command. Read
`terminal/command.test.ts` before changing either one.

Two smaller notes on the same path. `discovery/resolve.ts` refuses to resolve a
`.cmd` or `.bat` on Windows, because Node will not spawn one without
`shell: true` and accepting it here would only move the pressure to the
launcher. And the startup command is normalised, not filtered
(`models/terminal.ts`): NUL and CR are stripped because they would be mangled
downstream, and nothing else is touched. The command is shell code by design;
containment is argv, not a denylist.

That allow-list is a **closed set** and has to stay one. The setup advice
(`src/models/advice.ts`) links to install instructions for every engine
boxwarden supports, so each new vendor is one more origin in
`ALLOWED_EXTERNAL_ORIGINS` — and the temptation on adding the next is to relax
the check to "any https URL". Don't. Advisory text is built from probe results
and container labels, both influenced by anyone who can create a container on
the daemon, and an open allow-list turns a crafted label into a link the user
is being invited to click. A link added to `advice.ts` without its origin
added here renders and does nothing; check both files together.

### The one granted permission

Everything is denied except `clipboard-sanitized-write`. That exists because
the diagnostics path offers **Copy URI** when launching an editor fails and
**Copy command** when opening a terminal fails — in both cases the one
remaining way for the user to get where they were going.

It is write-only and sanitized. Clipboard **read** stays denied: a renderer
that could read the clipboard could exfiltrate whatever the user last copied,
and nothing in this app needs it.

## Not yet done

- **No `session.setPermissionRequestHandler` audit for a second window.** There
  is only one window today; a second one must be added to the trusted-sender
  check rather than working by accident.
- **No packaging hardening.** `electron-builder` is not wired up yet, so ASAR
  integrity and code signing are unaddressed. See [roadmap](./roadmap.md).
