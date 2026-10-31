"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require("electron");
const { applyOfflineSwitches, installNetworkGuard, lockNavigation } = require("./network-guard.cjs");

applyOfflineSwitches(app.commandLine);

const DEV_SERVER_URL = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
const HAND_EXTENSION = "chmano";

// Test hooks, only honoured when running from source (never in the installed app).
const TEST_USER_DATA = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_USER_DATA;
const TEST_PDF_PATH = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_PDF_PATH;
if (TEST_USER_DATA) app.setPath("userData", TEST_USER_DATA);

/** @type {BrowserWindow | null} */
let mainWindow = null;

function autosavePath() {
  return path.join(app.getPath("userData"), "hands", `autosave.${HAND_EXTENSION}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: "Chirographum",
    backgroundColor: "#f8f9fa",
    // The installed app takes its icon from the .exe; this is for running from source.
    icon: app.isPackaged ? undefined : path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  lockNavigation(mainWindow.webContents, DEV_SERVER_URL);

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: "Archivo",
      submenu: [{ role: "quit", label: "Salir" }],
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo", label: "Deshacer" },
        { role: "redo", label: "Rehacer" },
        { type: "separator" },
        { role: "cut", label: "Cortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Pegar" },
        { role: "selectAll", label: "Seleccionar todo" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "resetZoom", label: "Tamaño real" },
        { role: "zoomIn", label: "Ampliar" },
        { role: "zoomOut", label: "Reducir" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools", label: "Herramientas de desarrollo" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle("hand:autosave", async (_event, json) => {
    const file = autosavePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, String(json), "utf8");
    return true;
  });

  ipcMain.handle("hand:loadAutosave", async () => {
    try {
      return await fs.readFile(autosavePath(), "utf8");
    } catch {
      return null;
    }
  });

  ipcMain.handle("hand:saveAs", async (_event, json, suggestedName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Guardar mano",
      defaultPath: `${suggestedName || "mi-mano"}.${HAND_EXTENSION}`,
      filters: [{ name: "Mano de Chirographum", extensions: [HAND_EXTENSION] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, String(json), "utf8");
    return path.basename(result.filePath);
  });

  ipcMain.handle("hand:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Abrir mano",
      properties: ["openFile"],
      filters: [{ name: "Mano de Chirographum", extensions: [HAND_EXTENSION] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return fs.readFile(result.filePaths[0], "utf8");
  });

  ipcMain.handle("page:print", async () => {
    if (!mainWindow) return { ok: false, reason: "no-window" };
    return new Promise((resolve) => {
      mainWindow.webContents.print(
        {
          silent: false,
          printBackground: true,
          pageSize: "A4",
          margins: { marginType: "none" },
        },
        (ok, reason) => resolve({ ok, reason: reason || "" }),
      );
    });
  });

  ipcMain.handle("page:exportPdf", async () => {
    if (!mainWindow) return null;
    const data = await mainWindow.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    if (TEST_PDF_PATH) {
      await fs.writeFile(TEST_PDF_PATH, data);
      return path.basename(TEST_PDF_PATH);
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Exportar PDF",
      defaultPath: "hoja-chirographum.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, data);
    return path.basename(result.filePath);
  });
}

app.whenReady().then(() => {
  installNetworkGuard(session.defaultSession, DEV_SERVER_URL);
  buildMenu();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
