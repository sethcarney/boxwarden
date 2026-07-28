import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Three separate builds, because they run in three different places:
 *
 *   main     -> Node, full OS access, talks to Docker
 *   preload  -> the isolated bridge between the two
 *   renderer -> Chromium, no Node access at all
 *
 * externalizeDepsPlugin keeps `dependencies` out of the main bundle. dockerode
 * pulls in ssh2, which has optional native bindings; bundling it produces
 * either a build failure or a binary that breaks the moment someone points
 * DOCKER_HOST at ssh://. Leaving it external means it is require()d from
 * node_modules at runtime, which is what it expects.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // A SANDBOXED preload must be CommonJS — ESM preloads are only
        // supported with sandbox disabled, which is not a trade this app makes
        // (see the security notes in src/main/index.ts). package.json declares
        // "type": "module", so the extension has to be .cjs for Node to read
        // the file as CommonJS. main/index.ts points its `preload` path at
        // ../preload/index.cjs to match.
        //
        // The failure mode if this drifts is quiet: the preload fails to load,
        // `window.boxwarden` is undefined, and the UI shows an empty list
        // rather than an error.
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
