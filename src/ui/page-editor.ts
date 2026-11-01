// Writing directly on the pages. A hidden text box holds the text and does
// the typing (accents, paste, undo, Ctrl+A…); this module draws the cursor
// and the selection on top of the handwriting, and turns clicks, drags and
// the up/down/Home/End keys into positions from the layout.

import type { CaretStop, LayoutResult } from "../engine/layout";
import { RICH_CLIP_TYPE } from "../engine/rich-text";
import type { PageSettings } from "../engine/settings";
import { es } from "../i18n/es";
import { h } from "./dom";

interface PageElements {
  paper: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
}

export interface PageEditor {
  /** Column of pages; goes inside the scrolling preview. */
  root: HTMLElement;
  pages(): HTMLCanvasElement[];
  text(): string;
  /** Replaces the whole text (opening a document, undo); the cursor goes to `start`–`end`. */
  setText(text: string, start?: number, end?: number): void;
  selection(): { start: number; end: number };
  setSelection(start: number, end: number): void;
  /** True while the cursor is in the page. */
  hasFocus(): boolean;
  /** New layout (after typing or a settings change). */
  setLayout(layout: LayoutResult, page: PageSettings): void;
  /** CSS pixels per millimetre on screen. */
  setScale(cssPxPerMm: number): void;
  setEmptyMessage(message: string | null): void;
  focus(): void;
  /** Puts text in place of the selection, as typing or pasting would (one change for undo). */
  replaceSelection(text: string): void;
  /** The next paste goes in without its formatting. */
  pastePlainNext(): void;
}

export interface PageEditorOptions {
  initialText: string;
  /** The text changed; `before` is the selection just before the change. */
  onInput: (text: string, before: { start: number; end: number }) => void;
  /** The cursor or the selection moved (not by typing). */
  onSelectionChange?: (start: number, end: number) => void;
  /** Keyboard commands: undo, redo and formatting shortcuts. */
  onCommand?: (command: string) => void;
  /** Formatting of a copied range, to go to the clipboard with its text (null = none). */
  richCopy?: (start: number, end: number) => string | null;
  /** Something is pasted: its text, the formatting copied with it (if any) and whether to drop it. */
  onPaste?: (text: string, rich: string | null, plain: boolean) => void;
  /** Right click on a page, at this point of the window. */
  onContextMenu?: (clientX: number, clientY: number) => void;
}

/** Formatting shortcuts, as in the most common word processors. */
function shortcutCommand(event: KeyboardEvent): string | null {
  const ctrl = event.ctrlKey || event.metaKey;
  if (!ctrl && !(event.altKey && event.shiftKey)) return null;
  const key = event.key.toLowerCase();
  const code = event.code;
  if (ctrl && !event.altKey) {
    if (key === "z" && !event.shiftKey) return "undo";
    if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) return "redo";
    if (!event.shiftKey) {
      if (key === "b") return "format:bold";
      if (key === "i") return "format:italic";
      if (key === "u") return "format:underline";
      if (key === "\\" || code === "Backslash") return "format:clear";
    } else {
      if (key === "v") return "paste-plain";
      if (key === "l") return "align:left";
      if (key === "e") return "align:center";
      if (key === "r") return "align:right";
      if (key === "j") return "align:justify";
      if (key === "h") return "format:highlight";
    }
  }
  if (ctrl && event.altKey && !event.shiftKey) {
    const digit = code.startsWith("Digit") ? code.slice(5) : code.startsWith("Numpad") ? code.slice(6) : "";
    if (digit === "0") return "style:normal";
    if (digit === "1") return "style:h1";
    if (digit === "2") return "style:h2";
    if (digit === "3") return "style:h3";
  }
  if (!ctrl && event.altKey && event.shiftKey && (code === "Digit5" || key === "5" || key === "%")) return "format:strike";
  return null;
}

const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;
/** Cursor and selection height around the baseline, in x-heights. */
const CARET_ABOVE = 1.75;
const CARET_BELOW = 0.6;

export function createPageEditor(options: PageEditorOptions): PageEditor {
  const input = h("textarea", {
    class: "editor-input",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": es.sheet.editorLabel,
  });
  input.value = options.initialText;
  const root = h("div", { class: "pages" }, input);
  const pageElements: PageElements[] = [];
  const emptyNote = h("div", { class: "sheet-empty", hidden: true });

  let layout: LayoutResult | null = null;
  let pageSettings: PageSettings | null = null;
  let scale = 1;
  let goalX: number | null = null;
  let revealCaret = false;
  let blinkTimer: number | undefined;

  // ----- Pages -----
  function ensurePages(count: number): void {
    while (pageElements.length < count) {
      const index = pageElements.length;
      const canvas = h("canvas", { class: "sheet-canvas" });
      const overlay = h("div", { class: "page-overlay" });
      const paper = h("div", { class: "sheet-paper", "data-page": index }, canvas, overlay);
      paper.addEventListener("pointerdown", (event) => onPointerDown(event, index));
      root.append(paper);
      pageElements.push({ paper, canvas, overlay });
    }
    while (pageElements.length > count) pageElements.pop()!.paper.remove();
    if (pageElements[0] && emptyNote.parentElement !== pageElements[0].paper) pageElements[0].paper.append(emptyNote);
  }

  function sizePages(): void {
    if (!pageSettings) return;
    for (const { canvas, overlay } of pageElements) {
      const width = `${pageSettings.widthMm * scale}px`;
      const height = `${pageSettings.heightMm * scale}px`;
      canvas.style.width = width;
      canvas.style.height = height;
      overlay.style.width = width;
      overlay.style.height = height;
    }
  }

  // ----- Positions -----
  const stops = (): CaretStop[] => layout?.carets ?? [];

  function lineIndices(line: number): number[] {
    const result: number[] = [];
    stops().forEach((stop, i) => {
      if (stop.line === line) result.push(i);
    });
    return result;
  }

  /** Text index nearest to a point of a page (in millimetres). */
  function hitTest(pageIndex: number, xMm: number, yMm: number): number {
    const all = stops();
    if (all.length === 0 || !pageSettings) return 0;
    const xh = pageSettings.xHeightMm;
    let bestLine = -1;
    let bestDistance = Infinity;
    for (const stop of all) {
      if (stop.page !== pageIndex) continue;
      // Distance to the middle of the line's letters, not to the baseline.
      const d = Math.abs(stop.yMm - xh * 0.6 - yMm);
      if (d < bestDistance) {
        bestDistance = d;
        bestLine = stop.line;
      }
    }
    if (bestLine < 0) {
      // A page without text: before its first line means the end of the previous one.
      const before = all.findIndex((stop) => stop.page > pageIndex);
      return before < 0 ? all.length - 1 : before;
    }
    let best = 0;
    let bestDx = Infinity;
    for (const i of lineIndices(bestLine)) {
      const dx = Math.abs(all[i].xMm - xMm);
      if (dx < bestDx) {
        bestDx = dx;
        best = i;
      }
    }
    return best;
  }

  function pointerToPage(event: PointerEvent | MouseEvent, pageIndex: number): { x: number; y: number } {
    const rect = pageElements[pageIndex].canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  }

  // ----- Selection -----
  function focusIndex(): number {
    return input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
  }

  function anchorIndex(): number {
    return input.selectionDirection === "backward" ? input.selectionEnd : input.selectionStart;
  }

  function select(anchor: number, focus: number): void {
    const length = input.value.length;
    anchor = Math.max(0, Math.min(length, anchor));
    focus = Math.max(0, Math.min(length, focus));
    if (focus < anchor) input.setSelectionRange(focus, anchor, "backward");
    else input.setSelectionRange(anchor, focus, "forward");
    revealCaret = true;
    drawOverlay();
  }

  // ----- Mouse -----
  let dragAnchor: number | null = null;
  let lastDown = { time: 0, x: 0, y: 0, count: 0 };

  /** Click count (pointer events do not carry one): 2 = word, 3 = paragraph. */
  function clickCount(event: PointerEvent): number {
    const near = Math.hypot(event.clientX - lastDown.x, event.clientY - lastDown.y) < 6;
    const count = near && event.timeStamp - lastDown.time < 450 ? lastDown.count + 1 : 1;
    lastDown = { time: event.timeStamp, x: event.clientX, y: event.clientY, count };
    return count;
  }

  function onPointerDown(event: PointerEvent, pageIndex: number): void {
    if (event.button === 2) {
      // Right click: a click outside the selection moves the cursor there first, as in any editor.
      event.preventDefault();
      input.focus({ preventScroll: true });
      const point = pointerToPage(event, pageIndex);
      const index = hitTest(pageIndex, point.x, point.y);
      if (index < input.selectionStart || index > input.selectionEnd || input.selectionStart === input.selectionEnd) select(index, index);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    const point = pointerToPage(event, pageIndex);
    const index = hitTest(pageIndex, point.x, point.y);
    goalX = null;
    const clicks = clickCount(event);
    if (clicks >= 3) {
      const text = input.value;
      const start = text.lastIndexOf("\n", index - 1) + 1;
      const end = text.indexOf("\n", index);
      select(start, end < 0 ? text.length : end);
      return;
    }
    if (clicks === 2) {
      selectWord(index);
      return;
    }
    dragAnchor = event.shiftKey ? anchorIndex() : index;
    select(dragAnchor, index);
    const paper = pageElements[pageIndex].paper;
    paper.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (dragAnchor === null) return;
      // The pointer may be over another page while dragging.
      const target = pageAt(moveEvent.clientY) ?? pageIndex;
      const p = pointerToPage(moveEvent, target);
      select(dragAnchor, hitTest(target, p.x, p.y));
    };
    const up = () => {
      dragAnchor = null;
      paper.removeEventListener("pointermove", move);
      paper.removeEventListener("pointerup", up);
      paper.removeEventListener("pointercancel", up);
    };
    paper.addEventListener("pointermove", move);
    paper.addEventListener("pointerup", up);
    paper.addEventListener("pointercancel", up);
  }

  function pageAt(clientY: number): number | null {
    for (let i = 0; i < pageElements.length; i++) {
      const rect = pageElements[i].paper.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return i;
    }
    return null;
  }

  function selectWord(index: number): void {
    const text = input.value;
    let start = index;
    let end = index;
    while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
    while (end < text.length && WORD_CHAR.test(text[end])) end++;
    if (start === end && end < text.length) end++;
    select(start, end);
  }

  // ----- Keyboard: what a plain text box cannot know (wrapped lines on the page) -----
  input.addEventListener("keydown", (event) => {
    const command = shortcutCommand(event);
    if (command) {
      // Undo is the document's own (text and formatting), never the text box's.
      event.preventDefault();
      options.onCommand?.(command);
      return;
    }
    const all = stops();
    if (all.length === 0) return;
    const focus = focusIndex();
    const current = all[Math.min(focus, all.length - 1)];
    const extend = event.shiftKey;
    const moveTo = (index: number) => select(extend ? anchorIndex() : index, index);

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!extend && input.selectionStart !== input.selectionEnd) {
        // Like every editor: up/down from a selection starts at its edge.
        const edge = event.key === "ArrowUp" ? input.selectionStart : input.selectionEnd;
        select(edge, edge);
      }
      const from = all[Math.min(focusIndex(), all.length - 1)];
      goalX ??= from.xMm;
      const targetLine = from.line + (event.key === "ArrowUp" ? -1 : 1);
      const candidates = lineIndices(targetLine);
      if (candidates.length === 0) {
        moveTo(event.key === "ArrowUp" ? 0 : input.value.length);
        return;
      }
      let best = candidates[0];
      for (const i of candidates) if (Math.abs(all[i].xMm - goalX) < Math.abs(all[best].xMm - goalX)) best = i;
      const keepGoal = goalX;
      moveTo(best);
      goalX = keepGoal;
      return;
    }
    if ((event.key === "Home" || event.key === "End") && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const indices = lineIndices(current.line);
      moveTo(event.key === "Home" ? indices[0] : indices[indices.length - 1]);
      goalX = null;
      return;
    }
    goalX = null;
    // Native keys (letters, arrows left/right, Ctrl+A…) move the selection after this event.
    revealCaret = true;
    requestAnimationFrame(drawOverlay);
  });
  // ----- Clipboard: the text, plus its formatting for pasting inside the program -----
  let plainNext = false;
  const copySelection = (event: ClipboardEvent): boolean => {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === end || !event.clipboardData) return false;
    event.preventDefault();
    event.clipboardData.setData("text/plain", input.value.slice(start, end));
    const rich = options.richCopy?.(start, end);
    if (rich) event.clipboardData.setData(RICH_CLIP_TYPE, rich);
    return true;
  };
  input.addEventListener("copy", (event) => void copySelection(event));
  input.addEventListener("cut", (event) => {
    if (copySelection(event)) replaceSelection("");
  });
  input.addEventListener("paste", (event) => {
    const plain = plainNext;
    plainNext = false;
    if (!event.clipboardData || !options.onPaste) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    options.onPaste(text, plain ? null : event.clipboardData.getData(RICH_CLIP_TYPE) || null, plain);
  });
  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!(event.target instanceof Node) || !pageElements.some(({ paper }) => paper.contains(event.target as Node))) return;
    options.onContextMenu?.(event.clientX, event.clientY);
  });

  function replaceSelection(text: string): void {
    beforeInput = { start: input.selectionStart, end: input.selectionEnd };
    input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    goalX = null;
    revealCaret = true;
    typing = true;
    options.onInput(input.value, beforeInput);
    queueMicrotask(() => (typing = false));
    drawOverlay();
  }

  // The selection just before a change, for undo.
  let beforeInput = { start: 0, end: 0 };
  let typing = false;
  input.addEventListener("beforeinput", (event) => {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      options.onCommand?.(event.inputType === "historyUndo" ? "undo" : "redo");
      return;
    }
    beforeInput = { start: input.selectionStart, end: input.selectionEnd };
  });
  input.addEventListener("input", () => {
    goalX = null;
    revealCaret = true;
    typing = true;
    options.onInput(input.value, beforeInput);
    queueMicrotask(() => (typing = false));
  });
  let lastSelection = "";
  const reportSelection = () => {
    const key = `${input.selectionStart}:${input.selectionEnd}`;
    if (key === lastSelection) return;
    lastSelection = key;
    if (!typing) options.onSelectionChange?.(input.selectionStart, input.selectionEnd);
  };
  input.addEventListener("select", () => drawOverlay());
  input.addEventListener("focus", () => drawOverlay());
  input.addEventListener("blur", () => drawOverlay());
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === input) drawOverlay();
  });

  // ----- Cursor, selection and missing letters on top of the pages -----
  function drawOverlay(): void {
    reportSelection();
    if (!layout || !pageSettings) return;
    const all = stops();
    const xh = pageSettings.xHeightMm;
    const px = (mm: number) => `${(mm * scale).toFixed(2)}px`;
    const perPage: Node[][] = pageElements.map(() => []);
    const start = Math.min(input.selectionStart, all.length - 1);
    const end = Math.min(input.selectionEnd, all.length - 1);
    const focused = document.activeElement === input;

    // Selection: one band per line segment.
    let segment = start;
    while (segment < end) {
      const line = all[segment].line;
      let next = segment;
      while (next < end && all[next].line === line) next++;
      const left = all[segment].xMm;
      const right = all[next] && all[next].line === line ? all[next].xMm : all[next - 1].xMm + xh * 0.7;
      const band = h("div", { class: `selection-band${focused ? "" : " inactive"}` });
      band.style.left = px(Math.min(left, right));
      band.style.top = px(all[segment].yMm - xh * CARET_ABOVE);
      band.style.width = px(Math.max(xh * 0.3, Math.abs(right - left)));
      band.style.height = px(xh * (CARET_ABOVE + CARET_BELOW));
      perPage[all[segment].page]?.push(band);
      segment = next;
    }

    // Letters the hand does not have yet: a dotted box with the letter, on screen only.
    for (const box of layout.missingBoxes) {
      const mark = h("div", { class: "missing-mark", title: es.sheet.missingMark(box.char) }, box.char);
      mark.style.left = px(box.xMm);
      mark.style.top = px(box.yMm - xh * 1.1);
      mark.style.width = px(box.widthMm);
      mark.style.height = px(xh * 1.2);
      mark.style.fontSize = px(xh * 0.9);
      perPage[box.page]?.push(mark);
    }

    // Placeholder on an empty document.
    if (input.value.length === 0 && all[0]) {
      const hint = h("div", { class: "editor-placeholder" }, es.sheet.placeholder);
      hint.style.left = px(all[0].xMm + xh * 0.4);
      hint.style.top = px(all[0].yMm - xh * 1.4);
      hint.style.fontSize = px(xh * 1.4);
      perPage[all[0].page]?.push(hint);
    }

    // The cursor.
    const focus = all[Math.min(focusIndex(), all.length - 1)];
    let caret: HTMLElement | null = null;
    if (focus && focused) {
      caret = h("div", { class: "editor-caret" });
      caret.style.left = px(focus.xMm);
      caret.style.top = px(focus.yMm - xh * CARET_ABOVE);
      caret.style.height = px(xh * (CARET_ABOVE + CARET_BELOW));
      perPage[focus.page]?.push(caret);
      // Keep the hidden box next to the cursor, so accent and emoji pickers open there.
      const paper = pageElements[focus.page]?.paper;
      if (paper) {
        input.style.left = `${paper.offsetLeft + focus.xMm * scale}px`;
        input.style.top = `${paper.offsetTop + (focus.yMm - xh * CARET_ABOVE) * scale}px`;
        input.style.height = px(xh * (CARET_ABOVE + CARET_BELOW));
      }
    }

    pageElements.forEach(({ overlay }, i) => overlay.replaceChildren(...perPage[i]));

    if (caret) {
      // Solid while moving, blinking when still.
      caret.classList.add("solid");
      window.clearTimeout(blinkTimer);
      const element = caret;
      blinkTimer = window.setTimeout(() => element.classList.remove("solid"), 500);
      if (revealCaret) scrollIntoView(caret);
    }
    revealCaret = false;
  }

  function scrollIntoView(element: HTMLElement): void {
    const scroller = root.parentElement;
    if (!scroller) return;
    const box = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const margin = 40;
    if (box.top < view.top + margin) scroller.scrollTop -= view.top + margin - box.top;
    else if (box.bottom > view.bottom - margin) scroller.scrollTop += box.bottom - (view.bottom - margin);
    if (box.left < view.left + margin) scroller.scrollLeft -= view.left + margin - box.left;
    else if (box.right > view.right - margin) scroller.scrollLeft += box.right - (view.right - margin);
  }

  return {
    root,
    pages: () => pageElements.map((p) => p.canvas),
    text: () => input.value,
    setText(text, start, end) {
      input.value = text;
      goalX = null;
      if (start === undefined) {
        input.setSelectionRange(0, 0);
        const scroller = root.parentElement;
        if (scroller) scroller.scrollTop = 0;
      } else {
        input.setSelectionRange(start, end ?? start);
        revealCaret = true;
      }
    },
    selection: () => ({ start: input.selectionStart, end: input.selectionEnd }),
    setSelection(start, end) {
      input.setSelectionRange(start, end);
      revealCaret = true;
      drawOverlay();
    },
    hasFocus: () => document.activeElement === input,
    setLayout(next, settings) {
      layout = next;
      pageSettings = settings;
      ensurePages(next.pageCount);
      sizePages();
      drawOverlay();
    },
    setScale(cssPxPerMm) {
      scale = cssPxPerMm;
      sizePages();
      drawOverlay();
    },
    setEmptyMessage(message) {
      emptyNote.hidden = message === null;
      emptyNote.textContent = message ?? "";
    },
    focus() {
      input.focus({ preventScroll: true });
      drawOverlay();
    },
    replaceSelection,
    pastePlainNext() {
      plainNext = true;
    },
  };
}
