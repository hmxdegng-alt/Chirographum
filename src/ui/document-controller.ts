// The open document: its file, whether it has unsaved changes, and the
// Archivo menu commands (new, open, save, save as, print, export).

import { bridge, loadPreference, savePreference } from "../bridge";
import { DocumentFormatError, documentTitle, parseDocument, serializeDocument, type ChiroDocument } from "../engine/document";
import { freshSeed } from "../engine/random";
import { es } from "../i18n/es";
import type { Store } from "../store";
import { toast } from "./dom";
import type { SheetDocumentApi } from "./sheet-view";

const UNTITLED_MAX_LENGTH = 40;

/** Suggested file name: the first line of the text, like most editors. */
function suggestedName(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  const clean = firstLine.replace(/[\\/:*?"<>|]+/g, "").replace(/[.:,;]+$/, "").slice(0, UNTITLED_MAX_LENGTH).trim();
  return clean || es.document.untitled;
}

export function createDocumentController(sheet: SheetDocumentApi, store: Store, label: HTMLElement): void {
  let filePath = loadPreference<string | null>("doc.path", null);
  let dirty = loadPreference("doc.dirty", false);
  /** The document as last saved or opened, to go back to when changes are discarded. */
  let savedSnapshot = loadPreference<string | null>("doc.saved", null);

  const name = () => documentTitle(filePath) ?? es.document.untitled;

  function update(): void {
    savePreference("doc.path", filePath);
    savePreference("doc.dirty", dirty);
    savePreference("doc.saved", savedSnapshot);
    document.title = `${dirty ? "• " : ""}${name()} — ${es.appName}`;
    label.replaceChildren(
      Object.assign(document.createElement("span"), { className: "doc-title", textContent: name() }),
      Object.assign(document.createElement("span"), { className: `doc-status${dirty ? " unsaved" : ""}`, textContent: dirty ? es.document.unsaved : es.document.saved }),
    );
    label.title = filePath ?? es.document.notSavedYet;
    bridge.reportDocumentState(dirty, name());
  }

  sheet.onChange(() => {
    if (dirty) return;
    dirty = true;
    update();
  });

  function show(doc: ChiroDocument, path: string | null, snapshot: string | null): void {
    sheet.loadDocument(doc);
    filePath = path;
    savedSnapshot = snapshot;
    dirty = false;
    update();
    store.update({ tab: "sheet" });
  }

  /** Saves; asks for a name if the document has none (or always with saveAs). */
  async function save(asNew: boolean): Promise<boolean> {
    const doc = sheet.getDocument();
    const json = serializeDocument(doc);
    const target = await bridge.saveDocument(json, asNew ? null : filePath, asNew && filePath ? name() : suggestedName(doc.text));
    if (!target) return false;
    filePath = target;
    savedSnapshot = json;
    dirty = false;
    update();
    toast(es.document.savedAs(name()));
    return true;
  }

  /** Before replacing the document: true when it is fine to go on. */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    const choice = await bridge.askUnsavedChanges(name());
    if (choice === "cancel") return false;
    if (choice === "save") return save(false);
    return true;
  }

  function openText(path: string, text: string): void {
    try {
      const doc = parseDocument(text, sheet.currentSettings());
      show(doc, path, text);
    } catch (error) {
      toast(error instanceof DocumentFormatError ? es.document.errors[error.reason] : es.document.errors.json);
    }
  }

  const commands: Record<string, () => Promise<void> | void> = {
    async new() {
      if (!(await confirmDiscard())) return;
      // A blank page with the same pen and look, written in a new version.
      show({ text: "", charIds: [], settings: { ...sheet.currentSettings(), seed: freshSeed() } }, null, null);
    },
    async open() {
      if (!(await confirmDiscard())) return;
      const file = await bridge.openDocument();
      if (file) openText(file.path, file.text);
    },
    async openPending() {
      const file = await bridge.takePendingDocument();
      if (!file || !(await confirmDiscard())) return;
      openText(file.path, file.text);
    },
    async save() {
      await save(false);
    },
    async saveAs() {
      await save(true);
    },
    async saveAndClose() {
      if (!(await save(false))) return;
      sheet.flush();
      bridge.closeApp();
    },
    discardAndClose() {
      // Next time the app opens it shows the document as it was last saved.
      if (savedSnapshot) {
        try {
          sheet.loadDocument(parseDocument(savedSnapshot, sheet.currentSettings()));
        } catch {
          // A damaged snapshot: keep what is there.
        }
      } else {
        sheet.loadDocument({ text: "", charIds: [], settings: sheet.currentSettings() });
      }
      dirty = false;
      update();
      sheet.flush();
      bridge.closeApp();
    },
    async print() {
      await sheet.print();
    },
    async exportPdf() {
      await sheet.exportPdf();
    },
  };

  bridge.onMenuCommand((command) => void commands[command]?.());
  // The same commands for automated tests (they cannot click the native menu).
  (window as unknown as { chirographumCommand?: (command: string) => Promise<void> | void }).chirographumCommand = (command) => commands[command]?.();
  update();
  // A document double-clicked in the Explorer.
  void commands.openPending();
}
