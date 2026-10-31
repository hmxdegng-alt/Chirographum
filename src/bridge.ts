// Access to the computer (files and printing) through Electron's preload.
// When the page runs in a plain browser during development, it falls back
// to local storage and the browser's own print dialog.

interface DesktopBridge {
  autosaveHand(json: string): Promise<boolean>;
  loadAutosavedHand(): Promise<string | null>;
  saveHandAs(json: string, suggestedName: string): Promise<string | null>;
  openHand(): Promise<string | null>;
  printPage(): Promise<{ ok: boolean; reason: string }>;
  exportPdf(): Promise<string | null>;
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
