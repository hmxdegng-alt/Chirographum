// "Otro color": a small colour panel that opens under its button and closes
// with the same button, Escape or a click outside. Chromium's native picker
// cannot be closed from the page, so the app draws its own.

import { es } from "../i18n/es";
import { h } from "./dom";

interface Hsv {
  h: number;
  s: number;
  v: number;
}

const AREA_WIDTH = 232;
const AREA_HEIGHT = 140;

export function hexToHsv(hex: string): Hsv {
  const clean = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace("#", "") : "22399a";
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h: hue, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const byte = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export interface ColorPopover {
  /** Button + panel, to place in the layout. */
  root: HTMLElement;
  setColor(hex: string): void;
  setDisabled(disabled: boolean): void;
  close(): void;
}

/**
 * @param onInput called continuously while the user picks.
 * @param onCommit called when the panel closes with a changed colour.
 */
export function createColorPopover(initial: string, onInput: (hex: string) => void, onCommit: (hex: string) => void): ColorPopover {
  let hsv = hexToHsv(initial);
  let openedWith = "";
  let disabled = false;

  const chip = h("span", { class: "color-chip" });
  const toggle = h("button", { type: "button", class: "btn btn-secondary color-toggle", "aria-expanded": "false" }, chip, es.sheet.customColor);

  const area = h("canvas", { class: "color-area", "aria-label": es.sheet.colorArea });
  const areaCtx = area.getContext("2d")!;
  const hue = h("input", { type: "range", class: "hue-slider", min: 0, max: 360, step: 1, "aria-label": es.sheet.colorHue });
  const code = h("input", { type: "text", class: "text-input color-code", maxlength: 7, spellcheck: "false", "aria-label": es.sheet.colorCode });
  const panel = h(
    "div",
    { class: "color-panel", hidden: true, role: "dialog" },
    area,
    hue,
    h("label", { class: "color-code-row" }, h("span", {}, es.sheet.colorCode), code),
  );
  const root = h("div", { class: "color-popover" }, toggle, panel);

  const current = () => hsvToHex(hsv);

  function paint(): void {
    const ratio = window.devicePixelRatio || 1;
    if (area.width !== AREA_WIDTH * ratio) {
      area.width = AREA_WIDTH * ratio;
      area.height = AREA_HEIGHT * ratio;
      area.style.width = `${AREA_WIDTH}px`;
      area.style.height = `${AREA_HEIGHT}px`;
    }
    areaCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    areaCtx.fillStyle = hsvToHex({ h: hsv.h, s: 1, v: 1 });
    areaCtx.fillRect(0, 0, AREA_WIDTH, AREA_HEIGHT);
    const white = areaCtx.createLinearGradient(0, 0, AREA_WIDTH, 0);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(1, "rgba(255,255,255,0)");
    areaCtx.fillStyle = white;
    areaCtx.fillRect(0, 0, AREA_WIDTH, AREA_HEIGHT);
    const black = areaCtx.createLinearGradient(0, 0, 0, AREA_HEIGHT);
    black.addColorStop(0, "rgba(0,0,0,0)");
    black.addColorStop(1, "#000000");
    areaCtx.fillStyle = black;
    areaCtx.fillRect(0, 0, AREA_WIDTH, AREA_HEIGHT);
    const x = hsv.s * AREA_WIDTH;
    const y = (1 - hsv.v) * AREA_HEIGHT;
    areaCtx.lineWidth = 2;
    areaCtx.strokeStyle = hsv.v > 0.55 && hsv.s < 0.5 ? "#1f2328" : "#ffffff";
    areaCtx.beginPath();
    areaCtx.arc(x, y, 6, 0, Math.PI * 2);
    areaCtx.stroke();
  }

  function sync(): void {
    hue.value = String(Math.round(hsv.h));
    if (document.activeElement !== code) code.value = current();
    chip.style.background = current();
    if (!panel.hidden) paint();
  }

  function emit(): void {
    sync();
    onInput(current());
  }

  function open(): void {
    if (disabled) return;
    openedWith = current();
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    toggle.classList.add("active");
    paint();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }

  function close(): void {
    if (panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.classList.remove("active");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (current() !== openedWith) onCommit(current());
  }

  function onOutside(event: PointerEvent): void {
    if (!root.contains(event.target as Node)) close();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      toggle.focus();
    }
  }

  toggle.addEventListener("click", () => (panel.hidden ? open() : close()));

  const pickAt = (event: PointerEvent) => {
    const rect = area.getBoundingClientRect();
    hsv = {
      h: hsv.h,
      s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      v: Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height)),
    };
    emit();
  };
  area.addEventListener("pointerdown", (event) => {
    area.setPointerCapture(event.pointerId);
    pickAt(event);
  });
  area.addEventListener("pointermove", (event) => {
    if (area.hasPointerCapture(event.pointerId)) pickAt(event);
  });
  hue.addEventListener("input", () => {
    hsv = { ...hsv, h: Number(hue.value) };
    emit();
  });
  code.addEventListener("input", () => {
    const value = code.value.trim();
    const hex = value.startsWith("#") ? value : `#${value}`;
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      hsv = hexToHsv(hex);
      emit();
    }
  });
  code.addEventListener("blur", () => (code.value = current()));

  sync();

  return {
    root,
    setColor(hex: string) {
      if (hex.toLowerCase() === current().toLowerCase()) return;
      hsv = hexToHsv(hex);
      sync();
    },
    setDisabled(value: boolean) {
      disabled = value;
      toggle.disabled = value;
      if (value) close();
    },
    close,
  };
}
