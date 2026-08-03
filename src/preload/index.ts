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
 * hatch. A renderer bug can misuse only these eighteen verbs, and every one
 * that acts on a container or a project takes an ID: the main process resolves
 * that to its own copy rather than acting on data the renderer supplied.
 *
 * Note what `addProjectRoot` does NOT take: a path, and what `dismissUpdate`
 * does not take: a version. The renderer can ask for the folder picker to be
 * shown and cannot say which folder the answer is; it can say the user
 * dismissed an update and cannot say which one.
 */
const api: BoxwardenApi = {
  discover: () => ipcRenderer.invoke(IPC.discover),
  start: (id) => ipcRenderer.invoke(IPC.start, id),
  stop: (id) => ipcRenderer.invoke(IPC.stop, id),
  listEditors: () => ipcRenderer.invoke(IPC.listEditors),
  openInEditor: (id, editorId) => ipcRenderer.invoke(IPC.openInEditor, id, editorId),
  selectEngine: (selection) => ipcRenderer.invoke(IPC.selectEngine, selection),
  scanProjects: () => ipcRenderer.invoke(IPC.scanProjects),
  openProject: (id, editorId) => ipcRenderer.invoke(IPC.openProject, id, editorId),
  addProjectRoot: () => ipcRenderer.invoke(IPC.addProjectRoot),
  removeProjectRoot: (root) => ipcRenderer.invoke(IPC.removeProjectRoot, root),
  listTerminals: () => ipcRenderer.invoke(IPC.listTerminals),
  openTerminal: (id, terminalId) => ipcRenderer.invoke(IPC.openTerminal, id, terminalId),
  getStartupCommands: () => ipcRenderer.invoke(IPC.getStartupCommands),
  setStartupCommand: (id, command) => ipcRenderer.invoke(IPC.setStartupCommand, id, command),
  // An array crosses as a copy, so the main process cannot be handed a live
  // renderer object here — and it re-validates every id against its own last
  // container list regardless.
  claudeStatus: (ids) => ipcRenderer.invoke(IPC.claudeStatus, [...ids]),
  updateStatus: (force) => ipcRenderer.invoke(IPC.updateStatus, force),
  // No version argument — the main process dismisses whatever it last offered.
  dismissUpdate: () => ipcRenderer.invoke(IPC.dismissUpdate),
  setUpdateChecks: (enabled) => ipcRenderer.invoke(IPC.setUpdateChecks, enabled),
};

contextBridge.exposeInMainWorld('boxwarden', api);
