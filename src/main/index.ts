import { join } from 'node:path';
import { BrowserWindow, app, session, shell, type WebContents } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import type { DockerBackend } from './docker/backend.js';
import { DockerodeBackend } from './docker/client.js';
import { FakeDockerBackend } from './docker/fake.js';

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
 * cannot be removed by injected markup. 'unsafe-inline' for styles is the one
 * concession — the renderer ships a plain stylesheet, but Vite injects styles
 * inline during development. `connect-src` allows the dev server's websocket
 * for HMR and nothing at all in production: this app has no business making
 * network requests from the renderer.
 */
function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'none'",
    "script-src 'self'",
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

  // Item 5: handle permission requests. This app needs none of them —
  // no camera, microphone, geolocation, notifications, or clipboard reads —
  // so the honest handler is a blanket deny.
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
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
const ALLOWED_EXTERNAL_ORIGINS = new Set([
  'https://code.visualstudio.com',
  'https://containers.dev',
  'https://docs.docker.com',
  'https://www.electronjs.org',
]);

function applyNavigationHardening(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    const isDevServer = IS_DEV && RENDERER_URL !== undefined && url.startsWith(RENDERER_URL);
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

void app.whenReady().then(() => {
  applySessionHardening();

  mainWindow = createWindow();

  registerIpcHandlers({
    backend: backendFromEnv(),
    // Identity by object, not by URL. A URL comparison invites a
    // near-miss — a frame that merely *claims* the right origin — whereas
    // this is the actual WebContents we created, and nothing else can be it.
    isTrustedSender: (contents) => contents === mainWindow?.webContents,
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

// Item 4 again, belt and braces: a renderer that somehow gets a preload with
// node integration should still not be able to spawn from the sandbox.
app.enableSandbox();
