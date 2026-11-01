"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The only bridge between the page and the computer: saving and opening
// hands, printing, exporting PDF and the "Ver" menu ticks. Nothing here
// touches the network.
contextBridge.exposeInMainWorld("chirographum", {
  autosaveHand: (json) => ipcRenderer.invoke("hand:autosave", json),
  loadAutosavedHand: () => ipcRenderer.invoke("hand:loadAutosave"),
  saveHandAs: (json, suggestedName) => ipcRenderer.invoke("hand:saveAs", json, suggestedName),
  openHand: () => ipcRenderer.invoke("hand:open"),
  printPage: () => ipcRenderer.invoke("page:print"),
  exportPdf: () => ipcRenderer.invoke("page:exportPdf"),
  // Documents (.chiro).
  saveDocument: (json, filePath, suggestedName) => ipcRenderer.invoke("doc:save", json, filePath, suggestedName),
  openDocument: () => ipcRenderer.invoke("doc:open"),
  takePendingDocument: () => ipcRenderer.invoke("doc:takePending"),
  askUnsavedChanges: (name) => ipcRenderer.invoke("doc:askUnsaved", name),
  reportDocumentState: (dirty, name) => ipcRenderer.send("doc:state", Boolean(dirty), String(name)),
  closeApp: () => ipcRenderer.send("app:close"),
  // Same as clicking the window's X (asks about unsaved changes). Used by tests.
  requestClose: () => ipcRenderer.send("app:requestClose"),
  onMenuCommand: (callback) => {
    ipcRenderer.on("menu:command", (_event, command) => callback(String(command)));
  },
  // Ticks of the "Ver" menu.
  setViewOption: (name, value) => ipcRenderer.send("view:set", String(name), Boolean(value)),
  onViewOption: (callback) => {
    ipcRenderer.on("view:changed", (_event, name, value) => callback(String(name), Boolean(value)));
  },
});
