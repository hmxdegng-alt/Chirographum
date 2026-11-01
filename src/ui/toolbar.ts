// The bar above the pages, as in any word processor: undo, paragraph style,
// instrument, ink colour and size, bold/italic/underline/strikethrough,
// scribble, highlighter and alignment. Everything applies to the selection
// (or to what is typed next). It only shows state and sends commands; the
// sheet does the work.

import { loadPreference, savePreference } from "../bridge";
import { INK_COLORS, PENS } from "../engine/pens";
import {
  CORRECTIONS,
  HIGHLIGHT_COLORS,
  PARAGRAPH_STYLES,
  SCRIBBLE_KINDS,
  type Alignment,
  type Correction,
  type ParagraphStyle,
  type ScribbleKind,
  type ScribbleStyle,
} from "../engine/rich-text";
import { scribbleStrokes } from "../engine/scribble";
import { es } from "../i18n/es";
import { createColorPopover } from "./color-picker";
import { h, percent, slider } from "./dom";

export interface ToolbarState {
  canUndo: boolean;
  canRedo: boolean;
  style: ParagraphStyle;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  scribble: boolean;
  align: Alignment;
  highlightColor: number;
  /** Instrument of the selection. */
  penId: string;
  /** Ink colour of the selection. */
  inkColor: string;
  /** Pencils have no ink colour. */
  inkDisabled: boolean;
  /** Letter size of the selection (1 = normal). */
  size: number;
  /** How the selection is (or will be) scribbled out. */
  scribbleStyle: ScribbleStyle;
  /** The selection is (or will be) highlighted word by word. */
  highlightWords: boolean;
  /** …with round ends instead of square ones. */
  highlightRound: boolean;
  /** How the selection is corrected by hand, if it is. */
  correction: Correction | null;
}

/** Sizes offered for a selection, relative to the paragraph. */
const SIZES = [0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const MAX_RECENT_INKS = 6;

const SVG_NS = "http://www.w3.org/2000/svg";

/** A small drawing of a kind of scribble over a word, made by the same code that draws the page. */
function scribblePreview(kind: ScribbleKind, rage: number, withWord = true): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 18 11");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("scribble-preview");
  if (withWord) {
    const word = document.createElementNS(SVG_NS, "path");
    // A pretend word underneath, so the kinds can be told apart.
    word.setAttribute("d", `M2.5 7.6 ${"q1 -2.6 2 0 ".repeat(6)}M5.6 6.4 v-3.4 M12.6 6.4 v-3.4`);
    word.setAttribute("class", "scribble-preview-word");
    svg.append(word);
  }
  for (const stroke of scribbleStrokes({ x0: 2.4, x1: 15.6, y0: 7.6, y1: 7.6, xhMm: 2.6, seed: 11 }, { kind, rage, width: 1, perWord: false })) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", stroke.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" "));
    svg.append(path);
  }
  return svg;
}

/** A dab of correction fluid with a letter written on it. */
function correctIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 16");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const dab = document.createElementNS(SVG_NS, "path");
  dab.setAttribute("d", "M3.5 4.5c3-1.2 9.5-1.6 13-0.4c1.5 0.6 1.6 6.4 0.2 7.2c-3.2 1.4-10 1.2-13.1 0.2c-1.6-0.6-1.6-6.4-0.1-7z");
  dab.setAttribute("fill", "#ffffff");
  dab.setAttribute("stroke", "currentColor");
  dab.setAttribute("stroke-width", "1.1");
  const letter = document.createElementNS(SVG_NS, "path");
  letter.setAttribute("d", "M8.2 10.2c-1.4-0.2-1.4-2.8 0.2-3c1.2-0.1 1.6 1.4 1.4 3M9.8 7.4v2.9M11.6 10.4l1.4-3.4l1.4 3.4");
  letter.setAttribute("fill", "none");
  letter.setAttribute("stroke", "currentColor");
  letter.setAttribute("stroke-width", "1.1");
  letter.setAttribute("stroke-linecap", "round");
  svg.append(dab, letter);
  return svg;
}

/** A short highlighter band with square or round ends. */
function endIcon(round: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 28 12");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  const band = document.createElementNS(SVG_NS, "path");
  band.setAttribute("d", round ? "M7 2h14a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8z" : "M4.5 2h21l-2 8h-21z");
  band.setAttribute("fill", "#f5e03a");
  band.setAttribute("stroke", "#c9b220");
  band.setAttribute("stroke-width", "0.8");
  svg.append(band);
  return svg;
}

/** "Borrar formato": a T with a small cross, like the usual icon. */
function clearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2.5 3h9M7 3v10");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  const slash = document.createElementNS(SVG_NS, "path");
  slash.setAttribute("d", "M10.5 10.5l3 3M13.5 10.5l-3 3");
  slash.setAttribute("fill", "none");
  slash.setAttribute("stroke", "currentColor");
  slash.setAttribute("stroke-width", "1.4");
  slash.setAttribute("stroke-linecap", "round");
  svg.append(path, slash);
  return svg;
}

/** Icon for the button that shows or hides the settings panel. */
function panelIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 18 16");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const frame = document.createElementNS(SVG_NS, "rect");
  frame.setAttribute("x", "1.5");
  frame.setAttribute("y", "2");
  frame.setAttribute("width", "15");
  frame.setAttribute("height", "12");
  frame.setAttribute("rx", "2");
  const side = document.createElementNS(SVG_NS, "path");
  side.setAttribute("d", "M11 2v12M12.8 5.2h2M12.8 7.6h2M12.8 10h2");
  for (const element of [frame, side]) {
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", "currentColor");
    element.setAttribute("stroke-width", "1.4");
    element.setAttribute("stroke-linecap", "round");
    svg.append(element);
  }
  return svg;
}

/** Small line icon for the alignment buttons. */
function alignIcon(align: Alignment): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const lines = [14, 9, 14, 9];
  lines.forEach((length, i) => {
    const x = align === "left" ? 1 : align === "right" ? 15 - length : (16 - length) / 2;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x + length));
    line.setAttribute("y1", String(3 + i * 3.4));
    line.setAttribute("y2", String(3 + i * 3.4));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.6");
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
  });
  return svg;
}

export function createToolbar(
  onCommand: (command: string) => void,
  extras: HTMLElement[],
): { root: HTMLElement; update(state: ToolbarState): void; setPanelShown(shown: boolean): void } {
  const tool = (label: string | Node, title: string, command: string, extraClass = "") => {
    const element = h("button", { type: "button", class: `tool ${extraClass}`.trim(), title, "aria-label": title });
    element.append(label);
    // Keep the cursor in the page: the button must not take the focus.
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", () => onCommand(command));
    return element;
  };

  const undo = tool("↶", es.toolbar.undo, "undo", "icon");
  const redo = tool("↷", es.toolbar.redo, "redo", "icon");

  const styleSelect = h("select", { class: "select tool-select", title: es.toolbar.style, "aria-label": es.toolbar.style });
  for (const style of PARAGRAPH_STYLES) styleSelect.append(h("option", { value: style }, es.toolbar.styles[style]));
  styleSelect.addEventListener("change", () => onCommand(`style:${styleSelect.value}`));

  const bold = tool(h("b", {}, "N"), es.toolbar.bold, "format:bold");
  const italic = tool(h("i", {}, "K"), es.toolbar.italic, "format:italic");
  const underline = tool(h("u", {}, "S"), es.toolbar.underline, "format:underline");
  const strike = tool(h("s", {}, "abc"), es.toolbar.strike, "format:strike");
  // The button shows a real scribble: "Rayajos" with all the rage.
  const scribbleIcon = scribblePreview("zigzag", 1, false);
  scribbleIcon.classList.add("scribble-icon");
  const scribble = tool(scribbleIcon, es.toolbar.scribble, "format:scribble");

  // Kind, thickness and rage of the scribble, like the highlighter's colours.
  const scribbleMenu = h("div", { class: "tool-menu scribble-menu", hidden: true, role: "menu" });
  const scribbleToggle = h("button", { type: "button", class: "tool caret", title: es.toolbar.scribbleOptions, "aria-label": es.toolbar.scribbleOptions }, "▾");
  scribbleToggle.addEventListener("mousedown", (event) => event.preventDefault());
  const kindGrid = h("div", { class: "scribble-kinds" });
  const kindButtons = new Map<ScribbleKind, HTMLButtonElement>();
  const drawKinds = (rage: number) => {
    for (const [kind, button] of kindButtons) button.firstElementChild?.replaceWith(scribblePreview(kind, rage));
  };
  for (const kind of SCRIBBLE_KINDS) {
    const button = h("button", { type: "button", class: "scribble-kind", role: "menuitemradio", title: es.toolbar.scribbleKinds[kind] }, scribblePreview(kind, 0.5), h("span", {}, es.toolbar.scribbleKinds[kind]));
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => onCommand(`scribble-kind:${kind}`));
    kindButtons.set(kind, button);
    kindGrid.append(button);
  }
  const perWord = h("input", { type: "checkbox" });
  perWord.addEventListener("change", () => onCommand(`scribble-words:${perWord.checked ? 1 : 0}`));
  const widthSlider = slider({
    label: es.toolbar.scribbleWidth,
    min: 0.4,
    max: 3,
    step: 0.05,
    value: 1,
    defaultValue: 1,
    usual: [0.6, 2],
    caution: 0.4,
    format: percent,
    onInput: (value) => onCommand(`scribble-width:${value}`),
  });
  const rageSlider = slider({
    label: es.toolbar.scribbleRage,
    min: 0,
    max: 1,
    step: 0.05,
    value: 0.5,
    defaultValue: 0.5,
    format: percent,
    live: drawKinds,
    onInput: (value) => onCommand(`scribble-rage:${value}`),
  });
  const removeScribble = h("button", { type: "button", class: "menu-text", role: "menuitem" }, es.toolbar.removeScribble);
  removeScribble.addEventListener("mousedown", (event) => event.preventDefault());
  removeScribble.addEventListener("click", () => {
    scribbleMenu.hidden = true;
    onCommand("scribble:none");
  });
  scribbleMenu.append(
    kindGrid,
    h("label", { class: "check" }, perWord, es.toolbar.scribblePerWord),
    widthSlider.root,
    rageSlider.root,
    removeScribble,
  );
  scribbleToggle.addEventListener("click", () => (scribbleMenu.hidden = !scribbleMenu.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!scribbleMenu.hidden && !scribbleMenu.contains(event.target as Node) && event.target !== scribbleToggle) scribbleMenu.hidden = true;
  });
  const scribbleGroup = h("div", { class: "tool-group" }, scribble, scribbleToggle, scribbleMenu);
  let shownRage = 0.5;

  // Instrument, colour and size for the selection, or for what is typed next.
  const penSelect = h("select", { class: "select tool-select narrow-select", title: es.toolbar.pen, "aria-label": es.toolbar.pen });
  for (const pen of PENS) penSelect.append(h("option", { value: pen.id }, pen.label));
  penSelect.addEventListener("change", () => onCommand(`pen:${penSelect.value}`));

  const sizeSelect = h("select", { class: "select tool-select size-select", title: es.toolbar.size, "aria-label": es.toolbar.size });
  for (const size of SIZES) sizeSelect.append(h("option", { value: String(size) }, `${Math.round(size * 100)} %`));
  sizeSelect.addEventListener("change", () => onCommand(`size:${sizeSelect.value}`));

  const inkChip = h("span", { class: "ink-chip" });
  const inkButton = h("button", { type: "button", class: "tool", title: es.toolbar.inkColor, "aria-label": es.toolbar.inkColor }, h("span", { class: "highlight-label" }, "A", inkChip));
  inkButton.addEventListener("mousedown", (event) => event.preventDefault());
  const inkMenu = h("div", { class: "tool-menu", hidden: true, role: "menu" });
  const inkSwatches = h("div", { class: "menu-swatches" });
  let recentInks = loadPreference<string[]>("sheet.recentColors", []);
  const renderInkSwatches = () => {
    const swatch = (value: string, label: string) => {
      const item = h("button", { type: "button", class: "menu-swatch", title: label, "aria-label": label, role: "menuitem" });
      item.style.background = value;
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        inkMenu.hidden = true;
        onCommand(`ink:${value}`);
      });
      return item;
    };
    inkSwatches.replaceChildren(...INK_COLORS.map((color) => swatch(color.value, color.label)));
    if (recentInks.length > 0) inkSwatches.append(h("span", { class: "menu-break" }), ...recentInks.map((value) => swatch(value, value)));
  };
  renderInkSwatches();
  inkMenu.append(inkSwatches);
  // The app's own picker: Chromium's cannot be closed from the page.
  const customInk = createColorPopover(INK_COLORS[0].value, () => {}, (hex) => {
    inkMenu.hidden = true;
    if (!INK_COLORS.some((color) => color.value.toLowerCase() === hex.toLowerCase())) {
      recentInks = [hex, ...recentInks.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_RECENT_INKS);
      savePreference("sheet.recentColors", recentInks);
      renderInkSwatches();
    }
    onCommand(`ink:${hex}`);
  });
  customInk.root.classList.add("menu-popover");
  // Keep the cursor in the page, except in the boxes that need typing or dragging.
  customInk.root.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  });
  inkMenu.append(customInk.root);
  inkButton.addEventListener("click", () => {
    if (inkMenu.hidden) customInk.setColor(currentInk);
    else customInk.close();
    inkMenu.hidden = !inkMenu.hidden;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!inkMenu.hidden && !inkMenu.contains(event.target as Node) && !inkButton.contains(event.target as Node)) inkMenu.hidden = true;
  });
  let currentInk = INK_COLORS[0].value;
  const inkGroup = h("div", { class: "tool-group" }, inkButton, inkMenu);

  const highlightChip = h("span", { class: "highlight-chip" });
  const highlight = tool(h("span", { class: "highlight-label" }, "ab", highlightChip), es.toolbar.highlight, "format:highlight");
  const colorMenu = h("div", { class: "tool-menu", hidden: true, role: "menu" });
  const colorToggle = h("button", { type: "button", class: "tool caret", title: es.toolbar.highlightColor, "aria-label": es.toolbar.highlightColor }, "▾");
  colorToggle.addEventListener("mousedown", (event) => event.preventDefault());
  HIGHLIGHT_COLORS.forEach((color, index) => {
    const item = h("button", { type: "button", class: "menu-swatch", title: color.label, "aria-label": color.label, role: "menuitem" });
    item.style.background = color.value;
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      colorMenu.hidden = true;
      onCommand(`highlight:${index}`);
    });
    colorMenu.append(item);
  });
  const removeHighlight = h("button", { type: "button", class: "menu-text", role: "menuitem" }, es.toolbar.removeHighlight);
  removeHighlight.addEventListener("mousedown", (event) => event.preventDefault());
  removeHighlight.addEventListener("click", () => {
    colorMenu.hidden = true;
    onCommand("highlight:none");
  });
  const highlightPerWord = h("input", { type: "checkbox" });
  highlightPerWord.addEventListener("change", () => onCommand(`highlight-words:${highlightPerWord.checked ? 1 : 0}`));
  // Square ends (a chisel tip, as most highlighters) or round ones.
  const endButton = (round: boolean) => {
    const label = round ? es.toolbar.highlightRound : es.toolbar.highlightSquare;
    const button = h("button", { type: "button", class: "menu-option", role: "menuitemradio", title: label }, endIcon(round), h("span", {}, label));
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => onCommand(`highlight-ends:${round ? "round" : "square"}`));
    return button;
  };
  const squareEnds = endButton(false);
  const roundEnds = endButton(true);
  colorMenu.append(
    h("div", { class: "menu-options" }, squareEnds, roundEnds),
    h("label", { class: "check menu-check" }, highlightPerWord, es.toolbar.highlightPerWord),
    removeHighlight,
  );
  colorToggle.addEventListener("click", () => (colorMenu.hidden = !colorMenu.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!colorMenu.hidden && !colorMenu.contains(event.target as Node) && event.target !== colorToggle) colorMenu.hidden = true;
  });
  const highlightGroup = h("div", { class: "tool-group" }, highlight, colorToggle, colorMenu);

  // Corrections made by hand: correction fluid, written over, rubbed out, added above.
  const correctButton = tool(correctIcon(), es.toolbar.correct, "format:correct", "icon");
  const correctToggle = h("button", { type: "button", class: "tool caret", title: es.toolbar.correctOptions, "aria-label": es.toolbar.correctOptions }, "▾");
  correctToggle.addEventListener("mousedown", (event) => event.preventDefault());
  const correctMenu = h("div", { class: "tool-menu correct-menu", hidden: true, role: "menu" });
  const correctItems = new Map<Correction, HTMLButtonElement>();
  for (const kind of CORRECTIONS) {
    const item = h(
      "button",
      { type: "button", class: "menu-item", role: "menuitemradio" },
      h("span", { class: "menu-item-title" }, es.toolbar.corrections[kind].label),
      h("span", { class: "menu-item-help" }, es.toolbar.corrections[kind].help),
    );
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      correctMenu.hidden = true;
      onCommand(`correct:${kind}`);
    });
    correctItems.set(kind, item);
    correctMenu.append(item);
  }
  const removeCorrection = h("button", { type: "button", class: "menu-text", role: "menuitem" }, es.toolbar.removeCorrection);
  removeCorrection.addEventListener("mousedown", (event) => event.preventDefault());
  removeCorrection.addEventListener("click", () => {
    correctMenu.hidden = true;
    onCommand("correct:none");
  });
  correctMenu.append(removeCorrection);
  correctToggle.addEventListener("click", () => (correctMenu.hidden = !correctMenu.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!correctMenu.hidden && !correctMenu.contains(event.target as Node) && event.target !== correctToggle) correctMenu.hidden = true;
  });
  const correctGroup = h("div", { class: "tool-group" }, correctButton, correctToggle, correctMenu);

  // "Borrar formato", as in Docs: the selection back to plain text.
  const clearFormat = tool(clearIcon(), es.toolbar.clearFormat, "format:clear", "icon");

  const panelButton = h("button", { type: "button", class: "tool icon panel-toggle", title: es.toolbar.panel, "aria-label": es.toolbar.panel, "aria-pressed": "true" }, panelIcon());
  panelButton.addEventListener("mousedown", (event) => event.preventDefault());
  panelButton.addEventListener("click", () => onCommand("view:settingsPanel"));

  const aligns = (["left", "center", "right"] as Alignment[]).map((align) => ({
    align,
    element: tool(alignIcon(align), es.toolbar.align[align], `align:${align}`, "icon"),
  }));

  const separator = () => h("span", { class: "tool-separator", "aria-hidden": "true" });
  const root = h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": es.toolbar.label },
    undo,
    redo,
    separator(),
    styleSelect,
    separator(),
    penSelect,
    inkGroup,
    sizeSelect,
    separator(),
    bold,
    italic,
    underline,
    strike,
    scribbleGroup,
    correctGroup,
    highlightGroup,
    clearFormat,
    separator(),
    ...aligns.map((a) => a.element),
    h("span", { class: "tool-spacer" }),
    ...extras,
    panelButton,
  );

  return {
    root,
    update(state) {
      undo.disabled = !state.canUndo;
      redo.disabled = !state.canRedo;
      if (document.activeElement !== styleSelect) styleSelect.value = state.style;
      bold.classList.toggle("active", state.bold);
      italic.classList.toggle("active", state.italic);
      underline.classList.toggle("active", state.underline);
      strike.classList.toggle("active", state.strike);
      highlight.classList.toggle("active", state.highlight);
      scribble.classList.toggle("active", state.scribble);
      if (document.activeElement !== penSelect) penSelect.value = state.penId;
      if (document.activeElement !== sizeSelect) {
        const nearest = SIZES.reduce((a, b) => (Math.abs(b - state.size) < Math.abs(a - state.size) ? b : a));
        sizeSelect.value = String(nearest);
      }
      currentInk = state.inkColor;
      inkChip.style.background = state.inkDisabled ? "#8a8a8a" : currentInk;
      inkButton.disabled = state.inkDisabled;
      inkButton.title = state.inkDisabled ? es.toolbar.pencilInk : es.toolbar.inkColor;
      if (state.inkDisabled) inkMenu.hidden = true;
      const look = state.scribbleStyle;
      for (const [kind, button] of kindButtons) button.classList.toggle("active", kind === look.kind);
      perWord.checked = look.perWord;
      widthSlider.set(look.width);
      rageSlider.set(look.rage);
      if (look.rage !== shownRage) {
        shownRage = look.rage;
        drawKinds(look.rage);
      }
      highlightChip.style.background = HIGHLIGHT_COLORS[state.highlightColor]?.value ?? HIGHLIGHT_COLORS[0].value;
      for (const { align, element } of aligns) element.classList.toggle("active", align === state.align);
      highlightPerWord.checked = state.highlightWords;
      correctButton.classList.toggle("active", state.correction !== null);
      for (const [kind, item] of correctItems) item.classList.toggle("active", kind === state.correction);
      squareEnds.classList.toggle("active", !state.highlightRound);
      roundEnds.classList.toggle("active", state.highlightRound);
    },
    setPanelShown(shown) {
      panelButton.classList.toggle("active", shown);
      panelButton.setAttribute("aria-pressed", String(shown));
    },
  };
}
