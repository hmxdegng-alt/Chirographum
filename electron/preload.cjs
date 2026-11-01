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
  // Ticks of the "Ver" menu.
  setViewOption: (name, value) => ipcRenderer.send("view:set", String(name), Boolean(value)),
  onViewOption: (callback) => {
    ipcRenderer.on("view:changed", (_event, name, value) => callback(String(name), Boolean(value)));
  },
});
