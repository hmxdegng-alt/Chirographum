// "Hoja": the user writes directly on A4 pages in their own hand, picks the
// pen and the imperfections, and prints or exports a PDF at true size.

import { bridge, loadPreference, savePreference } from "../bridge";
import { charactersNeeded, type Hand } from "../engine/hand";
import { layoutText, type LayoutResult } from "../engine/layout";
import { DEFAULT_PEN_ID, INK_COLORS, PENCIL_COLOR, PENS, penById } from "../engine/pens";
import { freshSeed, hashString } from "../engine/random";
import { renderPage } from "../engine/render";
import { A4, DEFAULT_PRESET_ID, PRESETS, presetById, randomNaturalness, type Naturalness, type PageSettings } from "../engine/settings";
import { es } from "../i18n/es";
import type { Store } from "../store";
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

const decimal = (value: number, digits = 1) => value.toFixed(digits).replace(".", ",");
const mmFormat = (value: number) => `${decimal(value)} ${es.sheet.mm}`;
const slopeFormat = (value: number) =>
  Math.abs(value) < 0.05 ? es.sheet.slopeFlat : value > 0 ? es.sheet.slopeUp(decimal(value)) : es.sheet.slopeDown(decimal(-value));

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
  };

  const currentColor = () => (penById(penId).kind === "pencil" ? PENCIL_COLOR : inkColor);

  // ----- Pages -----
  let textSaveTimer: number | undefined;
  const editor = createPageEditor({
    initialText: loadPreference("sheet.text", store.get().phrase),
    onInput: (text) => {
      window.clearTimeout(textSaveTimer);
      textSaveTimer = window.setTimeout(() => savePreference("sheet.text", text), 300);
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
  const previewArea = h(
    "section",
    { class: "sheet-preview" },
    h("div", { class: "preview-bar" }, zoom.bar, h("span", { class: "muted preview-hint" }, es.sheet.editorHint)),
    previewScroll,
  );

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

  const pageSlider = (label: string, key: keyof PageSettings, min: number, max: number, step: number) =>
    slider({
      label,
      min,
      max,
      step,
      value: page[key],
      format: mmFormat,
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
        ? { min: -15, max: 25, step: 1, format: (v: number) => `${Math.round(v)}${es.sheet.degrees}` }
        : key === "lineSlope"
          ? { min: -3, max: 3, step: 0.1, format: slopeFormat }
          : { min: 0, max: 1, step: 0.01, format: percent };
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
    h("hr"),
    pageSlider(es.sheet.size, "xHeightMm", 1.8, 5, 0.1),
    pageSlider(es.sheet.lineSpacing, "lineSpacingMm", 5, 14, 0.5),
    h("p", { class: "field-label" }, es.sheet.margins),
    pageSlider(es.sheet.marginLeft, "marginLeftMm", 5, 50, 1),
    pageSlider(es.sheet.marginRight, "marginRightMm", 5, 50, 1),
    pageSlider(es.sheet.marginTop, "marginTopMm", 5, 50, 1),
    pageSlider(es.sheet.marginBottom, "marginBottomMm", 5, 50, 1),
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
        store.update({ extraChars: extra, tab: "draw" });
      }, "ghost");
      items.push(h("div", { class: "warning" }, h("span", {}, es.sheet.missing(result.missing.join(" "))), add));
    }
    if (result.overflow) items.push(h("p", { class: "warning" }, es.sheet.overflow));
    warnings.replaceChildren(...items);
  }

  /** Recomputes where everything goes (fast); the drawing follows later. */
  function relayout(): void {
    const hand = store.get().hand;
    layout = layoutText(editor.text(), hand, page, naturalness, seed);
    renderWarnings(layout);
    editor.setLayout(layout, page);
    editor.setEmptyMessage(Object.keys(hand.glyphs).length > 0 ? null : es.sheet.emptyHand);
  }

  function pageSignature(result: LayoutResult, pageIndex: number, pxPerMm: number, hand: Hand): string {
    const parts: (string | number)[] = [pxPerMm, penId, currentColor(), JSON.stringify(naturalness), seed, JSON.stringify(page), hand.updatedAt];
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
    canvases.forEach((canvas, pageIndex) => {
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
      const result = layoutText(editor.text(), hand, page, naturalness, seed);
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
