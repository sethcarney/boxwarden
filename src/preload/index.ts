import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { BoxwardenApi } from '../shared/ipc.js';

/**
 * The bridge, and the entire surface the renderer can reach.
 *
 * Constraints worth knowing before editing this file:
 *
 *   - It runs SANDBOXED (see webPreferences in ../main/index.ts), so only
 *     `electron` and a small polyfilled subset of Node are importable. No
 *     `fs`, no `child_process`. `IPC` is a plain const object that the
 *     bundler inlines, so importing it costs no runtime require.
 *
 *   - A sandboxed preload must be CommonJS. electron.vite.config.ts forces the
 *     preload build to `cjs` and a `.cjs` extension for that reason; an ESM
 *     preload fails to load with sandbox enabled, and the symptom is an
 *     undefined `window.boxwarden` rather than a useful error.
 *
 *   - Only functions and structured-cloneable data cross `exposeInMainWorld`.
 *     Anything else arrives as undefined on the far side.
 *
 * The methods are deliberately narrow — no generic "invoke any channel" escape
 * hatch. A renderer bug can misuse only these five verbs.
 */
const api: BoxwardenApi = {
  discover: () => ipcRenderer.invoke(IPC.discover),
  start: (id) => ipcRenderer.invoke(IPC.start, id),
  stop: (id) => ipcRenderer.invoke(IPC.stop, id),
  listEditors: () => ipcRenderer.invoke(IPC.listEditors),
  openInEditor: (id, editorId) => ipcRenderer.invoke(IPC.openInEditor, id, editorId),
};

contextBridge.exposeInMainWorld('boxwarden', api);
