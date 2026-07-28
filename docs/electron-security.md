# Electron security checklist

Primary reference:
**<https://www.electronjs.org/docs/latest/tutorial/security>** — in particular
[§4 Enable process sandboxing](https://www.electronjs.org/docs/latest/tutorial/security#4-enable-process-sandboxing).

Read that page before changing `webPreferences`, adding an IPC channel, or
loading anything into a window. This file records where each item lands in
this repo so a reviewer can check the claim rather than take it on trust.

## Where the settings live

| Item | Setting | Where |
| --- | --- | --- |
| 1. Only load secure content | Renderer is local; `connect-src 'none'` in production | `src/main/index.ts` (CSP) |
| 2. No Node integration for remote content | `nodeIntegration: false`, plus the worker and sub-frame variants | `src/main/index.ts` |
| 3. Enable context isolation | `contextIsolation: true` | `src/main/index.ts` |
| 4. **Enable process sandboxing** | `sandbox: true` **and** `app.enableSandbox()` | `src/main/index.ts` |
| 5. Handle permission requests | `setPermissionRequestHandler` / `setPermissionCheckHandler`, both blanket deny | `src/main/index.ts` |
| 6. Do not disable `webSecurity` | `webSecurity: true` | `src/main/index.ts` |
| 7. Define a CSP | Response header, plus a `<meta>` fallback | `src/main/index.ts`, `src/renderer/index.html` |
| 8. Do not allow insecure content | `allowRunningInsecureContent: false` | `src/main/index.ts` |
| 9. No experimental features | `experimentalFeatures: false` | `src/main/index.ts` |
| 10. No `enableBlinkFeatures` | Never set | — |
| 11/12. WebView hardening | `webviewTag: false`, `will-attach-webview` prevented | `src/main/index.ts` |
| 13. Limit navigation | `will-navigate` blocked except the dev server | `src/main/index.ts` |
| 14. Limit new windows | `setWindowOpenHandler` returns `deny` unconditionally | `src/main/index.ts` |
| 15. `shell.openExternal` only on trusted input | Allow-list of four origins; never a renderer-chosen URL | `src/main/index.ts` |
| 16. Current Electron | Electron 43 | `package.json` |
| 17. Validate IPC senders | `isTrustedSender` compares the `WebContents` object | `src/main/ipc.ts` |

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
isTrustedSender: (contents) => contents === mainWindow?.webContents
```

`ipcMain.handle` will answer *any* frame in the app. A URL comparison invites a
near-miss — a frame that merely claims the right origin. Comparing the object
is exact.

The same reasoning explains why `openInEditor` takes a **container id**, not a
`DevContainer`: accepting the whole object would mean spawning a process
against a host path the renderer supplied. The main process looks up its own
copy from the last scan instead.

### Launching an editor never goes through a shell

`src/main/editor/launch.ts` uses `spawn` with an argv **array** and never
`shell: true`. The URI embeds a hex-encoded host path originating in a
container label, so it is attacker-influenced by anyone who can create
containers on the daemon. Through argv it is inert data; through a shell string
it would be command injection.

`shell.openExternal` is deliberately *not* used for this — it would hand the
URI to whatever is registered for the scheme. It is used only for the four
allow-listed documentation origins.

## Not yet done

- **No `session.setPermissionRequestHandler` audit for a second window.** There
  is only one window today; a second one must be added to the trusted-sender
  check rather than working by accident.
- **No packaging hardening.** `electron-builder` is not wired up yet, so ASAR
  integrity and code signing are unaddressed. See [roadmap](./roadmap.md).
