// The bar above the pages, as in any word processor: undo, paragraph style,
// bold/italic/underline/strikethrough, highlighter and alignment. It only
// shows state and sends commands; the sheet does the work.

import { HIGHLIGHT_COLORS, PARAGRAPH_STYLES, type Alignment, type ParagraphStyle } from "../engine/rich-text";
import { es } from "../i18n/es";
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
  align: Alignment;
  highlightColor: number;
}

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

export function createToolbar(onCommand: (command: string) => void, extras: HTMLElement[]): { root: HTMLElement; update(state: ToolbarState): void } {
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
    bold,
    italic,
    underline,
    strike,
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
      highlightChip.style.background = HIGHLIGHT_COLORS[state.highlightColor]?.value ?? HIGHLIGHT_COLORS[0].value;
      for (const { align, element } of aligns) element.classList.toggle("active", align === state.align);
    },
  };
}
