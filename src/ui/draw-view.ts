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
import { createZoomControl } from "./zoom";

// Drawing area geometry, in logical pixels (the zoom scales all of it).
const CELL_HEIGHT = 420;
const BASELINE_Y = 268;
const X_HEIGHT_PX = 96;
const ASCENDER_Y = BASELINE_Y - 1.9 * X_HEIGHT_PX;
const DESCENDER_Y = BASELINE_Y + 0.9 * X_HEIGHT_PX;
const X_LINE_Y = BASELINE_Y - X_HEIGHT_PX;
const SIDE_PAD = 20;
const MIN_WIDTH = 640;
/** At most this many ghost slots on screen; more variants take several saves. */
const MAX_SLOTS = 5;
/** Slot width: the reference letter plus room around it, in x-heights. */
const SLOT_MIN_XH = 2.3;
const SLOT_ROOM_XH = 1.2;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 4;
/** Canvas backing store limit, in pixels, so very high zoom stays fast. */
const MAX_CANVAS_PIXELS = 24_000_000;

/** Speed (x-heights per millisecond) that counts as a fast stroke. */
const FAST_SPEED = 0.02;
const SIMPLIFY_EPSILON = 0.004;
const SECONDS_PER_DRAWING = 6;
const MAX_VARIANTS = 20;
const INK = "#1d2b5c";
const REFERENCE_FONT = "Georgia, 'Times New Roman', serif";

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
  /** The user chose to keep drawing extra variants after finishing every letter. */
  let extraMode = false;
  /** Strokes of every ghost slot, in x-height units from that slot's origin. */
  let slotStrokes: Stroke[][] = [[]];
  /** Slot of every stroke, in drawing order (for undo). */
  let history: number[] = [];
  let active: { slot: number; points: StrokePoint[]; start: number; pointerType: string; pointerId: number } | null = null;
  let slotWidth = MIN_WIDTH - 2 * SIDE_PAD;
  let canvasWidth = MIN_WIDTH;
  let referenceWidth = X_HEIGHT_PX;
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
      slotStrokes = [];
      history = [];
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

  // ----- Centre: drawing area with ghost slots -----
  const canvas = h("canvas", { class: "draw-canvas" });
  const ctx = canvas.getContext("2d")!;
  const currentLabel = h("p", { class: "current-label" });
  const canvasFrame = h("div", { class: "canvas-frame" }, canvas);
  const doneExtraButton = button("", () => {
    extraMode = true;
    refresh();
  });
  const donePanel = h(
    "div",
    { class: "done-panel", hidden: true },
    h("div", { class: "done-icon", "aria-hidden": "true" }, "✓"),
    h("h2", {}, es.draw.doneTitle),
    h("p", { class: "muted" }, es.draw.doneText),
    h("div", { class: "button-row centred" }, button(es.draw.goToSheet, () => store.update({ tab: "sheet" }), "primary"), doneExtraButton),
  );
  const drawingArea = h("div", { class: "drawing-area" }, canvasFrame, donePanel);
  const saveButton = button(es.draw.save, saveAll, "primary");
  const slotsHelp = h("p", { class: "muted centred-text" }, es.draw.slotsHelp);
  const shortcutsText = h("p", { class: "muted centred-text" }, es.draw.shortcuts);
  const drawButtons = h("div", { class: "button-row centred" }, button(es.draw.undo, undoStroke), button(es.draw.clear, clearDrawing), saveButton);

  const zoom = createZoomControl({
    scroller: canvasFrame,
    content: () => canvas,
    min: ZOOM_MIN,
    max: ZOOM_MAX,
    fit: () => Math.min(1.5, Math.max(ZOOM_MIN, (canvasFrame.clientWidth - 2) / canvasWidth)),
    apply: (scale) => {
      sizeCanvas(scale);
      redraw();
    },
  });

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
    h("div", { class: "draw-head" }, currentLabel, zoom.bar),
    drawingArea,
    drawButtons,
    slotsHelp,
    shortcutsText,
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
    slotStrokes = [];
    history = [];
  }

  /** How many ghost slots to show for the selected character. */
  function slotCount(): number {
    if (!selectedChar) return 1;
    const missing = store.get().variantsTarget - countOf(selectedChar);
    return Math.max(1, Math.min(MAX_SLOTS, missing));
  }

  function referenceFontSize(): number {
    ctx.font = `100px ${REFERENCE_FONT}`;
    const ascent = ctx.measureText("x").actualBoundingBoxAscent || 46;
    return (X_HEIGHT_PX / ascent) * 100;
  }

  /** Recomputes slots and canvas width; keeps what is already drawn in the slots that remain. */
  function layoutSlots(): void {
    const count = slotCount();
    slotStrokes = Array.from({ length: count }, (_, i) => slotStrokes[i] ?? []);
    history = history.filter((slot) => slot < count);
    ctx.font = `${referenceFontSize()}px ${REFERENCE_FONT}`;
    referenceWidth = selectedChar ? ctx.measureText(selectedChar).width : X_HEIGHT_PX;
    const natural = Math.max(SLOT_MIN_XH * X_HEIGHT_PX, referenceWidth + SLOT_ROOM_XH * X_HEIGHT_PX);
    canvasWidth = Math.max(MIN_WIDTH, 2 * SIDE_PAD + count * natural);
    slotWidth = (canvasWidth - 2 * SIDE_PAD) / count;
    saveButton.textContent = count > 1 ? es.draw.saveMany : es.draw.save;
    slotsHelp.hidden = count < 2;
  }

  const slotLeft = (slot: number) => SIDE_PAD + slot * slotWidth;
  /** Where the reference letter starts in a slot; strokes are stored relative to it. */
  const slotOrigin = (slot: number) => slotLeft(slot) + Math.max(0, (slotWidth - referenceWidth) / 2);
  const toCellX = (slot: number, x: number) => slotOrigin(slot) + x * X_HEIGHT_PX;
  const toCellY = (y: number) => BASELINE_Y - y * X_HEIGHT_PX;

  function sizeCanvas(scale: number): void {
    const ratio = window.devicePixelRatio || 1;
    let backing = scale * ratio;
    const pixels = canvasWidth * CELL_HEIGHT * backing * backing;
    if (pixels > MAX_CANVAS_PIXELS) backing *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    canvas.width = Math.round(canvasWidth * backing);
    canvas.height = Math.round(CELL_HEIGHT * backing);
    canvas.style.width = `${canvasWidth * scale}px`;
    canvas.style.height = `${CELL_HEIGHT * scale}px`;
    ctx.setTransform(backing, 0, 0, backing, 0, 0);
  }

  function drawGuide(y: number, color: string, dash: number[], width = 1): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(SIDE_PAD, y);
    ctx.lineTo(canvasWidth - SIDE_PAD, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawStroke(slot: number, points: StrokePoint[]): void {
    if (points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(toCellX(slot, points[0].x), toCellY(points[0].y), thickness / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 1; i < points.length; i++) {
      const pressure = (points[i - 1].p + points[i].p) / 2;
      ctx.lineWidth = Math.max(1, thickness * (0.55 + 0.6 * pressure));
      ctx.beginPath();
      ctx.moveTo(toCellX(slot, points[i - 1].x), toCellY(points[i - 1].y));
      ctx.lineTo(toCellX(slot, points[i].x), toCellY(points[i].y));
      ctx.stroke();
    }
    ctx.restore();
  }

  function redraw(): void {
    redrawQueued = false;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, CELL_HEIGHT);
    ctx.restore();

    const count = slotStrokes.length;
    const nextEmpty = slotStrokes.findIndex((strokes) => strokes.length === 0);
    if (count > 1 && nextEmpty >= 0 && !active) {
      ctx.fillStyle = "#f4f6fc";
      ctx.fillRect(slotLeft(nextEmpty), 14, slotWidth, CELL_HEIGHT - 28);
    }
    drawGuide(ASCENDER_Y, "#d5dbe8", [2, 4]);
    drawGuide(X_LINE_Y, "#aab6d3", [6, 5]);
    drawGuide(BASELINE_Y, "#6f86c2", [], 1.5);
    drawGuide(DESCENDER_Y, "#d5dbe8", [2, 4]);

    ctx.save();
    ctx.strokeStyle = "#dde2ec";
    ctx.setLineDash([3, 5]);
    for (let slot = 1; slot < count; slot++) {
      ctx.beginPath();
      ctx.moveTo(slotLeft(slot), 20);
      ctx.lineTo(slotLeft(slot), CELL_HEIGHT - 20);
      ctx.stroke();
    }
    ctx.restore();

    if (selectedChar) {
      ctx.save();
      ctx.textBaseline = "alphabetic";
      if (count > 1) {
        ctx.font = `13px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = "#9aa3b5";
        for (let slot = 0; slot < count; slot++) ctx.fillText(String(slot + 1), slotLeft(slot) + 8, 32);
      }
      if (showReference) {
        ctx.font = `${referenceFontSize()}px ${REFERENCE_FONT}`;
        for (let slot = 0; slot < count; slot++) {
          // Ghost letter: fainter once the slot has been drawn in.
          ctx.fillStyle = slotStrokes[slot].length > 0 ? "rgba(41, 72, 168, 0.05)" : "rgba(41, 72, 168, 0.11)";
          ctx.fillText(selectedChar, slotOrigin(slot), BASELINE_Y);
        }
      }
      ctx.restore();
    }
    slotStrokes.forEach((strokes, slot) => strokes.forEach((stroke) => drawStroke(slot, stroke)));
    if (active) drawStroke(active.slot, active.points);
  }

  function queueRedraw(): void {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(redraw);
  }

  /** Pointer position in logical canvas pixels. */
  function eventToCell(event: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvasWidth) / rect.width,
      y: ((event.clientY - rect.top) * CELL_HEIGHT) / rect.height,
    };
  }

  function eventToPoint(event: PointerEvent, slot: number, start: number): StrokePoint {
    const cell = eventToCell(event);
    const realPressure = event.pointerType === "pen" && event.pressure > 0;
    return {
      x: (cell.x - slotOrigin(slot)) / X_HEIGHT_PX,
      y: (BASELINE_Y - cell.y) / X_HEIGHT_PX,
      p: realPressure ? event.pressure : 0.6,
      t: event.timeStamp - start,
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!selectedChar) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    // A stroke belongs to the slot where it starts, even if it runs over the edge.
    const cellX = eventToCell(event).x;
    const slot = Math.max(0, Math.min(slotStrokes.length - 1, Math.floor((cellX - SIDE_PAD) / slotWidth)));
    const start = event.timeStamp;
    active = { slot, points: [eventToPoint(event, slot, start)], start, pointerType: event.pointerType, pointerId: event.pointerId };
    queueRedraw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    for (const item of events.length > 0 ? events : [event]) {
      const raw = eventToPoint(item, active.slot, active.start);
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
    slotStrokes[active.slot].push(points);
    history.push(active.slot);
    active = null;
    queueRedraw();
  };
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);

  function undoStroke(): void {
    const slot = history.pop();
    if (slot === undefined) return;
    slotStrokes[slot].pop();
    queueRedraw();
  }

  function clearDrawing(): void {
    slotStrokes = slotStrokes.map(() => []);
    history = [];
    queueRedraw();
  }

  /** Relayout after the slot count may have changed; keeps the zoom. */
  function relayout(): void {
    const before = canvasWidth;
    layoutSlots();
    if (canvasWidth !== before) zoom.refit();
    sizeCanvas(zoom.scale());
    queueRedraw();
  }

  /** Saves every slot that has a drawing, each as one variant. */
  function saveAll(): void {
    if (!selectedChar) return;
    const drawn = slotStrokes.filter((strokes) => strokes.length > 0);
    if (drawn.length === 0) return;
    const char = selectedChar;
    let hand = store.get().hand;
    for (const strokes of drawn) hand = withVariantAdded(hand, char, { strokes } satisfies GlyphVariant);
    slotStrokes = [];
    history = [];
    store.update({ hand });
    if (countOf(char) >= store.get().variantsTarget) {
      selectedChar = firstIncomplete(char) ?? char;
    }
    refresh();
    relayout();
  }

  function selectChar(char: string): void {
    // Picking a finished letter means the user wants extra variants of it.
    if (countOf(char) >= store.get().variantsTarget) extraMode = true;
    if (char === selectedChar) {
      refresh();
      return;
    }
    selectedChar = char;
    slotStrokes = [];
    history = [];
    refresh();
    relayout();
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
    progressText.classList.toggle("finished", chars.length > 0 && remaining === 0);
    // Everything drawn: say so clearly instead of quietly offering extra variants.
    if (remaining > 0) extraMode = false;
    const finished = chars.length > 0 && remaining === 0 && !extraMode;
    donePanel.hidden = !finished;
    canvasFrame.classList.toggle("dimmed", finished);
    drawButtons.hidden = finished;
    shortcutsText.hidden = finished;
    if (finished) slotsHelp.hidden = true;
    doneExtraButton.textContent = es.draw.doneExtra(selectedChar ?? chars[0] ?? "");
    estimateText.textContent = remaining > 0 ? es.draw.estimate(Math.max(1, Math.ceil((remaining * SECONDS_PER_DRAWING) / 60))) : "";

    if (selectedChar) {
      const count = countOf(selectedChar);
      currentLabel.textContent =
        count < target
          ? es.draw.current(selectedChar, count + 1, Math.min(target, count + slotCount()), target)
          : es.draw.currentExtra(selectedChar, count + 1 - target);
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
    if (finished) currentLabel.textContent = es.draw.doneLabel;
  }

  store.subscribe((state, previous) => {
    if (state.drawFocus && state.drawFocus !== previous.drawFocus) {
      const focus = state.drawFocus;
      queueMicrotask(() => {
        store.update({ drawFocus: null });
        if (allCharacters().includes(focus)) selectChar(focus);
      });
    }
    if (state.hand !== previous.hand || state.phrase !== previous.phrase || state.extraChars !== previous.extraChars || state.variantsTarget !== previous.variantsTarget) {
      if (state.hand !== previous.hand && state.hand.createdAt !== previous.hand.createdAt) {
        slotStrokes = [];
        history = [];
      }
      refresh();
      relayout();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (store.get().tab !== "draw") return;
    const target = event.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!donePanel.hidden) return;
      saveAll();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoStroke();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearDrawing();
    }
  });

  window.addEventListener("resize", () => {
    if (store.get().tab === "draw") zoom.refit();
  });

  refresh();
  layoutSlots();
  sizeCanvas(1);

  return {
    root,
    onShow() {
      refresh();
      layoutSlots();
      // The frame only has a size once the view is visible.
      requestAnimationFrame(() => {
        zoom.refit();
        redraw();
      });
    },
  };
}
