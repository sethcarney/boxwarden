import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, session, shell, type WebContents } from 'electron';
import { defaultProjectRoots, resolveProjectRoots } from '../models/index.js';
import { registerIpcHandlers } from './ipc.js';
import type { DockerBackend } from './docker/backend.js';
import { DockerodeBackend } from './docker/client.js';
import { FakeDockerBackend } from './docker/fake.js';
import { shutdownWslServices } from './docker/wsl.js';
import { loadPreferences, savePreferences } from './preferences.js';

/**
 * Main process entry.
 *
 * The window configuration below follows Electron's security checklist
 * (https://www.electronjs.org/docs/latest/tutorial/security). Several of those
 * settings are already the default in Electron 43; they are written out anyway
 * because a default that silently flips in a future major is exactly the kind
 * of regression nobody notices, and because an explicit `sandbox: true` states
 * an intent that a reviewer can check.
 *
 * What the renderer can reach is the whole point: it renders a list of the
 * developer's containers and can start, stop, and open them. Everything else —
 * the Docker socket, the filesystem, the ability to spawn an editor — stays on
 * this side of the bridge.
 */

/** electron-vite sets this in development; its absence means a packaged build. */
const RENDERER_URL = process.env['ELECTRON_RENDERER_URL'];
const IS_DEV = RENDERER_URL !== undefined;

let mainWindow: BrowserWindow | undefined;

/**
 * Where unbuilt dev container projects are looked for when the user has not
 * said otherwise.
 *
 * Computed once at module scope: `homedir()` cannot change while the app runs,
 * and recomputing it per scan would make the defaults look mutable when they
 * are not.
 */
const PLATFORM_DEFAULT_ROOTS = defaultProjectRoots(process.platform, homedir());

/**
 * Software rendering, for displays that have no GPU behind them.
 *
 * Set by .devcontainer/devcontainer.json, because this is a property of the
 * environment and not of the app: desktop-lite's Xvfb is a virtual framebuffer
 * with no GL driver under it, so Chromium's GPU process fails to create a
 * surface ("No suitable EGL configs found") and then exits. Whether that is
 * survivable is a race — it usually degrades to software rendering, but it can
 * also escalate to `GPU process isn't usable. Goodbye.` and take the app down
 * before the window ever appears.
 *
 * An env var rather than an OS probe: on a real desktop — including a Linux
 * host running this same source over the same X server — hardware acceleration
 * works and should stay on. Only the container knows it is the container.
 *
 * MUST run before app.whenReady(); Chromium reads this during startup and
 * ignores it afterwards, which is why it is at module scope and not inside the
 * ready handler.
 */
if (process.env['BOXWARDEN_SOFTWARE_RENDER'] === '1') {
  app.disableHardwareAcceleration();
}

function backendFromEnv(): DockerBackend {
  if (process.env['BOXWARDEN_FAKE_DOCKER'] === '1') {
    // Logged loudly: a fake container list that the user believes is real is
    // the worst possible failure for this app.
    console.warn('[boxwarden] BOXWARDEN_FAKE_DOCKER=1 — serving fixtures, not a real daemon.');
    return new FakeDockerBackend();
  }
  return new DockerodeBackend();
}

/**
 * Item 7: define a Content-Security-Policy.
 *
 * Applied as a response header rather than only a <meta> tag, because a header
 * cannot be removed by injected markup. 'unsafe-inline' for styles is one
 * concession — the renderer ships a plain stylesheet, but Vite injects styles
 * inline during development. `connect-src` allows the dev server's websocket
 * for HMR and nothing at all in production: this app has no business making
 * network requests from the renderer.
 *
 * The second concession is 'unsafe-inline' for scripts, and it is DEV ONLY.
 * @vitejs/plugin-react serves an inline <script type="module"> preamble that
 * installs the react-refresh hooks; every module it then transforms references
 * the globals that preamble defines. Blocking it does not degrade gracefully —
 * main.tsx throws "@vitejs/plugin-react can't detect preamble", React never
 * mounts, and the window paints `backgroundColor` and nothing else. A blank
 * window with no visible error is a bad enough symptom to be worth naming here.
 *
 * A hash for that one script would be tighter than 'unsafe-inline' and was
 * rejected: the preamble's contents change with the plugin version, so a
 * routine dependency bump would silently reproduce the blank window. The
 * production policy — the one that ships — keeps a bare `script-src 'self'`.
 */
function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'none'",
    IS_DEV ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    IS_DEV ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
  return directives.join('; ');
}

function applySessionHardening(): void {
  const defaultSession = session.defaultSession;

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()],
      },
    });
  });

  // Item 5: handle permission requests. This app needs almost none of them —
  // no camera, microphone, geolocation, or notifications — so the default is a
  // blanket deny with one narrow exception.
  //
  // `clipboard-sanitized-write` is granted because the diagnostics path offers
  // "Copy URI" when launching an editor fails, and that is the one remaining
  // way for the user to get where they were going. It is write-only and
  // sanitized; clipboard READ stays denied, since a renderer that could read
  // the clipboard could exfiltrate whatever the user last copied.
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}

/**
 * Items 13 and 14: disable navigation and new-window creation.
 *
 * The renderer only ever displays its own bundle. Any attempt to navigate
 * elsewhere means something went wrong, so it is blocked rather than
 * sanitised. External links — the docs links in the diagnostics panel — go to
 * the system browser through `shell.openExternal`, and only for the exact
 * https origins listed, never for a URL the renderer chose.
 */
/**
 * A CLOSED set, and it has to stay closed.
 *
 * The setup advice in src/domain/advice.ts links to install instructions for
 * every engine boxwarden supports, and each vendor is one more origin here.
 * The temptation on adding the next one is to relax this to "any https URL" —
 * don't. The advisories are built from container labels and probe results, both
 * of which are attacker-influenced by anyone who can create a container on the
 * daemon, and an open allow-list turns a crafted label into a link the user is
 * being invited to click.
 *
 * A link added to advice.ts without its origin added here renders and does
 * nothing. Check both files together.
 */
const ALLOWED_EXTERNAL_ORIGINS = new Set([
  'https://code.visualstudio.com',
  'https://containers.dev',
  'https://docs.docker.com',
  'https://www.electronjs.org',
  // Container engine install instructions, reachable from the setup advice.
  'https://learn.microsoft.com',
  'https://podman.io',
  'https://podman-desktop.io',
  'https://orbstack.dev',
  'https://rancherdesktop.io',
  'https://github.com',
]);

function applyNavigationHardening(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    // RENDERER_URL is only set in development, so this single check covers
    // both "are we in dev" and "is this our own dev server".
    const isDevServer = RENDERER_URL !== undefined && url.startsWith(RENDERER_URL);
    if (!isDevServer) event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { action: 'deny' };
    }

    if (ALLOWED_EXTERNAL_ORIGINS.has(origin)) {
      // Fire and forget: a rejected openExternal must not take down the app.
      void shell.openExternal(url).catch(() => undefined);
    }
    // Denied either way — the link opens in the system browser, never in an
    // Electron window, which would be a browser with our privileges.
    return { action: 'deny' };
  });

  // Item 12: no <webview> is used, so any attempt to create one is a bug.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_040,
    height: 720,
    minWidth: 720,
    minHeight: 420,
    show: false,
    backgroundColor: '#16181d',
    title: 'boxwarden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Item 4. Restricts the renderer (and the preload) to a process that
      // cannot touch the OS directly. The preload uses only contextBridge and
      // ipcRenderer, both of which remain available under the sandbox.
      sandbox: true,
      // Item 3. The bridge's whole premise: renderer JS and preload JS get
      // separate contexts, so the page cannot reach in and rewrite the API.
      contextIsolation: true,
      // Item 2.
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // Item 6 — never disabled.
      webSecurity: true,
      // Items 8, 9 and 10.
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  applyNavigationHardening(window.webContents);

  // Avoids the white flash before React's first paint.
  window.once('ready-to-show', () => window.show());

  if (RENDERER_URL !== undefined) {
    void window.loadURL(RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(async () => {
  applySessionHardening();

  const preferencesPath = join(app.getPath('userData'), 'preferences.json');

  /**
   * Held in a mutable local rather than re-read per change, because two
   * independent settings now live in this file. Writing `{ engineSelection }`
   * on an engine switch would drop the user's scan roots, and writing
   * `{ projectRoots }` on a root change would drop their engine — a bug that
   * only shows up on the next launch, which is the worst time to find it.
   */
  let preferences = await loadPreferences(preferencesPath);
  const persist = (next: typeof preferences): void => {
    preferences = next;
    void savePreferences(preferencesPath, next);
  };

  const backend = backendFromEnv();
  // Applied BEFORE the window exists, so the very first discover() honours the
  // saved choice. Restoring it after the first scan would open the app showing
  // every engine and then visibly correct itself.
  backend.select(preferences.engineSelection);

  mainWindow = createWindow();

  registerIpcHandlers({
    backend,
    // Identity by object, not by URL. A URL comparison invites a
    // near-miss — a frame that merely *claims* the right origin — whereas
    // this is the actual WebContents we created, and nothing else can be it.
    isTrustedSender: (contents) => contents === mainWindow?.webContents,
    onSelectionChanged: (engineSelection) => {
      persist({ ...preferences, engineSelection });
    },
    projects: {
      platform: process.platform,
      roots: () => resolveProjectRoots(preferences.projectRoots, PLATFORM_DEFAULT_ROOTS),
      setRoots: (projectRoots) => {
        persist({ ...preferences, projectRoots });
      },
      chooseFolder: async () => {
        // Parented to our window, so it is a sheet on macOS and modal
        // everywhere else — an unparented picker can end up behind the app,
        // which reads as the button having done nothing.
        //
        // `dontAddToRecent` because this is a settings change, not a document
        // the user opened, and it has no business in the OS recent-files list.
        const options = {
          title: 'Choose a folder to scan for dev containers',
          properties: ['openDirectory', 'dontAddToRecent'] as const,
          buttonLabel: 'Scan this folder',
        };
        const result =
          mainWindow === undefined
            ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
            : await dialog.showOpenDialog(mainWindow, {
                ...options,
                properties: [...options.properties],
              });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
  });

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open should reopen one.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // macOS convention is for the app to stay resident; everywhere else,
  // closing the last window means quit.
  if (process.platform !== 'darwin') app.quit();
});

// Reaching an engine inside a WSL distro can require boxwarden to start a
// `podman system service` in it. That process outlives this one unless it is
// killed, and an orphan holds the whole distro awake — WSL will not idle-shut a
// distro with a running process in it.
app.on('will-quit', () => {
  shutdownWslServices();
});

// Item 4 again, belt and braces: a renderer that somehow gets a preload with
// node integration should still not be able to spawn from the sandbox.
app.enableSandbox();
