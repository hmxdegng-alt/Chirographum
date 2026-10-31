"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The only bridge between the page and the computer: saving and opening
// hands, printing and exporting PDF. Nothing here touches the network.
contextBridge.exposeInMainWorld("chirographum", {
  autosaveHand: (json) => ipcRenderer.invoke("hand:autosave", json),
  loadAutosavedHand: () => ipcRenderer.invoke("hand:loadAutosave"),
  saveHandAs: (json, suggestedName) => ipcRenderer.invoke("hand:saveAs", json, suggestedName),
  openHand: () => ipcRenderer.invoke("hand:open"),
  printPage: () => ipcRenderer.invoke("page:print"),
  exportPdf: () => ipcRenderer.invoke("page:exportPdf"),
});
