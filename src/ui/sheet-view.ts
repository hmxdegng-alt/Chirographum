// "Hoja": the user writes directly on A4 pages in their own hand, picks the
// pen and the imperfections, and prints or exports a PDF at true size.

import { bridge, loadPreference, savePreference } from "../bridge";
import { editedWordRange, randomCharId, updateCharIds } from "../engine/char-ids";
import type { ChiroDocument, SheetSettings } from "../engine/document";
import { charactersNeeded, type Hand } from "../engine/hand";
import { defaultCharIds, layoutText, normaliseText, type LayoutFormat, type LayoutResult } from "../engine/layout";
import { DEFAULT_PEN_ID, INK_COLORS, PENCIL_COLOR, PENS, penById } from "../engine/pens";
import { freshSeed, hashString } from "../engine/random";
import { renderPage } from "../engine/render";
import {
  BOLD,
  decodeParagraph,
  diffTexts,
  encodeParagraph,
  HIGHLIGHT,
  highlightColorIndex,
  ITALIC,
  paragraphCount,
  paragraphsInRange,
  rangeHasMark,
  setMark,
  STRIKE,
  UNDERLINE,
  updateMarks,
  updateParagraphs,
  type Alignment,
  type ParagraphStyle,
} from "../engine/rich-text";
import {
  A4,
  DEFAULT_PAPER,
  DEFAULT_PRESET_ID,
  PRESETS,
  presetById,
  randomNaturalness,
  type Naturalness,
  type PageSettings,
  type PaperKind,
  type PaperSettings,
} from "../engine/settings";
import { es } from "../i18n/es";
import type { Store } from "../store";
import { onViewOptions, setViewOption, viewOptions } from "../view-options";
import { createColorPopover } from "./color-picker";
import { button, h, percent, slider, toast } from "./dom";
import { createPageEditor } from "./page-editor";
import { createRuler } from "./ruler";
import { createToolbar } from "./toolbar";
import { createZoomControl } from "./zoom";

const PRINT_DPI = 600;
const PDF_JPEG_QUALITY = 0.92;
const MM_PER_INCH = 25.4;
const CSS_PX_PER_MM = 96 / MM_PER_INCH;
const MAX_RECENT_COLORS = 6;
/** Zoom range, relative to true size (1 = 100 %). */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
/** Preview backing store limit per page, in pixels. */
const MAX_PREVIEW_PIXELS = 24_000_000;
/** Wait after the last zoom step before redrawing sharp at the new size. */
const ZOOM_RENDER_DELAY = 140;
/** Wait after the last key before redrawing the handwriting. */
const TYPING_RENDER_DELAY = 40;
/** Undo steps kept; typing within this time counts as one step. */
const UNDO_LIMIT = 300;
const TYPING_GROUP_MS = 1200;

const PAPER_KINDS: PaperKind[] = ["blank", "lined", "grid4", "grid5", "dots"];

/** Everything an undo step brings back: text, the look of each letter, formatting and selection. */
interface Snapshot {
  text: string;
  ids: number[];
  marks: number[];
  paragraphs: number[];
  start: number;
  end: number;
}

const decimal = (value: number, digits = 1) => value.toFixed(digits).replace(".", ",");
const mmFormat = (value: number) => `${decimal(value)} ${es.sheet.mm}`;
const slopeFormat = (value: number) =>
  Math.abs(value) < 0.05 ? es.sheet.slopeFlat : value > 0 ? es.sheet.slopeUp(decimal(value)) : es.sheet.slopeDown(decimal(-value));

/** Imperfection sliders go up to 300 %: 100 % is a lot already, beyond is for whoever wants it. */
const NATURAL_MAX = 3;

const NATURAL_KEYS: (keyof Naturalness)[] = [
  "sizeVariation",
  "rotation",
  "slantDegrees",
  "slantVariation",
  "baselineWobble",
  "lineDrift",
  "lineSlope",
  "spacingVariation",
  "edgeShrink",
  "marginDrift",
  "inkTexture",
  "inkSkips",
];

/** What the document controller needs from the sheet. */
export interface SheetDocumentApi {
  getDocument(): ChiroDocument;
  /** Shows a document (or an empty one) without counting it as a change. */
  loadDocument(doc: ChiroDocument): void;
  currentSettings(): SheetSettings;
  onChange(listener: () => void): void;
  /** Writes pending changes to storage now (before the window closes). */
  flush(): void;
  print(): Promise<void>;
  exportPdf(): Promise<void>;
  /** Menu commands: undo, redo, formatting, styles, alignment. Returns false if not for the sheet. */
  command(command: string): boolean;
}

export function createSheetView(store: Store): { root: HTMLElement; onShow: () => void; document: SheetDocumentApi } {
  let penId = loadPreference("sheet.pen", DEFAULT_PEN_ID);
  let inkColor = loadPreference("sheet.color", INK_COLORS[0].value);
  let recentColors = loadPreference<string[]>("sheet.recentColors", []);
  let page: PageSettings = { ...A4, ...loadPreference<Partial<PageSettings>>("sheet.page", {}) };
  let presetId = loadPreference("sheet.preset", DEFAULT_PRESET_ID);
  if (presetId === "random") presetId = "custom"; // v0.0.2 had "Aleatorio" in the list
  let naturalness: Naturalness = { ...presetById(DEFAULT_PRESET_ID).values, ...loadPreference<Partial<Naturalness>>("sheet.naturalness", {}) };
  let seed = loadPreference("sheet.seed", freshSeed());
  /** The user's adjustments to the instrument: thickness and amount of ink. */
  let penTuning = { widthScale: 1, inkStrength: 1, ...loadPreference<Partial<{ widthScale: number; inkStrength: number }>>("sheet.penTuning", {}) };
  let renderTimer: number | undefined;
  let layout: LayoutResult | null = null;
  /** What each page canvas shows, to redraw only the pages that changed. */
  let drawnSignatures: string[] = [];

  const changeListeners = new Set<() => void>();
  /** True while a document is being shown: those updates are not edits. */
  let applyingDocument = false;
  const changed = () => {
    if (!applyingDocument) for (const listener of changeListeners) listener();
  };

  const persist = () => {
    changed();
    savePreference("sheet.pen", penId);
    savePreference("sheet.color", inkColor);
    savePreference("sheet.recentColors", recentColors);
    savePreference("sheet.page", page);
    savePreference("sheet.preset", presetId);
    savePreference("sheet.naturalness", naturalness);
    savePreference("sheet.seed", seed);
    savePreference("sheet.penTuning", penTuning);
  };

  const currentColor = () => (penById(penId).kind === "pencil" ? PENCIL_COLOR : inkColor);

  // ----- Text, the identity of every letter, and formatting -----
  const initialText = normaliseText(loadPreference("sheet.text", store.get().phrase));
  let lastText = initialText;
  let charIds = loadPreference<number[]>("sheet.textIds", []);
  if (charIds.length !== initialText.length) charIds = defaultCharIds(initialText);
  let marks = loadPreference<number[]>("sheet.textMarks", []);
  if (marks.length !== initialText.length) marks = new Array<number>(initialText.length).fill(0);
  let paragraphs = loadPreference<number[]>("sheet.paragraphs", []);
  if (paragraphs.length !== paragraphCount(initialText)) paragraphs = new Array<number>(paragraphCount(initialText)).fill(0);
  let paper: PaperSettings = { ...DEFAULT_PAPER, ...loadPreference<Partial<PaperSettings>>("sheet.paper", {}) };
  let titleUnderline = loadPreference("sheet.titleUnderline", true);
  /** Marks chosen with the cursor still (Ctrl+B and then typing). */
  let pendingMarks: number | null = null;
  let highlightColor = loadPreference("sheet.highlightColor", 0);

  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  let lastTypingAt = 0;

  /** Marks a typed character takes: those of the letter before it (or after, at a paragraph start). */
  const marksAt = (index: number): number => {
    if (pendingMarks !== null) return pendingMarks;
    if (index > 0 && lastText[index - 1] !== "\n") return marks[index - 1] ?? 0;
    if (index < lastText.length && lastText[index] !== "\n") return marks[index] ?? 0;
    return 0;
  };

  const snapshot = (start: number, end: number): Snapshot => ({ text: lastText, ids: charIds, marks, paragraphs, start, end });

  /** Saves the state before a change, so it can be undone. Typing in a row is one step. */
  const pushUndo = (before: Snapshot, typing: boolean) => {
    const now = performance.now();
    const grouped = typing && now - lastTypingAt < TYPING_GROUP_MS && undoStack.length > 0;
    lastTypingAt = typing ? now : 0;
    redoStack.length = 0;
    if (grouped) return;
    undoStack.push(before);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  };

  /** New identities after an edit: unchanged letters keep theirs, so they keep their look. */
  function idsAfterEdit(text: string): number[] {
    const ids = updateCharIds(lastText, charIds, text, randomCharId);
    if (viewOptions().typingAnimation) {
      // Optional cartoon effect: the edited word gets new drawings on every key.
      const { start, end } = editedWordRange(lastText, text);
      for (let i = start; i < end; i++) ids[i] = randomCharId();
    }
    return ids;
  }

  // ----- Pages -----
  let textSaveTimer: number | undefined;
  const saveTextNow = () => {
    window.clearTimeout(textSaveTimer);
    savePreference("sheet.text", lastText);
    savePreference("sheet.textIds", charIds);
    savePreference("sheet.textMarks", marks);
    savePreference("sheet.paragraphs", paragraphs);
  };
  const saveTextSoon = () => {
    window.clearTimeout(textSaveTimer);
    textSaveTimer = window.setTimeout(saveTextNow, 300);
  };
  // Closing right after typing must not lose the last letters.
  window.addEventListener("pagehide", saveTextNow);
  const editor = createPageEditor({
    initialText,
    onInput: (raw, before) => {
      const text = normaliseText(raw);
      const edit = diffTexts(lastText, text);
      const typing = edit.inserted <= 1 && lastText.length - edit.prefix - edit.suffix <= 1;
      pushUndo(snapshot(before.start, before.end), typing);
      const typed = marksAt(edit.prefix);
      charIds = idsAfterEdit(text);
      marks = updateMarks(lastText, marks, text, typed);
      paragraphs = updateParagraphs(lastText, paragraphs, text);
      lastText = text;
      pendingMarks = null;
      afterTextChange(TYPING_RENDER_DELAY);
    },
    onSelectionChange: () => {
      pendingMarks = null;
      updateToolbar();
    },
    onCommand: (command) => void runCommand(command),
  });

  /** After the text or its formatting changed: save, mark the document, lay out and draw. */
  function afterTextChange(delay = 0): void {
    saveTextSoon();
    changed();
    relayout();
    updateToolbar();
    scheduleRender(delay);
  }

  function restore(state: Snapshot): void {
    lastText = state.text;
    charIds = state.ids;
    marks = state.marks;
    paragraphs = state.paragraphs;
    pendingMarks = null;
    editor.setText(state.text, state.start, state.end);
    afterTextChange();
  }

  function undo(): void {
    const previous = undoStack.pop();
    if (!previous) return;
    const sel = editor.selection();
    redoStack.push(snapshot(sel.start, sel.end));
    lastTypingAt = 0;
    restore(previous);
  }

  function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    const sel = editor.selection();
    undoStack.push(snapshot(sel.start, sel.end));
    lastTypingAt = 0;
    restore(next);
  }

  // ----- Formatting commands (toolbar, Formato menu, shortcuts) -----
  const FLAGS: Record<string, number> = { bold: BOLD, italic: ITALIC, underline: UNDERLINE, strike: STRIKE, highlight: HIGHLIGHT };

  function changeFormatting(apply: () => void): void {
    const sel = editor.selection();
    pushUndo(snapshot(sel.start, sel.end), false);
    apply();
    afterTextChange();
  }

  function toggleFlag(flag: number, color = highlightColor, forceOn?: boolean): void {
    const { start, end } = editor.selection();
    if (start === end) {
      // No selection: what you type next gets (or loses) the mark.
      const current = marksAt(start);
      const on = forceOn ?? !(current & flag);
      pendingMarks = on ? (flag === HIGHLIGHT ? setMark([current], 0, 1, flag, true, color)[0] : current | flag) : current & ~flag;
      updateToolbar();
      return;
    }
    const on = forceOn ?? !rangeHasMark(lastText, marks, start, end, flag);
    changeFormatting(() => (marks = setMark(marks, start, end, flag, on, color)));
  }

  function setParagraphs(change: (format: { style: ParagraphStyle; align: Alignment }) => { style: ParagraphStyle; align: Alignment }): void {
    const { start, end } = editor.selection();
    const { first, last } = paragraphsInRange(lastText, start, end);
    changeFormatting(() => {
      paragraphs = paragraphs.slice();
      for (let p = first; p <= last; p++) paragraphs[p] = encodeParagraph(change(decodeParagraph(paragraphs[p] ?? 0)));
    });
  }

  function runCommand(command: string): boolean {
    const [kind, value] = command.split(":");
    if (command === "undo") undo();
    else if (command === "redo") redo();
    else if (kind === "format" && value === "clear") {
      const { start, end } = editor.selection();
      if (start === end) pendingMarks = 0;
      else changeFormatting(() => (marks = setMark(setMark(marks, start, end, 0xff, false), start, end, 0, false)));
      updateToolbar();
    } else if (kind === "format" && FLAGS[value]) toggleFlag(FLAGS[value]);
    else if (kind === "highlight") {
      if (value === "none") toggleFlag(HIGHLIGHT, highlightColor, false);
      else {
        highlightColor = Number(value) || 0;
        savePreference("sheet.highlightColor", highlightColor);
        toggleFlag(HIGHLIGHT, highlightColor, true);
      }
    } else if (kind === "style") setParagraphs((format) => ({ ...format, style: value as ParagraphStyle }));
    else if (kind === "align") setParagraphs((format) => ({ ...format, align: value as Alignment }));
    else return false;
    if (store.get().tab === "sheet") editor.focus();
    return true;
  }
  const previewScroll = h("div", { class: "sheet-scroll" }, editor.root);
  const zoom = createZoomControl({
    scroller: previewScroll,
    content: () => editor.root,
    min: ZOOM_MIN,
    max: ZOOM_MAX,
    actualSize: true,
    fit: () => {
      const width = previewScroll.clientWidth - 48;
      const height = previewScroll.clientHeight - 48;
      const fit = Math.min(width / page.widthMm, height / page.heightMm) / CSS_PX_PER_MM;
      return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit));
    },
    apply: (scale) => {
      // Resize at once (blurry for a moment), redraw sharp when the zoom settles.
      editor.setScale(CSS_PX_PER_MM * scale);
      drawnSignatures = [];
      scheduleRender(ZOOM_RENDER_DELAY);
    },
  });
  const printedToggle = h("input", { type: "checkbox", checked: viewOptions().printedLook });
  printedToggle.addEventListener("change", () => setViewOption("printedLook", printedToggle.checked));
  const printedLabel = h("label", { class: "check toggle-chip", title: es.sheet.printedLookHelp }, printedToggle, es.sheet.printedLook);
  onViewOptions((options) => {
    printedToggle.checked = options.printedLook;
    scheduleRender(0);
  });
  const toolbar = createToolbar((command) => void runCommand(command), [zoom.bar, printedLabel]);
  const ruler = createRuler({
    pageGeometry: () => {
      const first = editor.pages().find((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const view = previewScroll.getBoundingClientRect();
        return rect.bottom > view.top && rect.top < view.bottom;
      });
      if (!first) return null;
      return { left: first.getBoundingClientRect().left, pxPerMm: CSS_PX_PER_MM * zoom.scale() };
    },
    margins: () => ({ left: page.marginLeftMm, right: page.marginRightMm, width: page.widthMm }),
    onChange: (left, right) => {
      page = { ...page, marginLeftMm: left, marginRightMm: right };
      pageSetters.get("marginLeftMm")?.(left);
      pageSetters.get("marginRightMm")?.(right);
      persist();
      relayout();
      scheduleRender();
    },
  });
  const previewArea = h("section", { class: "sheet-preview" }, toolbar.root, ruler.root, previewScroll);
  previewScroll.addEventListener(
    "scroll",
    () => {
      scheduleRender(60);
      ruler.redraw();
    },
    { passive: true },
  );

  function updateToolbar(): void {
    const { start, end } = editor.selection();
    const collapsed = start === end;
    const has = (flag: number) => (collapsed ? Boolean(marksAt(start) & flag) : rangeHasMark(lastText, marks, start, end, flag));
    const paragraph = decodeParagraph(paragraphs[paragraphsInRange(lastText, start, end).first] ?? 0);
    toolbar.update({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      style: paragraph.style,
      align: paragraph.align,
      bold: has(BOLD),
      italic: has(ITALIC),
      underline: has(UNDERLINE),
      strike: has(STRIKE),
      highlight: has(HIGHLIGHT),
      highlightColor: collapsed && marksAt(start) & HIGHLIGHT ? highlightColorIndex(marksAt(start)) : highlightColor,
    });
  }

  // ----- Controls -----
  const warnings = h("div", { class: "warnings" });

  const penSelect = h("select", { class: "select", "aria-label": es.sheet.pen });
  for (const pen of PENS) penSelect.append(h("option", { value: pen.id }, pen.label));
  penSelect.value = penById(penId).id;
  penSelect.addEventListener("change", () => {
    penId = penSelect.value;
    persist();
    renderSwatches();
    scheduleRender();
  });

  const swatchRows = h("div", { class: "swatch-rows" });
  const customColor = createColorPopover(
    inkColor,
    (value) => {
      inkColor = value;
      persist();
      renderSwatches();
      scheduleRender();
    },
    (value) => {
      recentColors = [value, ...recentColors.filter((c) => c.toLowerCase() !== value.toLowerCase())].slice(0, MAX_RECENT_COLORS);
      persist();
      renderSwatches();
    },
  );
  const colorPicker = h("div", { class: "color-picker" }, swatchRows, customColor.root);

  function renderSwatches(): void {
    const disabled = penById(penId).kind === "pencil";
    const swatch = (value: string, label: string) => {
      const element = h("button", {
        type: "button",
        class: `swatch${value.toLowerCase() === inkColor.toLowerCase() ? " selected" : ""}`,
        title: label,
        "aria-label": label,
        disabled,
      });
      element.style.background = value;
      element.addEventListener("click", () => {
        inkColor = value;
        customColor.setColor(value);
        persist();
        renderSwatches();
        scheduleRender();
      });
      return element;
    };
    swatchRows.replaceChildren(h("div", { class: "swatches" }, ...INK_COLORS.map((c) => swatch(c.value, c.label))));
    if (recentColors.length > 0) swatchRows.append(h("div", { class: "swatches recent" }, ...recentColors.map((c) => swatch(c, c))));
    customColor.setDisabled(disabled);
  }

  const tuningSetters = new Map<keyof typeof penTuning, (value: number) => void>();
  const pageSetters = new Map<keyof PageSettings, (value: number) => void>();
  const remembered = <T>(map: Map<T, (value: number) => void>, key: T, control: { root: HTMLElement; set: (value: number) => void }) => {
    map.set(key, control.set);
    return control.root;
  };

  const tuningSlider = (label: string, key: keyof typeof penTuning, min: number, max: number) =>
    remembered(tuningSetters, key, slider({
      label,
      min,
      max,
      step: 0.01,
      value: penTuning[key],
      format: percent,
      onInput: (value) => {
        penTuning = { ...penTuning, [key]: value };
        persist();
        scheduleRender();
      },
    }));

  /** Spacing is stored in x-heights; shown in millimetres at the current letter size. */
  const spacingFormat = (value: number) => mmFormat(value * page.xHeightMm);

  const pageSlider = (label: string, key: keyof PageSettings, min: number, max: number, step: number, format = mmFormat) =>
    remembered(pageSetters, key, slider({
      label,
      min,
      max,
      step,
      value: page[key],
      format,
      onInput: (value) => {
        page = { ...page, [key]: value };
        persist();
        relayout();
        scheduleRender();
      },
    }));

  const presetSelect = h("select", { class: "select", "aria-label": es.sheet.preset });
  for (const preset of PRESETS) presetSelect.append(h("option", { value: preset.id }, preset.label));
  presetSelect.append(h("option", { value: "custom" }, es.sheet.custom));
  presetSelect.value = presetId;

  const naturalSliders = new Map<keyof Naturalness, (value: number) => void>();
  const naturalControls = NATURAL_KEYS.map((key) => {
    const range =
      key === "slantDegrees"
        ? { min: -45, max: 45, step: 1, format: (v: number) => `${Math.round(v)}${es.sheet.degrees}` }
        : key === "lineSlope"
          ? { min: -10, max: 10, step: 0.1, format: slopeFormat }
          : { min: 0, max: NATURAL_MAX, step: 0.01, format: percent };
    const control = slider({
      label: es.sheet.sliders[key],
      ...range,
      value: naturalness[key],
      onInput: (value) => {
        naturalness = { ...naturalness, [key]: value };
        presetId = "custom";
        presetSelect.value = presetId;
        persist();
        relayout();
        scheduleRender();
      },
    });
    naturalSliders.set(key, control.set);
    return control.root;
  });

  const setNaturalness = (values: Naturalness) => {
    naturalness = { ...values };
    for (const key of NATURAL_KEYS) naturalSliders.get(key)?.(naturalness[key]);
  };

  presetSelect.addEventListener("change", () => {
    presetId = presetSelect.value;
    if (presetId !== "custom") setNaturalness(presetById(presetId).values);
    persist();
    relayout();
    scheduleRender();
  });

  const versionLabel = h("span", { class: "muted" }, es.sheet.version(seed));
  const newSeed = () => {
    seed = freshSeed();
    versionLabel.textContent = es.sheet.version(seed);
  };

  const randomButton = button(es.sheet.random, () => {
    newSeed();
    setNaturalness(randomNaturalness(seed));
    presetId = "custom";
    presetSelect.value = presetId;
    persist();
    relayout();
    scheduleRender(0);
  });
  randomButton.title = es.sheet.randomHelp;

  const rewriteButton = button(es.sheet.rewrite, () => {
    newSeed();
    persist();
    relayout();
    scheduleRender(0);
  });
  rewriteButton.title = es.sheet.rewriteHelp;

  const paperSelect = h("select", { class: "select", "aria-label": es.paper.kind });
  for (const kind of PAPER_KINDS) paperSelect.append(h("option", { value: kind }, es.paper.kinds[kind]));
  const paperSpacing = slider({
    label: es.paper.spacing,
    min: 5,
    max: 12,
    step: 0.5,
    value: paper.lineSpacingMm,
    format: mmFormat,
    onInput: (value) => setPaper({ lineSpacingMm: value }),
  });
  const marginLine = h("input", { type: "checkbox" });
  const creamPaper = h("input", { type: "checkbox" });
  const printPaper = h("input", { type: "checkbox" });
  const titleLine = h("input", { type: "checkbox" });
  paperSelect.addEventListener("change", () => setPaper({ kind: paperSelect.value as PaperKind }));
  marginLine.addEventListener("change", () => setPaper({ marginLine: marginLine.checked }));
  creamPaper.addEventListener("change", () => setPaper({ color: creamPaper.checked ? "cream" : "white" }));
  printPaper.addEventListener("change", () => setPaper({ print: printPaper.checked }));
  titleLine.addEventListener("change", () => {
    titleUnderline = titleLine.checked;
    savePreference("sheet.titleUnderline", titleUnderline);
    changed();
    relayout();
    scheduleRender();
  });

  function showPaper(): void {
    paperSelect.value = paper.kind;
    paperSpacing.set(paper.lineSpacingMm);
    paperSpacing.root.hidden = paper.kind !== "lined";
    marginLine.checked = paper.marginLine;
    creamPaper.checked = paper.color === "cream";
    printPaper.checked = paper.print;
    titleLine.checked = titleUnderline;
  }

  function setPaper(change: Partial<PaperSettings>): void {
    paper = { ...paper, ...change };
    savePreference("sheet.paper", paper);
    showPaper();
    changed();
    relayout();
    scheduleRender();
  }

  const busy = h("p", { class: "busy", hidden: true }, es.sheet.preparing);

  const controls = h(
    "aside",
    { class: "panel sheet-controls" },
    warnings,
    h("label", { class: "field-label first" }, es.sheet.pen),
    penSelect,
    h("label", { class: "field-label" }, es.sheet.color),
    colorPicker,
    tuningSlider(es.sheet.widthScale, "widthScale", 0.3, 3),
    tuningSlider(es.sheet.inkStrength, "inkStrength", 0.2, 1.2),
    h("hr"),
    pageSlider(es.sheet.size, "xHeightMm", 1, 15, 0.1),
    pageSlider(es.sheet.lineSpacing, "lineSpacingMm", 3, 40, 0.5),
    pageSlider(es.sheet.letterSpacing, "letterSpacing", -0.3, 2, 0.01, spacingFormat),
    pageSlider(es.sheet.wordSpacing, "wordSpacing", 0.2, 6, 0.05, spacingFormat),
    h("p", { class: "field-label" }, es.sheet.margins),
    pageSlider(es.sheet.marginLeft, "marginLeftMm", 0, 100, 1),
    pageSlider(es.sheet.marginRight, "marginRightMm", 0, 100, 1),
    pageSlider(es.sheet.marginTop, "marginTopMm", 0, 100, 1),
    pageSlider(es.sheet.marginBottom, "marginBottomMm", 0, 100, 1),
    h("label", { class: "check" }, titleLine, es.sheet.titleUnderline),
    h("hr"),
    h("h3", { class: "panel-subtitle" }, es.paper.title),
    paperSelect,
    paperSpacing.root,
    h("label", { class: "check" }, marginLine, es.paper.marginLine),
    h("label", { class: "check" }, creamPaper, es.paper.cream),
    h("label", { class: "check", title: es.paper.printHelp }, printPaper, es.paper.print),
    h("hr"),
    h("h3", { class: "panel-subtitle" }, es.sheet.naturalness),
    h("label", { class: "field-label" }, es.sheet.preset),
    presetSelect,
    h("div", { class: "button-row" }, randomButton),
    h("p", { class: "muted" }, es.sheet.randomHelp),
    ...naturalControls,
    h("hr"),
    h("div", { class: "inline spaced" }, rewriteButton, versionLabel),
    h("p", { class: "muted" }, es.sheet.rewriteHelp),
    h("hr"),
    h("div", { class: "button-row" }, button(es.sheet.print, () => void output("print"), "primary"), button(es.sheet.exportPdf, () => void output("pdf"))),
    busy,
    h("p", { class: "muted" }, es.sheet.printTip),
  );

  const root = h("div", { class: "sheet-view" }, previewArea, controls);

  // ----- Layout and rendering -----
  function renderWarnings(result: LayoutResult): void {
    const items: HTMLElement[] = [];
    if (result.missing.length > 0) {
      const add = button(es.sheet.addMissing, () => {
        const state = store.get();
        const known = new Set([...charactersNeeded(state.phrase), ...state.extraChars]);
        const extra = [...state.extraChars, ...result.missing.filter((c) => !known.has(c))];
        // Open "Tu letra" on the first letter that is missing, not on the first of the list.
        store.update({ extraChars: extra, drawFocus: result.missing[0] ?? null, tab: "draw" });
      }, "ghost");
      items.push(h("div", { class: "warning" }, h("span", {}, es.sheet.missing(result.missing.join(" "))), add));
    }
    if (result.overflow) items.push(h("p", { class: "warning" }, es.sheet.overflow));
    warnings.replaceChildren(...items);
  }

  const layoutFormat = (): LayoutFormat => ({ marks, paragraphs, paper, titleUnderline });

  /** Recomputes where everything goes (fast); the drawing follows later. */
  function relayout(): void {
    const hand = store.get().hand;
    layout = layoutText(lastText, hand, page, naturalness, seed, charIds, layoutFormat());
    renderWarnings(layout);
    editor.setLayout(layout, page);
    editor.setEmptyMessage(Object.keys(hand.glyphs).length > 0 ? null : es.sheet.emptyHand);
    ruler.redraw();
  }

  function pageSignature(result: LayoutResult, pageIndex: number, pxPerMm: number, hand: Hand): string {
    const parts: (string | number)[] = [
      pxPerMm,
      penId,
      currentColor(),
      JSON.stringify(naturalness),
      seed,
      JSON.stringify(page),
      JSON.stringify(penTuning),
      String(viewOptions().printedLook),
      JSON.stringify(paper),
      hand.updatedAt,
    ];
    for (const g of result.glyphs) {
      if (g.page !== pageIndex) continue;
      parts.push(g.char, g.variantIndex, g.xMm.toFixed(3), g.yMm.toFixed(3), g.scale.toFixed(4), g.rotation.toFixed(4), g.shear.toFixed(4), g.seed, g.bold ? 1 : 0);
    }
    for (const d of result.decorations) {
      if (d.page !== pageIndex) continue;
      parts.push(d.kind, d.x0.toFixed(3), d.y0.toFixed(3), d.x1.toFixed(3), d.y1.toFixed(3), d.color, d.seed);
    }
    return String(hashString(parts.join("|")));
  }

  function render(): void {
    if (!layout) relayout();
    const result = layout!;
    const hand = store.get().hand;
    let backing = CSS_PX_PER_MM * zoom.scale() * (window.devicePixelRatio || 1);
    const pixels = page.widthMm * page.heightMm * backing * backing;
    if (pixels > MAX_PREVIEW_PIXELS) backing *= Math.sqrt(MAX_PREVIEW_PIXELS / pixels);
    const canvases = editor.pages();
    // Only the pages on screen (and one screen around): long texts stay fast.
    const view = previewScroll.getBoundingClientRect();
    const margin = view.height;
    canvases.forEach((canvas, pageIndex) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.bottom < view.top - margin || rect.top > view.bottom + margin) return;
      const signature = pageSignature(result, pageIndex, backing, hand);
      if (drawnSignatures[pageIndex] === signature) return;
      renderPage(canvas, result, hand, page, {
        pxPerMm: backing,
        pen: penById(penId),
        color: currentColor(),
        naturalness,
        seed,
        pageIndex,
        background: "white",
        widthScale: penTuning.widthScale,
        inkStrength: penTuning.inkStrength,
        printedLook: viewOptions().printedLook,
        paper,
        drawPaper: true,
      });
      drawnSignatures[pageIndex] = signature;
    });
    drawnSignatures.length = canvases.length;
  }

  function scheduleRender(delay = 80): void {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => requestAnimationFrame(render), delay);
  }

  async function output(kind: "print" | "pdf"): Promise<void> {
    const hand = store.get().hand;
    if (Object.keys(hand.glyphs).length === 0) {
      toast(es.sheet.emptyHand);
      return;
    }
    busy.hidden = false;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    const printRoot = document.getElementById("print-root")!;
    const urls: string[] = [];
    try {
      const result = layoutText(lastText, hand, page, naturalness, seed, charIds, layoutFormat());
      const pxPerMm = PRINT_DPI / MM_PER_INCH;
      // Printing keeps the ink transparent (lossless PNG). The PDF gets the ink on
      // white as high-quality JPEG: PDF viewers open it much faster and the file is
      // several times smaller, with no visible difference on paper.
      const forPdf = kind === "pdf";
      const sheets: HTMLElement[] = [];
      for (let pageIndex = 0; pageIndex < result.pageCount; pageIndex++) {
        busy.textContent = es.sheet.preparingPage(pageIndex + 1, result.pageCount);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const canvas = document.createElement("canvas");
        const box = renderPage(canvas, result, hand, page, {
          pxPerMm,
          pen: penById(penId),
          color: currentColor(),
          naturalness,
          seed,
          pageIndex,
          background: forPdf ? "white" : "transparent",
          widthScale: penTuning.widthScale,
          inkStrength: penTuning.inkStrength,
          paper,
          drawPaper: paper.print,
        });
        const sheet = h("div", { class: "print-page" });
        if (box) {
          // Only the part with ink goes into the PDF: much lighter to open and scroll.
          const crop = document.createElement("canvas");
          crop.width = box.width;
          crop.height = box.height;
          crop.getContext("2d")!.drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
          const blob = await new Promise<Blob | null>((resolve) =>
            forPdf ? crop.toBlob(resolve, "image/jpeg", PDF_JPEG_QUALITY) : crop.toBlob(resolve, "image/png"),
          );
          if (!blob) throw new Error("png");
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const image = h("img", { class: "print-ink", alt: "", src: url });
          image.style.left = `${box.x / pxPerMm}mm`;
          image.style.top = `${box.y / pxPerMm}mm`;
          image.style.width = `${box.width / pxPerMm}mm`;
          image.style.height = `${box.height / pxPerMm}mm`;
          await image.decode();
          sheet.append(image);
          crop.width = 0;
        }
        canvas.width = 0;
        sheets.push(sheet);
      }
      printRoot.replaceChildren(...sheets);
      busy.hidden = true;
      if (kind === "print") {
        const outcome = await bridge.printPage();
        if (!outcome.ok && outcome.reason && outcome.reason !== "cancelled") toast(`${es.sheet.printFailed} (${outcome.reason})`);
      } else {
        const file = await bridge.exportPdf();
        if (file) toast(es.sheet.pdfSaved(file));
      }
    } catch {
      toast(es.sheet.printFailed);
    } finally {
      busy.hidden = true;
      busy.textContent = es.sheet.preparing;
      printRoot.replaceChildren();
      for (const url of urls) URL.revokeObjectURL(url);
    }
  }

  store.subscribe((state, previous) => {
    if (state.hand !== previous.hand) {
      relayout();
      if (state.tab === "sheet") scheduleRender();
    }
  });
  window.addEventListener("resize", () => {
    if (store.get().tab === "sheet") zoom.refit();
  });

  renderSwatches();
  showPaper();

  const currentSettings = (): SheetSettings => ({ penId, inkColor, penTuning, page, presetId, naturalness, seed, paper, titleUnderline });

  const documentApi: SheetDocumentApi = {
    getDocument: () => ({ text: lastText, charIds, marks, paragraphs, settings: currentSettings() }),
    currentSettings,
    loadDocument(doc) {
      applyingDocument = true;
      try {
        penId = penById(doc.settings.penId).id;
        inkColor = doc.settings.inkColor;
        penTuning = { ...doc.settings.penTuning };
        page = { ...doc.settings.page };
        presetId = doc.settings.presetId === "random" ? "custom" : doc.settings.presetId;
        seed = doc.settings.seed;
        paper = { ...doc.settings.paper };
        titleUnderline = doc.settings.titleUnderline;
        savePreference("sheet.paper", paper);
        savePreference("sheet.titleUnderline", titleUnderline);
        showPaper();
        penSelect.value = penId;
        customColor.setColor(inkColor);
        renderSwatches();
        for (const [key, set] of tuningSetters) set(penTuning[key]);
        for (const [key, set] of pageSetters) set(page[key]);
        setNaturalness(doc.settings.naturalness);
        presetSelect.value = presetId;
        versionLabel.textContent = es.sheet.version(seed);
        lastText = doc.text;
        charIds = doc.charIds.length === doc.text.length ? doc.charIds : defaultCharIds(doc.text);
        marks = doc.marks.length === doc.text.length ? doc.marks : new Array<number>(doc.text.length).fill(0);
        paragraphs = doc.paragraphs.length === paragraphCount(doc.text) ? doc.paragraphs : new Array<number>(paragraphCount(doc.text)).fill(0);
        undoStack.length = 0;
        redoStack.length = 0;
        pendingMarks = null;
        editor.setText(lastText);
        persist();
        saveTextNow();
        drawnSignatures = [];
        relayout();
        updateToolbar();
        zoom.refit();
        scheduleRender(0);
      } finally {
        applyingDocument = false;
      }
    },
    command: (command) => runCommand(command),
    onChange: (listener) => changeListeners.add(listener),
    flush: saveTextNow,
    print: () => output("print"),
    exportPdf: () => output("pdf"),
  };

  return {
    root,
    document: documentApi,
    onShow() {
      relayout();
      // The preview only has a size once the view is visible.
      requestAnimationFrame(() => {
        zoom.refit();
        editor.focus();
        scheduleRender(0);
      });
    },
  };
}
