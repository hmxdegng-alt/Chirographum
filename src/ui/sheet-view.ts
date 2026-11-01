// "Hoja": the user writes directly on A4 pages in their own hand, picks the
// pen and the imperfections, and prints or exports a PDF at true size.

import { bridge, loadPreference, savePreference } from "../bridge";
import { editedWordRange, randomCharId, updateCharIds } from "../engine/char-ids";
import { charactersNeeded, type Hand } from "../engine/hand";
import { defaultCharIds, layoutText, normaliseText, type LayoutResult } from "../engine/layout";
import { DEFAULT_PEN_ID, INK_COLORS, PENCIL_COLOR, PENS, penById } from "../engine/pens";
import { freshSeed, hashString } from "../engine/random";
import { renderPage } from "../engine/render";
import { A4, DEFAULT_PRESET_ID, PRESETS, presetById, randomNaturalness, type Naturalness, type PageSettings } from "../engine/settings";
import { es } from "../i18n/es";
import type { Store } from "../store";
import { onViewOptions, setViewOption, viewOptions } from "../view-options";
import { createColorPopover } from "./color-picker";
import { button, h, percent, slider, toast } from "./dom";
import { createPageEditor } from "./page-editor";
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
/** Earlier versions of the text and their letter identities, so undo brings back the same look. */
const HISTORY_SIZE = 200;
const HISTORY_MAX_LENGTH = 200_000;

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

export function createSheetView(store: Store): { root: HTMLElement; onShow: () => void } {
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

  const persist = () => {
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

  // ----- Text and the identity of every letter -----
  const initialText = normaliseText(loadPreference("sheet.text", store.get().phrase));
  let lastText = initialText;
  let charIds = loadPreference<number[]>("sheet.textIds", []);
  if (charIds.length !== initialText.length) charIds = defaultCharIds(initialText);
  const history = new Map<string, number[]>([[initialText, charIds]]);

  const remember = (text: string, ids: number[]) => {
    if (text.length > HISTORY_MAX_LENGTH) return;
    history.delete(text);
    history.set(text, ids);
    if (history.size > HISTORY_SIZE) history.delete(history.keys().next().value!);
  };

  /** New identities after an edit: unchanged letters keep theirs, so they keep their look. */
  function idsAfterEdit(text: string): number[] {
    if (viewOptions().typingAnimation) {
      // Optional cartoon effect: the edited word gets new drawings on every key.
      const ids = updateCharIds(lastText, charIds, text, randomCharId);
      const { start, end } = editedWordRange(lastText, text);
      for (let i = start; i < end; i++) ids[i] = randomCharId();
      return ids;
    }
    // Undo and redo bring back an earlier text: give it back its letters too.
    return history.get(text) ?? updateCharIds(lastText, charIds, text, randomCharId);
  }

  // ----- Pages -----
  let textSaveTimer: number | undefined;
  const editor = createPageEditor({
    initialText,
    onInput: (raw) => {
      const text = normaliseText(raw);
      charIds = idsAfterEdit(text);
      lastText = text;
      remember(text, charIds);
      window.clearTimeout(textSaveTimer);
      textSaveTimer = window.setTimeout(() => {
        savePreference("sheet.text", text);
        savePreference("sheet.textIds", charIds);
      }, 300);
      relayout();
      scheduleRender(TYPING_RENDER_DELAY);
    },
  });
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
  const previewArea = h(
    "section",
    { class: "sheet-preview" },
    h("div", { class: "preview-bar" }, zoom.bar, printedLabel, h("span", { class: "muted preview-hint" }, es.sheet.editorHint)),
    previewScroll,
  );
  previewScroll.addEventListener("scroll", () => scheduleRender(60), { passive: true });

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

  const tuningSlider = (label: string, key: keyof typeof penTuning, min: number, max: number) =>
    slider({
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
    }).root;

  /** Spacing is stored in x-heights; shown in millimetres at the current letter size. */
  const spacingFormat = (value: number) => mmFormat(value * page.xHeightMm);

  const pageSlider = (label: string, key: keyof PageSettings, min: number, max: number, step: number, format = mmFormat) =>
    slider({
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
    }).root;

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

  /** Recomputes where everything goes (fast); the drawing follows later. */
  function relayout(): void {
    const hand = store.get().hand;
    layout = layoutText(lastText, hand, page, naturalness, seed, charIds);
    renderWarnings(layout);
    editor.setLayout(layout, page);
    editor.setEmptyMessage(Object.keys(hand.glyphs).length > 0 ? null : es.sheet.emptyHand);
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
      hand.updatedAt,
    ];
    for (const g of result.glyphs) {
      if (g.page !== pageIndex) continue;
      parts.push(g.char, g.variantIndex, g.xMm.toFixed(3), g.yMm.toFixed(3), g.scale.toFixed(4), g.rotation.toFixed(4), g.shear.toFixed(4), g.seed);
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
      const result = layoutText(lastText, hand, page, naturalness, seed, charIds);
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

  return {
    root,
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
