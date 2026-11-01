// The bar above the pages, as in any word processor: undo, paragraph style,
// bold/italic/underline/strikethrough, highlighter and alignment. It only
// shows state and sends commands; the sheet does the work.

import { INK_COLORS, PENS } from "../engine/pens";
import { HIGHLIGHT_COLORS, PARAGRAPH_STYLES, type Alignment, type ParagraphStyle } from "../engine/rich-text";
import { es } from "../i18n/es";
import { createColorPopover } from "./color-picker";
import { h } from "./dom";

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
  /** Instrument of the selection, "default" = the document's. */
  penId: string;
  /** Ink colour of the selection, null = the document's. */
  inkColor: string | null;
  /** Letter size of the selection (1 = normal). */
  size: number;
}

/** Sizes offered for a selection, relative to the paragraph. */
const SIZES = [0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

const SVG_NS = "http://www.w3.org/2000/svg";

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
  documentColor: () => string,
): { root: HTMLElement; update(state: ToolbarState): void } {
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
  const scribble = tool(h("span", { class: "scribble-label" }, "abc"), es.toolbar.scribble, "format:scribble");

  // Instrument, colour and size for the selection (the panel sets the document's).
  const penSelect = h("select", { class: "select tool-select narrow-select", title: es.toolbar.pen, "aria-label": es.toolbar.pen });
  penSelect.append(h("option", { value: "default" }, es.toolbar.documentPen));
  for (const pen of PENS) penSelect.append(h("option", { value: pen.id }, pen.label));
  penSelect.addEventListener("change", () => onCommand(`pen:${penSelect.value}`));

  const sizeSelect = h("select", { class: "select tool-select size-select", title: es.toolbar.size, "aria-label": es.toolbar.size });
  for (const size of SIZES) sizeSelect.append(h("option", { value: String(size) }, `${Math.round(size * 100)} %`));
  sizeSelect.addEventListener("change", () => onCommand(`size:${sizeSelect.value}`));

  const inkChip = h("span", { class: "ink-chip" });
  const inkButton = h("button", { type: "button", class: "tool", title: es.toolbar.inkColor, "aria-label": es.toolbar.inkColor }, h("span", { class: "highlight-label" }, "A", inkChip));
  inkButton.addEventListener("mousedown", (event) => event.preventDefault());
  const inkMenu = h("div", { class: "tool-menu", hidden: true, role: "menu" });
  for (const color of INK_COLORS) {
    const item = h("button", { type: "button", class: "menu-swatch", title: color.label, "aria-label": color.label, role: "menuitem" });
    item.style.background = color.value;
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      inkMenu.hidden = true;
      onCommand(`ink:${color.value}`);
    });
    inkMenu.append(item);
  }
  // The app's own picker: Chromium's cannot be closed from the page.
  const customInk = createColorPopover(documentColor(), () => {}, (hex) => {
    inkMenu.hidden = true;
    onCommand(`ink:${hex}`);
  });
  customInk.root.classList.add("menu-popover");
  // Keep the cursor in the page, except in the boxes that need typing or dragging.
  customInk.root.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  });
  const documentInk = h("button", { type: "button", class: "menu-text", role: "menuitem" }, es.toolbar.documentInk);
  documentInk.addEventListener("mousedown", (event) => event.preventDefault());
  documentInk.addEventListener("click", () => {
    inkMenu.hidden = true;
    onCommand("ink:default");
  });
  inkMenu.append(customInk.root, documentInk);
  inkButton.addEventListener("click", () => {
    if (inkMenu.hidden) customInk.setColor(currentInk);
    else customInk.close();
    inkMenu.hidden = !inkMenu.hidden;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!inkMenu.hidden && !inkMenu.contains(event.target as Node) && !inkButton.contains(event.target as Node)) inkMenu.hidden = true;
  });
  let currentInk = documentColor();
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
  colorMenu.append(removeHighlight);
  colorToggle.addEventListener("click", () => (colorMenu.hidden = !colorMenu.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!colorMenu.hidden && !colorMenu.contains(event.target as Node) && event.target !== colorToggle) colorMenu.hidden = true;
  });
  const highlightGroup = h("div", { class: "tool-group" }, highlight, colorToggle, colorMenu);

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
    scribble,
    highlightGroup,
    separator(),
    ...aligns.map((a) => a.element),
    h("span", { class: "tool-spacer" }),
    ...extras,
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
      currentInk = state.inkColor ?? documentColor();
      inkChip.style.background = currentInk;
      highlightChip.style.background = HIGHLIGHT_COLORS[state.highlightColor]?.value ?? HIGHLIGHT_COLORS[0].value;
      for (const { align, element } of aligns) element.classList.toggle("active", align === state.align);
    },
  };
}
