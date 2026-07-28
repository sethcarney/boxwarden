import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Three separate builds, because they run in three different places:
 *
 *   main     -> Node, full OS access, talks to Docker
 *   preload  -> the isolated bridge between the two
 *   renderer -> Chromium, no Node access at all
 *
 * The two halves want OPPOSITE dependency handling, which is the least
 * obvious thing in this file — see each block.
 *
 * Note on versions: Vite is pinned to 7.x because electron-vite 5 declares no
 * support for 8, and under 8's rolldown backend dependency externalization
 * silently stopped applying — the build then tried to bundle dockerode's
 * optional native ssh2 bindings into the main process and failed.
 */
export default defineConfig({
  main: {
    build: {
      // Default true; stated explicitly because it is load-bearing. dockerode
      // pulls in ssh2, which has optional native bindings; bundling it
      // produces either a build failure or a binary that breaks the moment
      // someone points DOCKER_HOST at ssh://. External means it is require()d
      // from node_modules at runtime, which is what it expects.
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },

  preload: {
    build: {
      // The OPPOSITE of main, and deliberately so. A sandboxed preload cannot
      // require() out of node_modules at runtime, so anything it imports has
      // to be bundled into the file itself.
      //
      // It costs nothing today — the preload imports only `electron` (always
      // provided by the runtime) and a plain const object from src/shared.
      // It is set anyway because the day someone adds a real dependency to the
      // preload, externalizing it would produce a preload that fails to load,
      // and the symptom is an undefined `window.boxwarden` rather than an
      // error naming the cause.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // A SANDBOXED preload must also be CommonJS — ESM preloads are only
        // supported with sandbox disabled, which is not a trade this app makes
        // (see the security notes in src/main/index.ts). package.json declares
        // "type": "module", so the extension has to be .cjs for Node to read
        // the file as CommonJS. main/index.ts points its `preload` path at
        // ../preload/index.cjs to match.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
