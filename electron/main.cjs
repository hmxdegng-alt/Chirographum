"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require("electron");
const { applyOfflineSwitches, installNetworkGuard, lockNavigation } = require("./network-guard.cjs");

applyOfflineSwitches(app.commandLine);

const DEV_SERVER_URL = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
const HAND_EXTENSION = "chmano";
const DOCUMENT_EXTENSION = "chiro";
const DOCUMENT_FILTER = { name: "Documento de Chirographum", extensions: [DOCUMENT_EXTENSION] };

// Test hooks, only honoured when running from source (never in the installed app).
const TEST_USER_DATA = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_USER_DATA;
const TEST_PDF_PATH = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_PDF_PATH;
// Answers for the file dialogs during automated tests (never in the installed app).
const TEST_SAVE_PATH = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_SAVE_PATH;
const TEST_OPEN_PATH = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_OPEN_PATH;
const TEST_UNSAVED_CHOICE = app.isPackaged ? undefined : process.env.CHIROGRAPHUM_TEST_UNSAVED_CHOICE;
if (TEST_USER_DATA) app.setPath("userData", TEST_USER_DATA);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** What the page reports about the open document, to ask before closing. */
let documentState = { dirty: false, name: "Sin título" };
let closingConfirmed = false;
/** A .chiro file passed on the command line (double click in the Explorer). */
let pendingOpenPath = findDocumentArgument(process.argv);

function findDocumentArgument(argv) {
  return argv.slice(1).find((arg) => arg.toLowerCase().endsWith(`.${DOCUMENT_EXTENSION}`) && !arg.startsWith("-")) ?? null;
}

/** Asks what to do with unsaved changes: "save", "discard" or "cancel". */
async function askUnsavedChanges(name) {
  if (TEST_UNSAVED_CHOICE) return TEST_UNSAVED_CHOICE;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Guardar", "No guardar", "Cancelar"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: "Chirographum",
    message: `¿Quieres guardar los cambios de «${name}»?`,
    detail: "Si no los guardas, se perderán.",
  });
  return ["save", "discard", "cancel"][response];
}

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

  mainWindow.on("close", async (event) => {
    if (closingConfirmed || !documentState.dirty) return;
    event.preventDefault();
    const choice = await askUnsavedChanges(documentState.name);
    if (choice === "cancel") return;
    // The page saves (asking for a name if needed) or forgets the changes,
    // then calls app:close. If it does not answer, close anyway.
    sendCommand(choice === "save" ? "saveAndClose" : "discardAndClose");
    if (choice === "discard") {
      setTimeout(() => {
        closingConfirmed = true;
        mainWindow?.close();
      }, 4000);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function sendCommand(command) {
  mainWindow?.webContents.send("menu:command", command);
}

function buildMenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: "Archivo",
      submenu: [
        { label: "Nuevo documento", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new") },
        { label: "Abrir…", accelerator: "CmdOrCtrl+O", click: () => sendCommand("open") },
        { type: "separator" },
        { label: "Guardar", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save") },
        { label: "Guardar como…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendCommand("saveAs") },
        { type: "separator" },
        { label: "Imprimir…", accelerator: "CmdOrCtrl+P", click: () => sendCommand("print") },
        { label: "Exportar PDF…", accelerator: "CmdOrCtrl+Shift+E", click: () => sendCommand("exportPdf") },
        { type: "separator" },
        { role: "quit", label: "Salir" },
      ],
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
        {
          id: "printedLook",
          label: "Vista impresa",
          type: "checkbox",
          click: (item) => mainWindow?.webContents.send("view:changed", "printedLook", item.checked),
        },
        {
          id: "typingAnimation",
          label: "Animaciones mientras se escribe",
          type: "checkbox",
          click: (item) => mainWindow?.webContents.send("view:changed", "typingAnimation", item.checked),
        },
        { type: "separator" },
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
  ipcMain.on("doc:state", (_event, dirty, name) => {
    documentState = { dirty: Boolean(dirty), name: String(name || "Sin título") };
  });

  ipcMain.on("app:close", () => {
    // The page's saved text and settings must reach the disk before it closes.
    session.defaultSession.flushStorageData();
    closingConfirmed = true;
    mainWindow?.close();
  });

  ipcMain.on("app:requestClose", () => mainWindow?.close());

  ipcMain.handle("doc:askUnsaved", (_event, name) => askUnsavedChanges(String(name)));

  ipcMain.handle("doc:save", async (_event, json, filePath, suggestedName) => {
    let target = typeof filePath === "string" && filePath ? filePath : null;
    if (!target && TEST_SAVE_PATH) target = TEST_SAVE_PATH;
    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Guardar documento",
        defaultPath: `${suggestedName || "Sin título"}.${DOCUMENT_EXTENSION}`,
        filters: [DOCUMENT_FILTER],
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    await fs.writeFile(target, String(json), "utf8");
    return target;
  });

  ipcMain.handle("doc:open", async () => {
    if (TEST_OPEN_PATH) return { path: TEST_OPEN_PATH, text: await fs.readFile(TEST_OPEN_PATH, "utf8") };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Abrir documento",
      properties: ["openFile"],
      filters: [DOCUMENT_FILTER],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return { path: result.filePaths[0], text: await fs.readFile(result.filePaths[0], "utf8") };
  });

  // A file chosen in the Explorer (double click) before or while the app runs.
  ipcMain.handle("doc:takePending", async () => {
    const target = pendingOpenPath;
    pendingOpenPath = null;
    if (!target) return null;
    try {
      return { path: target, text: await fs.readFile(target, "utf8") };
    } catch {
      return null;
    }
  });

  ipcMain.on("view:set", (_event, name, value) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(String(name));
    if (item) item.checked = Boolean(value);
  });

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

// One window only: opening a .chiro while the app runs sends it to that window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const file = findDocumentArgument(argv);
    if (file) {
      pendingOpenPath = file;
      sendCommand("openPending");
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  installNetworkGuard(session.defaultSession, DEV_SERVER_URL);
  buildMenu();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  session.defaultSession.flushStorageData();
  if (process.platform !== "darwin") app.quit();
});
