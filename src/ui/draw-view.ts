// "Tu letra": the user draws every character of the test phrase with the
// mouse, a trackpad, a touch screen or a pen, several times each.

import { loadPreference, savePreference, bridge } from "../bridge";
import { pressureFromVelocity, simplify, smoothStroke, stabilise, type StrokePoint } from "../engine/geometry";
import {
  charactersNeeded,
  createHand,
  HandFormatError,
  parseHand,
  serializeHand,
  withVariantAdded,
  withVariantRemoved,
  type GlyphVariant,
  type Stroke,
} from "../engine/hand";
import { es } from "../i18n/es";
import type { Store } from "../store";
import { button, h, slider, toast } from "./dom";

// Drawing cell geometry, in CSS pixels.
const CELL_WIDTH = 640;
const CELL_HEIGHT = 420;
const ORIGIN_X = 150;
const BASELINE_Y = 268;
const X_HEIGHT_PX = 96;
const ASCENDER_Y = BASELINE_Y - 1.9 * X_HEIGHT_PX;
const DESCENDER_Y = BASELINE_Y + 0.9 * X_HEIGHT_PX;
const X_LINE_Y = BASELINE_Y - X_HEIGHT_PX;

/** Speed (x-heights per millisecond) that counts as a fast stroke. */
const FAST_SPEED = 0.02;
const SIMPLIFY_EPSILON = 0.004;
const SECONDS_PER_DRAWING = 8;
const MAX_VARIANTS = 10;
const INK = "#1d2b5c";

const toCellX = (x: number) => ORIGIN_X + x * X_HEIGHT_PX;
const toCellY = (y: number) => BASELINE_Y - y * X_HEIGHT_PX;

function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "mi-mano"
  );
}

export function createDrawView(store: Store): { root: HTMLElement; onShow: () => void } {
  let selectedChar: string | null = null;
  let strokes: Stroke[] = [];
  let active: { points: StrokePoint[]; start: number; pointerType: string; pointerId: number } | null = null;
  let smoothing = loadPreference("draw.smoothing", 0.5);
  let thickness = loadPreference("draw.thickness", 5);
  let simulatePressure = loadPreference("draw.simulatePressure", true);
  let showReference = loadPreference("draw.showReference", true);
  let redrawQueued = false;

  // ----- Left panel: hand, phrase, letters -----
  const nameInput = h("input", { type: "text", class: "text-input", "aria-label": es.hand.nameLabel });
  nameInput.addEventListener("change", () => {
    const name = nameInput.value.trim() || es.hand.defaultName;
    store.update({ hand: { ...store.get().hand, name } });
  });

  const handActions = h(
    "div",
    { class: "button-row" },
    button(es.hand.newHand, () => {
      if (!window.confirm(es.hand.confirmNew)) return;
      strokes = [];
      store.update({ hand: createHand(es.hand.defaultName) });
    }),
    button(es.hand.open, async () => {
      const text = await bridge.openHand();
      if (!text) return;
      try {
        store.update({ hand: parseHand(text) });
        toast(es.hand.opened);
      } catch (error) {
        toast(error instanceof HandFormatError ? es.hand.errors[error.reason] : es.hand.errors.json);
      }
    }),
    button(es.hand.saveAs, async () => {
      const hand = store.get().hand;
      const file = await bridge.saveHandAs(serializeHand(hand), slugify(hand.name));
      if (file) toast(es.hand.saved(file));
    }),
  );

  const phraseInput = h("textarea", { class: "text-input", rows: 3, "aria-label": es.draw.phraseLabel });
  phraseInput.addEventListener("input", () => store.update({ phrase: phraseInput.value }));

  const variantsSelect = h("select", { class: "select", "aria-label": es.draw.variantsLabel });
  for (let n = 1; n <= 5; n++) variantsSelect.append(h("option", { value: n }, String(n)));
  variantsSelect.append(h("option", { value: "more" }, "Más…"));
  const variantsMore = h("input", { type: "number", class: "text-input narrow", min: 6, max: MAX_VARIANTS, step: 1 });
  const variantsWarning = h("p", { class: "warning" }, es.draw.variantsTooMany);
  variantsSelect.addEventListener("change", () => {
    const value = variantsSelect.value === "more" ? Math.max(6, Number(variantsMore.value) || 6) : Number(variantsSelect.value);
    store.update({ variantsTarget: value });
  });
  variantsMore.addEventListener("change", () => {
    const value = Math.max(6, Math.min(MAX_VARIANTS, Math.round(Number(variantsMore.value) || 6)));
    store.update({ variantsTarget: value });
  });

  const lettersGrid = h("div", { class: "letters-grid" });
  const progressText = h("p", { class: "progress-text" });
  const estimateText = h("p", { class: "muted" });

  const leftPanel = h(
    "aside",
    { class: "panel side-panel" },
    h("h2", { class: "panel-title" }, es.hand.title),
    nameInput,
    handActions,
    h("hr"),
    h("label", { class: "field-label" }, es.draw.phraseLabel),
    phraseInput,
    h("p", { class: "muted" }, es.draw.phraseHelp),
    h("label", { class: "field-label" }, es.draw.variantsLabel),
    h("div", { class: "inline" }, variantsSelect, variantsMore),
    h("p", { class: "muted" }, es.draw.variantsHelp),
    variantsWarning,
    h("hr"),
    h("h3", { class: "panel-subtitle" }, es.draw.lettersTitle),
    lettersGrid,
    progressText,
    estimateText,
  );

  // ----- Centre: drawing cell -----
  const canvas = h("canvas", { class: "draw-canvas", width: CELL_WIDTH, height: CELL_HEIGHT });
  const ctx = canvas.getContext("2d")!;
  const currentLabel = h("p", { class: "current-label" });

  const smoothingSlider = slider({
    label: es.draw.smoothing,
    min: 0,
    max: 1,
    step: 0.05,
    value: smoothing,
    format: (v) => `${Math.round(v * 100)} %`,
    onInput: (v) => {
      smoothing = v;
      savePreference("draw.smoothing", v);
    },
  });
  const thicknessSlider = slider({
    label: es.draw.thickness,
    min: 1,
    max: 14,
    step: 1,
    value: thickness,
    format: (v) => `${v} px`,
    onInput: (v) => {
      thickness = v;
      savePreference("draw.thickness", v);
      queueRedraw();
    },
  });
  const pressureToggle = h("input", { type: "checkbox", checked: simulatePressure });
  pressureToggle.addEventListener("change", () => {
    simulatePressure = pressureToggle.checked;
    savePreference("draw.simulatePressure", simulatePressure);
  });
  const referenceToggle = h("input", { type: "checkbox", checked: showReference });
  referenceToggle.addEventListener("change", () => {
    showReference = referenceToggle.checked;
    savePreference("draw.showReference", showReference);
    queueRedraw();
  });

  const centre = h(
    "section",
    { class: "draw-centre" },
    currentLabel,
    h("div", { class: "canvas-frame" }, canvas),
    h(
      "div",
      { class: "button-row centred" },
      button(es.draw.undo, undoStroke),
      button(es.draw.clear, clearDrawing),
      button(es.draw.save, saveVariant, "primary"),
    ),
    h("p", { class: "muted centred-text" }, es.draw.shortcuts),
    h(
      "div",
      { class: "panel tools-panel" },
      smoothingSlider.root,
      thicknessSlider.root,
      h("label", { class: "check" }, pressureToggle, es.draw.simulatePressure),
      h("label", { class: "check" }, referenceToggle, es.draw.showReference),
    ),
  );

  // ----- Right panel: variants of the selected character -----
  const variantsTitle = h("h2", { class: "panel-title" });
  const variantsList = h("div", { class: "variants-list" });
  const rightPanel = h(
    "aside",
    { class: "panel side-panel" },
    variantsTitle,
    variantsList,
    h("hr"),
    button(es.draw.goToSheet, () => store.update({ tab: "sheet" }), "primary"),
  );

  const root = h("div", { class: "draw-view" }, leftPanel, centre, rightPanel);

  // ----- Logic -----
  function allCharacters(): string[] {
    const { phrase, extraChars } = store.get();
    const chars = charactersNeeded(phrase);
    for (const char of extraChars) if (!chars.includes(char)) chars.push(char);
    return chars;
  }

  function countOf(char: string): number {
    return store.get().hand.glyphs[char]?.length ?? 0;
  }

  function firstIncomplete(after: string | null): string | null {
    const chars = allCharacters();
    const target = store.get().variantsTarget;
    const start = after ? chars.indexOf(after) + 1 : 0;
    for (let k = 0; k < chars.length; k++) {
      const char = chars[(start + k) % chars.length];
      if (countOf(char) < target) return char;
    }
    return null;
  }

  function ensureSelection(): void {
    const chars = allCharacters();
    if (selectedChar && chars.includes(selectedChar)) return;
    selectedChar = firstIncomplete(null) ?? chars[0] ?? null;
  }

  function setupCanvas(): void {
    const ratio = window.devicePixelRatio || 1;
    // CSS scales the cell to the available width; pointer positions are mapped back.
    canvas.width = Math.round(CELL_WIDTH * ratio);
    canvas.height = Math.round(CELL_HEIGHT * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function referenceFontSize(): number {
    ctx.font = "100px Georgia, 'Times New Roman', serif";
    const ascent = ctx.measureText("x").actualBoundingBoxAscent || 46;
    return (X_HEIGHT_PX / ascent) * 100;
  }

  function drawGuide(y: number, color: string, dash: number[], width = 1): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(24, y);
    ctx.lineTo(CELL_WIDTH - 24, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawStroke(points: StrokePoint[]): void {
    if (points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(toCellX(points[0].x), toCellY(points[0].y), thickness / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 1; i < points.length; i++) {
      const pressure = (points[i - 1].p + points[i].p) / 2;
      ctx.lineWidth = Math.max(1, thickness * (0.55 + 0.6 * pressure));
      ctx.beginPath();
      ctx.moveTo(toCellX(points[i - 1].x), toCellY(points[i - 1].y));
      ctx.lineTo(toCellX(points[i].x), toCellY(points[i].y));
      ctx.stroke();
    }
    ctx.restore();
  }

  function redraw(): void {
    redrawQueued = false;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CELL_WIDTH, CELL_HEIGHT);
    ctx.restore();
    drawGuide(ASCENDER_Y, "#d5dbe8", [2, 4]);
    drawGuide(X_LINE_Y, "#aab6d3", [6, 5]);
    drawGuide(BASELINE_Y, "#6f86c2", [], 1.5);
    drawGuide(DESCENDER_Y, "#d5dbe8", [2, 4]);
    ctx.save();
    ctx.strokeStyle = "#e3e7f0";
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(ORIGIN_X, 20);
    ctx.lineTo(ORIGIN_X, CELL_HEIGHT - 20);
    ctx.stroke();
    ctx.restore();

    if (showReference && selectedChar) {
      ctx.save();
      ctx.font = `${referenceFontSize()}px Georgia, 'Times New Roman', serif`;
      ctx.fillStyle = "rgba(41, 72, 168, 0.11)";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(selectedChar, ORIGIN_X + 6, BASELINE_Y);
      ctx.restore();
    }
    for (const stroke of strokes) drawStroke(stroke);
    if (active) drawStroke(active.points);
  }

  function queueRedraw(): void {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(redraw);
  }

  function eventToPoint(event: PointerEvent, start: number): StrokePoint {
    const rect = canvas.getBoundingClientRect();
    const cssX = ((event.clientX - rect.left) * CELL_WIDTH) / rect.width;
    const cssY = ((event.clientY - rect.top) * CELL_HEIGHT) / rect.height;
    const realPressure = event.pointerType === "pen" && event.pressure > 0;
    return {
      x: (cssX - ORIGIN_X) / X_HEIGHT_PX,
      y: (BASELINE_Y - cssY) / X_HEIGHT_PX,
      p: realPressure ? event.pressure : 0.6,
      t: event.timeStamp - start,
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!selectedChar) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const start = event.timeStamp;
    active = { points: [eventToPoint(event, start)], start, pointerType: event.pointerType, pointerId: event.pointerId };
    queueRedraw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    for (const item of events.length > 0 ? events : [event]) {
      const raw = eventToPoint(item, active.start);
      const last = active.points[active.points.length - 1];
      active.points.push(stabilise(last, raw, smoothing));
    }
    queueRedraw();
  });

  const finishStroke = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return;
    let points = smoothStroke(active.points, smoothing);
    if (active.pointerType !== "pen") {
      points = simulatePressure ? pressureFromVelocity(points, FAST_SPEED) : points.map((p) => ({ ...p, p: 0.6 }));
    }
    points = simplify(points, SIMPLIFY_EPSILON);
    strokes.push(points);
    active = null;
    queueRedraw();
  };
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);

  function undoStroke(): void {
    strokes.pop();
    queueRedraw();
  }

  function clearDrawing(): void {
    strokes = [];
    queueRedraw();
  }

  function saveVariant(): void {
    if (!selectedChar || strokes.length === 0) return;
    const variant: GlyphVariant = { strokes };
    const char = selectedChar;
    store.update({ hand: withVariantAdded(store.get().hand, char, variant) });
    strokes = [];
    if (countOf(char) >= store.get().variantsTarget) {
      selectedChar = firstIncomplete(char) ?? char;
    }
    refresh();
    queueRedraw();
  }

  function selectChar(char: string): void {
    if (char === selectedChar) return;
    selectedChar = char;
    strokes = [];
    refresh();
    queueRedraw();
  }

  function thumbnail(variant: GlyphVariant): HTMLCanvasElement {
    const width = 120;
    const height = 84;
    const ratio = window.devicePixelRatio || 1;
    const thumb = h("canvas", { class: "thumb" });
    thumb.width = width * ratio;
    thumb.height = height * ratio;
    thumb.style.width = `${width}px`;
    thumb.style.height = `${height}px`;
    const tctx = thumb.getContext("2d")!;
    tctx.scale(ratio, ratio);
    const scale = 26;
    const baseline = 58;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const stroke of variant.strokes) for (const point of stroke) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
    }
    const offset = (width - (maxX - minX) * scale) / 2 - minX * scale;
    tctx.strokeStyle = "#dfe4ee";
    tctx.beginPath();
    tctx.moveTo(6, baseline);
    tctx.lineTo(width - 6, baseline);
    tctx.stroke();
    tctx.strokeStyle = INK;
    tctx.lineWidth = 1.6;
    tctx.lineCap = "round";
    tctx.lineJoin = "round";
    for (const stroke of variant.strokes) {
      tctx.beginPath();
      stroke.forEach((point, i) => {
        const x = offset + point.x * scale;
        const y = baseline - point.y * scale;
        if (i === 0) tctx.moveTo(x, y);
        else tctx.lineTo(x, y);
      });
      if (stroke.length === 1) tctx.lineTo(offset + stroke[0].x * scale + 0.1, baseline - stroke[0].y * scale);
      tctx.stroke();
    }
    return thumb;
  }

  function refresh(): void {
    const state = store.get();
    ensureSelection();
    if (document.activeElement !== nameInput) nameInput.value = state.hand.name;
    if (document.activeElement !== phraseInput) phraseInput.value = state.phrase;

    const target = state.variantsTarget;
    if (target <= 5) {
      variantsSelect.value = String(target);
      variantsMore.hidden = true;
    } else {
      variantsSelect.value = "more";
      variantsMore.hidden = false;
      variantsMore.value = String(target);
    }
    variantsWarning.hidden = target <= 5;

    const chars = allCharacters();
    lettersGrid.replaceChildren(
      ...chars.map((char) => {
        const count = countOf(char);
        const chip = h(
          "button",
          {
            type: "button",
            class: `letter-chip${count >= target ? " done" : ""}${char === selectedChar ? " selected" : ""}`,
            title: char,
          },
          h("span", { class: "letter-char" }, char),
          h("span", { class: "letter-count" }, `${Math.min(count, 99)}/${target}`),
        );
        chip.addEventListener("click", () => selectChar(char));
        return chip;
      }),
    );

    const remaining = chars.reduce((sum, char) => sum + Math.max(0, target - countOf(char)), 0);
    progressText.textContent = chars.length === 0 ? es.draw.nothingToDraw : es.draw.progress(remaining);
    estimateText.textContent = remaining > 0 ? es.draw.estimate(Math.max(1, Math.ceil((remaining * SECONDS_PER_DRAWING) / 60))) : "";

    if (selectedChar) {
      const count = countOf(selectedChar);
      currentLabel.textContent =
        count < target ? es.draw.current(selectedChar, count + 1, target) : es.draw.currentExtra(selectedChar, count + 1 - target);
      variantsTitle.textContent = es.draw.variantsOf(selectedChar);
      const variants = state.hand.glyphs[selectedChar] ?? [];
      const char = selectedChar;
      variantsList.replaceChildren(
        ...(variants.length === 0
          ? [h("p", { class: "muted" }, es.draw.noVariants)]
          : variants.map((variant, index) => {
              const remove = h("button", { type: "button", class: "icon-button", title: es.draw.deleteVariant, "aria-label": es.draw.deleteVariant }, "×");
              remove.addEventListener("click", () => {
                if (!window.confirm(es.draw.confirmDelete)) return;
                store.update({ hand: withVariantRemoved(store.get().hand, char, index) });
              });
              return h("div", { class: "variant-card" }, thumbnail(variant), remove);
            })),
      );
    } else {
      currentLabel.textContent = es.draw.nothingToDraw;
      variantsTitle.textContent = "";
      variantsList.replaceChildren();
    }
  }

  store.subscribe((state, previous) => {
    if (state.hand !== previous.hand || state.phrase !== previous.phrase || state.extraChars !== previous.extraChars || state.variantsTarget !== previous.variantsTarget) {
      if (state.hand !== previous.hand && state.hand.createdAt !== previous.hand.createdAt) strokes = [];
      refresh();
      queueRedraw();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (store.get().tab !== "draw") return;
    const target = event.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      saveVariant();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoStroke();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearDrawing();
    }
  });

  setupCanvas();
  refresh();
  redraw();

  return {
    root,
    onShow() {
      setupCanvas();
      refresh();
      redraw();
    },
  };
}
