import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceApi } from "../shared/types";

const api: WorkspaceApi = {
  versions: () => ipcRenderer.invoke("versions:list"),
  createVersion: (message) => ipcRenderer.invoke("versions:create", message),
  selectVersion: (oid) => ipcRenderer.invoke("versions:select", oid),
  versionActive: () => ipcRenderer.invoke("versions:active"),
  versionChanged: () => ipcRenderer.invoke("versions:changed"),
  restoreVersion: () => ipcRenderer.invoke("versions:restore"),
  assist: (id, request) => ipcRenderer.invoke("assistant:send", id, request),
  cancelAssist: (id) => ipcRenderer.send("assistant:cancel", id),
  readControlPreferences: (root) =>
    ipcRenderer.invoke("project:controls:read", root),
  saveControlPreferences: (root, preferences) =>
    ipcRenderer.invoke("project:controls:save", root, preferences),
  current: () => ipcRenderer.invoke("project:current"),
  open: () => ipcRenderer.invoke("project:open"),
  create: () => ipcRenderer.invoke("project:create"),
  read: (path) => ipcRenderer.invoke("project:read", path),
  save: (request) => ipcRenderer.invoke("project:save", request),
  graph: (path, code) => ipcRenderer.invoke("project:graph", path, code),
  toggleExport: (path) => ipcRenderer.invoke("project:toggle-export", path),
  link: (source, target) => ipcRenderer.invoke("project:link", source, target),
  add: (parent, name, folder) =>
    ipcRenderer.invoke("project:add", parent, name, folder),
  move: (from, to) => ipcRenderer.invoke("project:move", from, to),
  trash: (path) => ipcRenderer.invoke("project:trash", path),
  reveal: () => ipcRenderer.invoke("project:reveal"),
  openExternalLink: (url) => ipcRenderer.invoke("app:open-external-link", url),
  close: () => ipcRenderer.send("app:close"),
  onBeforeClose: (callback) => {
    ipcRenderer.on("app:before-close", callback);
    return () => {
      ipcRenderer.removeListener("app:before-close", callback);
    };
  },
  finishClose: () => ipcRenderer.send("app:close-ready"),
  cancelClose: () => ipcRenderer.send("app:close-cancelled"),
};

contextBridge.exposeInMainWorld("workspace", api);
