// "Hoja": the text written on an A4 page with the user's hand, the pen and
// the imperfections; printing and PDF export at true size.

import { bridge, loadPreference, savePreference } from "../bridge";
import { charactersNeeded } from "../engine/hand";
import { layoutText, type LayoutResult } from "../engine/layout";
import { DEFAULT_PEN_ID, INK_COLORS, PENCIL_COLOR, PENS, penById } from "../engine/pens";
import { freshSeed } from "../engine/random";
import { renderPage } from "../engine/render";
import {
  A4,
  DEFAULT_PRESET_ID,
  PRESETS,
  presetById,
  RANDOM_PRESET_ID,
  randomNaturalness,
  type Naturalness,
  type PageSettings,
} from "../engine/settings";
import { es } from "../i18n/es";
import type { Store } from "../store";
import { createColorPopover } from "./color-picker";
import { button, h, percent, slider, toast } from "./dom";
import { createZoomControl } from "./zoom";

const PRINT_DPI = 600;
const MM_PER_INCH = 25.4;
const CSS_PX_PER_MM = 96 / MM_PER_INCH;
const MAX_RECENT_COLORS = 6;
/** Zoom range, relative to true size (1 = 100 %). */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
/** Preview backing store limit, in pixels. */
const MAX_PREVIEW_PIXELS = 30_000_000;
/** Wait after the last zoom step before redrawing sharp at the new size. */
const ZOOM_RENDER_DELAY = 140;

const decimal = (value: number, digits = 1) => value.toFixed(digits).replace(".", ",");
const mmFormat = (value: number) => `${decimal(value)} ${es.sheet.mm}`;

const NATURAL_KEYS: (keyof Naturalness)[] = [
  "sizeVariation",
  "rotation",
  "slantDegrees",
  "slantVariation",
  "baselineWobble",
  "lineDrift",
  "spacingVariation",
  "edgeShrink",
  "marginDrift",
  "inkTexture",
];

export function createSheetView(store: Store): { root: HTMLElement; onShow: () => void } {
  let text = loadPreference("sheet.text", store.get().phrase);
  let penId = loadPreference("sheet.pen", DEFAULT_PEN_ID);
  let inkColor = loadPreference("sheet.color", INK_COLORS[0].value);
  let recentColors = loadPreference<string[]>("sheet.recentColors", []);
  let page: PageSettings = { ...A4, ...loadPreference<Partial<PageSettings>>("sheet.page", {}) };
  let presetId = loadPreference("sheet.preset", DEFAULT_PRESET_ID);
  let naturalness: Naturalness = { ...presetById(DEFAULT_PRESET_ID).values, ...loadPreference<Partial<Naturalness>>("sheet.naturalness", {}) };
  let seed = loadPreference("sheet.seed", freshSeed());
  let renderTimer: number | undefined;
  let lastLayout: LayoutResult | null = null;

  const persist = () => {
    savePreference("sheet.text", text);
    savePreference("sheet.pen", penId);
    savePreference("sheet.color", inkColor);
    savePreference("sheet.recentColors", recentColors);
    savePreference("sheet.page", page);
    savePreference("sheet.preset", presetId);
    savePreference("sheet.naturalness", naturalness);
    savePreference("sheet.seed", seed);
  };

  const currentColor = () => (penById(penId).kind === "pencil" ? PENCIL_COLOR : inkColor);

  // ----- Preview -----
  const previewCanvas = h("canvas", { class: "sheet-canvas" });
  const emptyMessage = h("div", { class: "sheet-empty" }, es.sheet.emptyHand);
  const previewScroll = h("div", { class: "sheet-scroll" }, h("div", { class: "sheet-paper" }, previewCanvas, emptyMessage));
  const zoom = createZoomControl({
    scroller: previewScroll,
    content: () => previewCanvas,
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
      previewCanvas.style.width = `${page.widthMm * CSS_PX_PER_MM * scale}px`;
      previewCanvas.style.height = `${page.heightMm * CSS_PX_PER_MM * scale}px`;
      scheduleRender(ZOOM_RENDER_DELAY);
    },
  });
  const previewArea = h("section", { class: "sheet-preview" }, zoom.bar, previewScroll);

  // ----- Controls -----
  const textInput = h("textarea", { class: "text-input", rows: 7, "aria-label": es.sheet.textLabel });
  textInput.value = text;
  textInput.addEventListener("input", () => {
    text = textInput.value;
    persist();
    scheduleRender();
  });

  const warnings = h("div", { class: "warnings" });

  const penSelect = h("select", { class: "select", "aria-label": es.sheet.pen });
  for (const pen of PENS) penSelect.append(h("option", { value: pen.id }, pen.label));
  penSelect.value = penId;
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
        scheduleRender();
      },
    }).root;

  const presetSelect = h("select", { class: "select", "aria-label": es.sheet.preset });
  for (const preset of PRESETS) presetSelect.append(h("option", { value: preset.id }, preset.label));
  presetSelect.append(h("option", { value: RANDOM_PRESET_ID }, es.sheet.random));
  presetSelect.append(h("option", { value: "custom" }, es.sheet.custom));
  presetSelect.value = presetId;
  const randomHelp = h("p", { class: "muted", hidden: presetId !== RANDOM_PRESET_ID }, es.sheet.randomHelp);

  const naturalSliders = new Map<keyof Naturalness, (value: number) => void>();
  const naturalControls = NATURAL_KEYS.map((key) => {
    const isSlant = key === "slantDegrees";
    const control = slider({
      label: es.sheet.sliders[key],
      min: isSlant ? -15 : 0,
      max: isSlant ? 25 : 1,
      step: isSlant ? 1 : 0.01,
      value: naturalness[key],
      format: isSlant ? (v) => `${Math.round(v)}${es.sheet.degrees}` : percent,
      onInput: (value) => {
        naturalness = { ...naturalness, [key]: value };
        presetId = "custom";
        presetSelect.value = presetId;
        randomHelp.hidden = true;
        persist();
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
    if (presetId === RANDOM_PRESET_ID) setNaturalness(randomNaturalness(seed));
    else if (presetId !== "custom") setNaturalness(presetById(presetId).values);
    randomHelp.hidden = presetId !== RANDOM_PRESET_ID;
    persist();
    scheduleRender();
  });

  const versionLabel = h("span", { class: "muted" }, es.sheet.version(seed));
  const busy = h("p", { class: "busy", hidden: true }, es.sheet.preparing);

  const controls = h(
    "aside",
    { class: "panel sheet-controls" },
    h("label", { class: "field-label" }, es.sheet.textLabel),
    textInput,
    warnings,
    h("hr"),
    h("label", { class: "field-label" }, es.sheet.pen),
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
    h("hr"),
    h("h3", { class: "panel-subtitle" }, es.sheet.naturalness),
    h("label", { class: "field-label" }, es.sheet.preset),
    presetSelect,
    randomHelp,
    ...naturalControls,
    h(
      "div",
      { class: "inline spaced" },
      button(es.sheet.anotherVersion, () => {
        seed = freshSeed();
        versionLabel.textContent = es.sheet.version(seed);
        if (presetId === RANDOM_PRESET_ID) setNaturalness(randomNaturalness(seed));
        persist();
        scheduleRender(0);
      }),
      versionLabel,
    ),
    h("hr"),
    h("div", { class: "button-row" }, button(es.sheet.print, () => void output("print"), "primary"), button(es.sheet.exportPdf, () => void output("pdf"))),
    busy,
    h("p", { class: "muted" }, es.sheet.printTip),
  );

  const root = h("div", { class: "sheet-view" }, previewArea, controls);

  // ----- Rendering -----
  function cssPxPerMm(): number {
    return CSS_PX_PER_MM * zoom.scale();
  }

  function renderWarnings(layout: LayoutResult): void {
    const items: HTMLElement[] = [];
    if (layout.missing.length > 0) {
      const add = button(es.sheet.addMissing, () => {
        const state = store.get();
        const known = new Set([...charactersNeeded(state.phrase), ...state.extraChars]);
        const extra = [...state.extraChars, ...layout.missing.filter((c) => !known.has(c))];
        store.update({ extraChars: extra, tab: "draw" });
      }, "ghost");
      items.push(h("div", { class: "warning" }, h("span", {}, es.sheet.missing(layout.missing.join(" "))), add));
    }
    if (layout.overflow) items.push(h("p", { class: "warning" }, es.sheet.overflow));
    warnings.replaceChildren(...items);
  }

  function render(): void {
    const hand = store.get().hand;
    const scale = cssPxPerMm();
    let backing = scale * (window.devicePixelRatio || 1);
    const pixels = page.widthMm * page.heightMm * backing * backing;
    if (pixels > MAX_PREVIEW_PIXELS) backing *= Math.sqrt(MAX_PREVIEW_PIXELS / pixels);
    lastLayout = layoutText(text, hand, page, naturalness, seed);
    renderWarnings(lastLayout);
    renderPage(previewCanvas, lastLayout, hand, page, {
      pxPerMm: backing,
      pen: penById(penId),
      color: currentColor(),
      naturalness,
      seed,
      background: "white",
    });
    previewCanvas.style.width = `${page.widthMm * scale}px`;
    previewCanvas.style.height = `${page.heightMm * scale}px`;
    emptyMessage.hidden = Object.keys(hand.glyphs).length > 0;
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
    const canvas = document.createElement("canvas");
    let url = "";
    const image = document.getElementById("print-sheet") as HTMLImageElement;
    try {
      const layout = layoutText(text, hand, page, naturalness, seed);
      renderPage(canvas, layout, hand, page, {
        pxPerMm: PRINT_DPI / MM_PER_INCH,
        pen: penById(penId),
        color: currentColor(),
        naturalness,
        seed,
        background: "transparent",
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("png");
      url = URL.createObjectURL(blob);
      image.src = url;
      await image.decode();
      busy.hidden = true;
      if (kind === "print") {
        const result = await bridge.printPage();
        if (!result.ok && result.reason && result.reason !== "cancelled") toast(`${es.sheet.printFailed} (${result.reason})`);
      } else {
        const file = await bridge.exportPdf();
        if (file) toast(es.sheet.pdfSaved(file));
      }
    } catch {
      toast(es.sheet.printFailed);
    } finally {
      busy.hidden = true;
      image.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  store.subscribe((state, previous) => {
    if (state.hand !== previous.hand && state.tab === "sheet") scheduleRender();
  });
  window.addEventListener("resize", () => {
    if (store.get().tab === "sheet") zoom.refit();
  });

  renderSwatches();

  return {
    root,
    onShow() {
      // The preview only has a size once the view is visible.
      requestAnimationFrame(() => {
        zoom.refit();
        scheduleRender(0);
      });
    },
  };
}
