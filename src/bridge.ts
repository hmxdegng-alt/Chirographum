// Access to the computer (files and printing) through Electron's preload.
// When the page runs in a plain browser during development, it falls back
// to local storage and the browser's own print dialog.

interface DesktopBridge {
  autosaveHand(json: string): Promise<boolean>;
  loadAutosavedHand(): Promise<string | null>;
  saveHandAs(json: string, suggestedName: string): Promise<string | null>;
  openHand(): Promise<string | null>;
  /** Prints the page; `dpi` asks the printer for that resolution (its quality mode). */
  printPage(dpi?: number): Promise<{ ok: boolean; reason: string }>;
  exportPdf(): Promise<string | null>;
  setViewOption(name: string, value: boolean): void;
  onViewOption(callback: (name: string, value: boolean) => void): void;
  /** Writes a document; asks for a name when filePath is null. Returns the path, or null if cancelled. */
  saveDocument(json: string, filePath: string | null, suggestedName: string): Promise<string | null>;
  openDocument(): Promise<{ path: string; text: string } | null>;
  takePendingDocument(): Promise<{ path: string; text: string } | null>;
  askUnsavedChanges(name: string): Promise<"save" | "discard" | "cancel">;
  reportDocumentState(dirty: boolean, name: string): void;
  closeApp(): void;
  onMenuCommand(callback: (command: string) => void): void;
  /** Cut, copy or paste in the focused text box, as the Editar menu does. */
  editAction(action: "cut" | "copy" | "paste"): void;
}

declare global {
  interface Window {
    chirographum?: DesktopBridge;
  }
}

const AUTOSAVE_KEY = "chirographum.autosave.hand";

export const bridge: DesktopBridge = window.chirographum ?? {
  async autosaveHand(json) {
    localStorage.setItem(AUTOSAVE_KEY, json);
    return true;
  },
  async loadAutosavedHand() {
    return localStorage.getItem(AUTOSAVE_KEY);
  },
  async saveHandAs(json, suggestedName) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    link.download = `${suggestedName}.chmano`;
    link.click();
    URL.revokeObjectURL(link.href);
    return link.download;
  },
  async openHand() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".chmano";
      input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null);
      input.click();
    });
  },
  async printPage() {
    window.print();
    return { ok: true, reason: "" };
  },
  async saveDocument(json, _filePath, suggestedName) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    link.download = `${suggestedName}.chiro`;
    link.click();
    URL.revokeObjectURL(link.href);
    return link.download;
  },
  async openDocument() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".chiro";
      input.onchange = async () => {
        const file = input.files?.[0];
        resolve(file ? { path: file.name, text: await file.text() } : null);
      };
      input.click();
    });
  },
  async takePendingDocument() {
    return null;
  },
  async askUnsavedChanges(name) {
    return window.confirm(`¿Descartar los cambios de «${name}»?`) ? "discard" : "cancel";
  },
  reportDocumentState() {
    // Only the desktop app asks before closing.
  },
  closeApp() {
    window.close();
  },
  editAction(action) {
    // A plain browser only lets the page cut and copy; pasting needs Ctrl+V.
    document.execCommand(action);
  },
  onMenuCommand() {
    // No menu when running in a plain browser.
  },
  setViewOption() {
    // No menu when running in a plain browser.
  },
  onViewOption() {
    // No menu when running in a plain browser.
  },
  async exportPdf() {
    window.print();
    return null;
  },
};

/** Small preferences (last phrase, sliders) that are fine in local storage. */
export function loadPreference<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`chirographum.pref.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(`chirographum.pref.${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; losing them is harmless.
  }
}
