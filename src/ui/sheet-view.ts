// "Hoja": the user writes directly on A4 pages in their own hand, picks the
// pen and the imperfections, and prints or exports a PDF at true size.

import { bridge, loadPreference, savePreference } from "../bridge";
import { editedWordRange, randomCharId, updateCharIds } from "../engine/char-ids";
import type { ChiroDocument, SheetSettings } from "../engine/document";
import { charactersNeeded, type Hand } from "../engine/hand";
import { defaultCharIds, layoutText, normaliseText, type LayoutFormat, type LayoutResult } from "../engine/layout";
import { DEFAULT_PEN_ID, INK_COLORS, PENCIL_COLOR, penById } from "../engine/pens";
import { freshSeed, hashString } from "../engine/random";
import { renderPage } from "../engine/render";
import {
  applyRunStyle,
  BOLD,
  clearFlags,
  decodeParagraph,
  diffTexts,
  encodeParagraph,
  HIGHLIGHT,
  highlightColorIndex,
  ITALIC,
  paragraphCount,
  paragraphsInRange,
  DEFAULT_SCRIBBLE,
  rangeHasMark,
  runStyleIndex,
  SCRIBBLE,
  SCRIBBLE_KINDS,
  scribbleFields,
  scribbleStyleOf,
  setMark,
  STRIKE,
  UNDERLINE,
  updateMarks,
  updateParagraphs,
  upgradeMarkV1,
  withRunStyle,
  type Alignment,
  type ParagraphStyle,
  type RunStyle,
  type ScribbleKind,
  type ScribbleStyle,
} from "../engine/rich-text";
import {
  A4,
  DEFAULT_PAPER,
  DEFAULT_PRESET_ID,
  PRESETS,
  presetById,
  randomNaturalness,
  scaledNaturalness,
  type Naturalness,
  type PageSettings,
  type PaperKind,
  type PaperSettings,
} from "../engine/settings";
import { es } from "../i18n/es";
import type { Store } from "../store";
import { onViewOptions, setViewOption, viewOptions } from "../view-options";
import { button, h, percent, searchKey, slider, toast } from "./dom";
import { createPageEditor } from "./page-editor";
import { createRuler } from "./ruler";
import { createToolbar } from "./toolbar";
import { createZoomControl } from "./zoom";

const PRINT_DPI = 600;
const PDF_JPEG_QUALITY = 0.92;
const MM_PER_INCH = 25.4;
const CSS_PX_PER_MM = 96 / MM_PER_INCH;
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
  runStyles: RunStyle[];
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
  "highlighterSmear",
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
  // Version 0.1 kept the highlighter colour in other bits.
  if (loadPreference("sheet.marksVersion", 1) < 2) {
    marks = marks.map(upgradeMarkV1);
    savePreference("sheet.marksVersion", 2);
  }
  /** Instruments, colours and sizes chosen for parts of the text. */
  let runStyles = loadPreference<RunStyle[]>("sheet.runStyles", []);
  let naturalnessAmount = loadPreference("sheet.naturalnessAmount", 1);
  let paragraphs = loadPreference<number[]>("sheet.paragraphs", []);
  if (paragraphs.length !== paragraphCount(initialText)) paragraphs = new Array<number>(paragraphCount(initialText)).fill(0);
  /** Only the fields the app knows (0.1 also kept a paper colour). */
  const cleanPaper = (value: Partial<PaperSettings>): PaperSettings => ({
    kind: value.kind ?? DEFAULT_PAPER.kind,
    lineSpacingMm: value.lineSpacingMm ?? DEFAULT_PAPER.lineSpacingMm,
    marginLine: value.marginLine ?? DEFAULT_PAPER.marginLine,
    print: value.print ?? DEFAULT_PAPER.print,
  });
  let paper = cleanPaper(loadPreference<Partial<PaperSettings>>("sheet.paper", {}));
  let titleUnderline = loadPreference("sheet.titleUnderline", true);
  /** Marks chosen with the cursor still (Ctrl+B and then typing). */
  let pendingMarks: number | null = null;
  let highlightColor = loadPreference("sheet.highlightColor", 0);
  /** The last scribble chosen: the next one looks the same. */
  let lastScribble: ScribbleStyle = { ...DEFAULT_SCRIBBLE, ...loadPreference<Partial<ScribbleStyle>>("sheet.scribbleLast", {}) };

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

  const snapshot = (start: number, end: number): Snapshot => ({ text: lastText, ids: charIds, marks, paragraphs, runStyles, start, end });

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
    savePreference("sheet.runStyles", runStyles);
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
    runStyles = state.runStyles;
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
  const FLAGS: Record<string, number> = { bold: BOLD, italic: ITALIC, underline: UNDERLINE, strike: STRIKE, highlight: HIGHLIGHT, scribble: SCRIBBLE };

  /** Instrument, colour or size for the selection (or for what is typed next). */
  function changeRunStyle(requested: RunStyle): void {
    const change = { ...requested };
    // The document's own instrument and colour need no style of their own.
    if ("penId" in change && change.penId === penId) change.penId = undefined;
    if ("color" in change && change.color?.toLowerCase() === inkColor.toLowerCase()) change.color = undefined;
    const { start, end } = editor.selection();
    if (start === end) {
      const result = applyRunStyle([marksAt(start)], runStyles, 0, 1, change);
      runStyles = result.styles;
      pendingMarks = result.marks[0];
      updateToolbar();
      return;
    }
    changeFormatting(() => {
      const result = applyRunStyle(marks, runStyles, start, end, change);
      marks = result.marks;
      runStyles = result.styles;
    });
  }

  /** The run style of the selection's first letter, or what the cursor will type. */
  const selectionStyle = (): RunStyle => {
    const { start, end } = editor.selection();
    const style = runStyleIndex(end > start ? (marks[start] ?? 0) : marksAt(start));
    return style > 0 ? runStyles[style - 1] ?? {} : {};
  };

  function changeFormatting(apply: () => void): void {
    const sel = editor.selection();
    pushUndo(snapshot(sel.start, sel.end), false);
    apply();
    afterTextChange();
  }

  /** Scribbles out the selection (or what is typed next) with the last look chosen, changed by `change`. */
  function scribbleOut(change: Partial<ScribbleStyle>): void {
    const { start, end } = editor.selection();
    const scribbled = start === end ? Boolean(marksAt(start) & SCRIBBLE) : rangeHasMark(lastText, marks, start, end, SCRIBBLE);
    const look = { ...(scribbled ? scribbleStyleOf(selectionStyle()) : lastScribble), ...change };
    lastScribble = look;
    savePreference("sheet.scribbleLast", look);
    const fields = scribbleFields(look);
    if (start === end) {
      const result = applyRunStyle([marksAt(start) | SCRIBBLE], runStyles, 0, 1, fields);
      runStyles = result.styles;
      pendingMarks = result.marks[0];
      updateToolbar();
      return;
    }
    changeFormatting(() => {
      const result = applyRunStyle(setMark(marks, start, end, SCRIBBLE, true), runStyles, start, end, fields);
      marks = result.marks;
      runStyles = result.styles;
    });
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
      else changeFormatting(() => (marks = clearFlags(marks, start, end).map((m, i) => (i >= start && i < end ? withRunStyle(m, 0) : m))));
      updateToolbar();
    } else if (command === "format:scribble") {
      const { start, end } = editor.selection();
      const on = start === end ? !(marksAt(start) & SCRIBBLE) : !rangeHasMark(lastText, marks, start, end, SCRIBBLE);
      if (on) scribbleOut({});
      else toggleFlag(SCRIBBLE, highlightColor, false);
    } else if (command === "scribble:none") toggleFlag(SCRIBBLE, highlightColor, false);
    else if (kind === "scribble-kind" && (SCRIBBLE_KINDS as readonly string[]).includes(value)) scribbleOut({ kind: value as ScribbleKind });
    else if (kind === "scribble-rage") scribbleOut({ rage: Math.max(0, Math.min(1, Number(value) || 0)) });
    else if (kind === "scribble-width") scribbleOut({ width: Math.max(0.3, Math.min(4, Number(value) || 1)) });
    else if (kind === "scribble-words") scribbleOut({ perWord: value === "1" });
    else if (command === "view:settingsPanel") setViewOption("settingsPanel", !viewOptions().settingsPanel);
    else if (kind === "format" && FLAGS[value]) toggleFlag(FLAGS[value]);
    else if (kind === "highlight") {
      if (value === "none") toggleFlag(HIGHLIGHT, highlightColor, false);
      else {
        highlightColor = Number(value) || 0;
        savePreference("sheet.highlightColor", highlightColor);
        toggleFlag(HIGHLIGHT, highlightColor, true);
      }
    } else if (kind === "pen") changeRunStyle({ penId: value === "default" ? undefined : penById(value).id });
    else if (kind === "ink" && /^#[0-9a-f]{6}$/i.test(value)) changeRunStyle({ color: value });
    else if (kind === "size") changeRunStyle({ size: Number(value) || 1 });
    else if (kind === "style") setParagraphs((format) => ({ ...format, style: value as ParagraphStyle }));
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
    const selected = selectionStyle();
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
      scribble: has(SCRIBBLE),
      penId: penById(selected.penId ?? penId).id,
      inkColor: selected.color ?? inkColor,
      inkDisabled: penById(selected.penId ?? penId).kind === "pencil",
      size: selected.size ?? 1,
      scribbleStyle: has(SCRIBBLE) ? scribbleStyleOf(selected) : lastScribble,
      highlightColor: collapsed && marksAt(start) & HIGHLIGHT ? highlightColorIndex(marksAt(start)) : highlightColor,
    });
  }

  // ----- Controls -----
  const warnings = h("div", { class: "warnings" });

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
      defaultValue: 1,
      format: percent,
      onInput: (value) => {
        penTuning = { ...penTuning, [key]: value };
        persist();
        scheduleRender();
      },
    }));

  /** Spacing is stored in x-heights; shown in millimetres at the current letter size. */
  const spacingFormat = (value: number) => mmFormat(value * page.xHeightMm);

  const pageSlider = (label: string, key: keyof PageSettings, min: number, max: number, step: number, format = mmFormat, search?: string) =>
    remembered(pageSetters, key, slider({
      label,
      search,
      min,
      max,
      step,
      value: page[key],
      defaultValue: A4[key],
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
      defaultValue: presetById(DEFAULT_PRESET_ID).values[key],
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
    defaultValue: DEFAULT_PAPER.lineSpacingMm,
    format: mmFormat,
    onInput: (value) => setPaper({ lineSpacingMm: value }),
  });
  const marginLine = h("input", { type: "checkbox" });
  const printPaper = h("input", { type: "checkbox" });
  const titleLine = h("input", { type: "checkbox" });
  paperSelect.addEventListener("change", () => setPaper({ kind: paperSelect.value as PaperKind }));
  marginLine.addEventListener("change", () => setPaper({ marginLine: marginLine.checked }));
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
    printPaper.checked = paper.print;
    titleLine.checked = titleUnderline;
  }

  function setPaper(change: Partial<PaperSettings>): void {
    paper = cleanPaper({ ...paper, ...change });
    savePreference("sheet.paper", paper);
    showPaper();
    changed();
    relayout();
    scheduleRender();
  }

  const busy = h("p", { class: "busy", hidden: true }, es.sheet.preparing);

  // ----- The settings panel: sections that fold, a search box and resets -----
  const amountSlider = slider({
    label: es.sheet.naturalnessAmount,
    min: 0,
    max: NATURAL_MAX,
    step: 0.01,
    value: naturalnessAmount,
    defaultValue: 1,
    format: percent,
    onInput: (value) => {
      naturalnessAmount = value;
      savePreference("sheet.naturalnessAmount", naturalnessAmount);
      persist();
      relayout();
      scheduleRender();
    },
  });

  /** A setting that is not a slider, findable with the search box. */
  const field = (label: string, ...children: (Node | string)[]) =>
    h("div", { class: "field", "data-search": searchKey(label) }, h("label", { class: "field-label" }, label), ...children);
  const check = (input: HTMLInputElement, label: string, title?: string) =>
    h("label", { class: "check", "data-search": searchKey(`${label} ${title ?? ""}`), title }, input, label);

  const sections: HTMLDetailsElement[] = [];
  const openSections = loadPreference<Record<string, boolean>>("sheet.openSections", {});
  const section = (id: string, title: string, onReset: () => void, ...children: Node[]) => {
    const reset = h("button", { type: "button", class: "section-reset", title: es.panel.resetHelp(title) }, es.panel.reset);
    reset.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onReset();
      toast(es.panel.resetDone(title));
    });
    const details = h("details", { class: "panel-section", "data-id": id, open: openSections[id] ?? true }, h("summary", {}, h("span", { class: "section-title" }, title), reset), h("div", { class: "section-body" }, ...children));
    details.addEventListener("toggle", () => {
      if (searchInput.value) return;
      openSections[id] = details.open;
      savePreference("sheet.openSections", openSections);
    });
    sections.push(details);
    return details;
  };

  const resetInk = () => {
    penTuning = { widthScale: 1, inkStrength: 1 };
    for (const [key, set] of tuningSetters) set(penTuning[key]);
    persist();
    scheduleRender();
  };
  const resetPage = () => {
    page = { ...A4 };
    for (const [key, set] of pageSetters) set(page[key]);
    titleUnderline = true;
    savePreference("sheet.titleUnderline", titleUnderline);
    showPaper();
    persist();
    relayout();
    scheduleRender();
  };
  const resetNaturalness = () => {
    presetId = DEFAULT_PRESET_ID;
    presetSelect.value = presetId;
    setNaturalness(presetById(presetId).values);
    naturalnessAmount = 1;
    amountSlider.set(1);
    savePreference("sheet.naturalnessAmount", 1);
    persist();
    relayout();
    scheduleRender();
  };

  const advanced = h(
    "details",
    { class: "advanced", open: loadPreference("sheet.advancedOpen", false) },
    h("summary", {}, es.panel.advanced),
    h("p", { class: "muted" }, es.panel.advancedHelp),
    ...naturalControls,
  );
  advanced.addEventListener("toggle", () => {
    if (!searchInput.value) savePreference("sheet.advancedOpen", advanced.open);
  });

  const searchInput = h("input", { type: "search", class: "text-input panel-search", placeholder: es.panel.search, "aria-label": es.panel.search });
  const noResults = h("p", { class: "muted", hidden: true }, es.panel.noResults);
  searchInput.addEventListener("input", () => {
    const query = searchKey(searchInput.value.trim());
    let any = false;
    for (const details of sections) {
      let matches = 0;
      for (const item of details.querySelectorAll<HTMLElement>("[data-search]")) {
        const hit = !query || (item.dataset.search ?? "").includes(query);
        item.classList.toggle("search-hidden", !hit);
        if (hit) matches++;
      }
      const titleHit = !!query && searchKey(details.querySelector(".section-title")?.textContent ?? "").includes(query);
      if (titleHit) for (const item of details.querySelectorAll<HTMLElement>("[data-search]")) item.classList.remove("search-hidden");
      details.hidden = !!query && matches === 0 && !titleHit;
      if (query) details.open = matches > 0 || titleHit;
      else details.open = openSections[details.dataset.id ?? ""] ?? true;
      any ||= !details.hidden;
    }
    advanced.open = query ? advanced.querySelector("[data-search]:not(.search-hidden)") !== null : loadPreference("sheet.advancedOpen", false);
    noResults.hidden = !query || any;
  });

  const controls = h(
    "aside",
    { class: "panel sheet-controls" },
    searchInput,
    noResults,
    warnings,
    section(
      "ink",
      es.panel.ink,
      resetInk,
      h("p", { class: "muted section-help" }, es.panel.inkHelp),
      tuningSlider(es.sheet.widthScale, "widthScale", 0.3, 3),
      tuningSlider(es.sheet.inkStrength, "inkStrength", 0.2, 1.2),
    ),
    section(
      "page",
      es.panel.page,
      resetPage,
      pageSlider(es.sheet.size, "xHeightMm", 1, 15, 0.1),
      pageSlider(es.sheet.lineSpacing, "lineSpacingMm", 3, 40, 0.5),
      pageSlider(es.sheet.letterSpacing, "letterSpacing", -0.3, 2, 0.01, spacingFormat),
      pageSlider(es.sheet.wordSpacing, "wordSpacing", 0.2, 6, 0.05, spacingFormat),
      h("p", { class: "field-label", "data-search": searchKey([es.sheet.margins, es.sheet.marginLeft, es.sheet.marginRight, es.sheet.marginTop, es.sheet.marginBottom].join(" ")) }, es.sheet.margins),
      pageSlider(es.sheet.marginLeft, "marginLeftMm", 0, 100, 1, mmFormat, es.sheet.margins),
      pageSlider(es.sheet.marginRight, "marginRightMm", 0, 100, 1, mmFormat, es.sheet.margins),
      pageSlider(es.sheet.marginTop, "marginTopMm", 0, 100, 1, mmFormat, es.sheet.margins),
      pageSlider(es.sheet.marginBottom, "marginBottomMm", 0, 100, 1, mmFormat, es.sheet.margins),
      check(titleLine, es.sheet.titleUnderline),
    ),
    section(
      "paper",
      es.paper.title,
      () => setPaper({ ...DEFAULT_PAPER }),
      field(es.paper.kind, paperSelect),
      paperSpacing.root,
      check(marginLine, es.paper.marginLine),
      check(printPaper, es.paper.print, es.paper.printHelp),
    ),
    section(
      "naturalness",
      es.sheet.naturalness,
      resetNaturalness,
      field(es.sheet.preset, presetSelect, h("div", { class: "button-row" }, randomButton), h("p", { class: "muted" }, es.sheet.randomHelp)),
      amountSlider.root,
      advanced,
      h("div", { "data-search": searchKey(`${es.sheet.rewrite} ${es.sheet.rewriteHelp}`) }, h("div", { class: "inline spaced" }, rewriteButton, versionLabel), h("p", { class: "muted" }, es.sheet.rewriteHelp)),
    ),
    h("div", { class: "panel-footer" }, h("div", { class: "button-row" }, button(es.sheet.print, () => void output("print"), "primary"), button(es.sheet.exportPdf, () => void output("pdf"))), busy, h("p", { class: "muted" }, es.sheet.printTip)),
  );

  const root = h("div", { class: "sheet-view" }, previewArea, controls);
  /** The settings panel can be put away to give the page the whole width. */
  const showPanel = (shown: boolean) => {
    root.classList.toggle("panel-hidden", !shown);
    controls.hidden = !shown;
    toolbar.setPanelShown(shown);
    requestAnimationFrame(() => {
      zoom.refit();
      ruler.redraw();
    });
  };
  showPanel(viewOptions().settingsPanel);
  onViewOptions((options) => {
    if (controls.hidden === options.settingsPanel) showPanel(options.settingsPanel);
  });

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

  const layoutFormat = (): LayoutFormat => ({ marks, paragraphs, paper, titleUnderline, runStyles });
  /** The imperfections actually used: the advanced values times the overall amount. */
  const effectiveNaturalness = () => scaledNaturalness(naturalness, naturalnessAmount);

  /** Recomputes where everything goes (fast); the drawing follows later. */
  function relayout(): void {
    const hand = store.get().hand;
    layout = layoutText(lastText, hand, page, effectiveNaturalness(), seed, charIds, layoutFormat());
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
      naturalnessAmount,
      JSON.stringify(runStyles),
      seed,
      JSON.stringify(page),
      JSON.stringify(penTuning),
      String(viewOptions().printedLook),
      JSON.stringify(paper),
      hand.updatedAt,
    ];
    for (const g of result.glyphs) {
      if (g.page !== pageIndex) continue;
      parts.push(g.char, g.variantIndex, g.xMm.toFixed(3), g.yMm.toFixed(3), g.scale.toFixed(4), g.rotation.toFixed(4), g.shear.toFixed(4), g.seed, g.bold ? 1 : 0, g.style);
    }
    for (const d of result.decorations) {
      if (d.page !== pageIndex) continue;
      parts.push(d.kind, d.x0.toFixed(3), d.y0.toFixed(3), d.x1.toFixed(3), d.y1.toFixed(3), d.color, d.style, d.seed);
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
        naturalness: effectiveNaturalness(),
        seed,
        pageIndex,
        runStyles,
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
      const result = layoutText(lastText, hand, page, effectiveNaturalness(), seed, charIds, layoutFormat());
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
          naturalness: effectiveNaturalness(),
          seed,
          pageIndex,
          runStyles,
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

  showPaper();

  const currentSettings = (): SheetSettings => ({ penId, inkColor, penTuning, page, presetId, naturalness, seed, paper, titleUnderline, naturalnessAmount });

  const documentApi: SheetDocumentApi = {
    getDocument: () => ({ text: lastText, charIds, marks, paragraphs, runStyles, settings: currentSettings() }),
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
        paper = cleanPaper(doc.settings.paper);
        titleUnderline = doc.settings.titleUnderline;
        naturalnessAmount = doc.settings.naturalnessAmount;
        amountSlider.set(naturalnessAmount);
        savePreference("sheet.naturalnessAmount", naturalnessAmount);
        savePreference("sheet.paper", paper);
        savePreference("sheet.titleUnderline", titleUnderline);
        showPaper();
        for (const [key, set] of tuningSetters) set(penTuning[key]);
        for (const [key, set] of pageSetters) set(page[key]);
        setNaturalness(doc.settings.naturalness);
        presetSelect.value = presetId;
        versionLabel.textContent = es.sheet.version(seed);
        lastText = doc.text;
        charIds = doc.charIds.length === doc.text.length ? doc.charIds : defaultCharIds(doc.text);
        marks = doc.marks.length === doc.text.length ? doc.marks : new Array<number>(doc.text.length).fill(0);
        paragraphs = doc.paragraphs.length === paragraphCount(doc.text) ? doc.paragraphs : new Array<number>(paragraphCount(doc.text)).fill(0);
        runStyles = doc.runStyles.slice();
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
