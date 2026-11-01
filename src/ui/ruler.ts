// Horizontal ruler above the pages, in centimetres, with the left and right
// margins as handles you can drag (like in any word processor).

import { es } from "../i18n/es";
import { h } from "./dom";

export interface RulerOptions {
  /** Left edge of the page on screen (client px) and px per mm, or null when no page is visible. */
  pageGeometry: () => { left: number; pxPerMm: number } | null;
  margins: () => { left: number; right: number; width: number };
  /** Called while dragging, with the new margins in millimetres. */
  onChange: (left: number, right: number) => void;
}

const HEIGHT = 24;
const MIN_TEXT_WIDTH_MM = 30;

export function createRuler(options: RulerOptions): { root: HTMLElement; redraw(): void } {
  const canvas = h("canvas", { class: "ruler-canvas" });
  const leftHandle = h("div", { class: "ruler-handle", title: es.ruler.left, "aria-label": es.ruler.left, role: "slider" });
  const rightHandle = h("div", { class: "ruler-handle", title: es.ruler.right, "aria-label": es.ruler.right, role: "slider" });
  const root = h("div", { class: "ruler" }, canvas, leftHandle, rightHandle);
  const ctx = canvas.getContext("2d")!;

  function redraw(): void {
    const geometry = options.pageGeometry();
    const rect = root.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width));
    if (canvas.width !== width * ratio || canvas.height !== HEIGHT * ratio) {
      canvas.width = width * ratio;
      canvas.height = HEIGHT * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${HEIGHT}px`;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    root.classList.toggle("empty", !geometry);
    if (!geometry) return;
    const { left, right, width: pageWidth } = options.margins();
    const x0 = geometry.left - rect.left;
    const k = geometry.pxPerMm;
    // Page: grey margins, white writing area.
    ctx.fillStyle = "#e3e6eb";
    ctx.fillRect(x0, 4, pageWidth * k, HEIGHT - 8);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x0 + left * k, 4, (pageWidth - left - right) * k, HEIGHT - 8);
    ctx.strokeStyle = "#8a909b";
    ctx.fillStyle = "#5f6672";
    ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const everyMm = k >= 3 ? 1 : k >= 1.2 ? 5 : 10;
    for (let mm = 0; mm <= pageWidth; mm += everyMm) {
      const x = Math.round(x0 + mm * k) + 0.5;
      if (mm % 10 === 0) {
        if (mm > 0 && mm < pageWidth) ctx.fillText(String(mm / 10), x, HEIGHT / 2);
        continue;
      }
      const tall = mm % 5 === 0 ? 5 : 3;
      ctx.moveTo(x, HEIGHT / 2 - tall / 2);
      ctx.lineTo(x, HEIGHT / 2 + tall / 2);
    }
    ctx.stroke();
    leftHandle.style.left = `${x0 + left * k}px`;
    rightHandle.style.left = `${x0 + (pageWidth - right) * k}px`;
  }

  const drag = (handle: HTMLElement, side: "left" | "right") => {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const geometry = options.pageGeometry();
        if (!geometry) return;
        const { left, right, width } = options.margins();
        const mm = Math.round(((moveEvent.clientX - geometry.left) / geometry.pxPerMm) * 2) / 2;
        if (side === "left") options.onChange(Math.max(0, Math.min(width - right - MIN_TEXT_WIDTH_MM, mm)), right);
        else options.onChange(left, Math.max(0, Math.min(width - left - MIN_TEXT_WIDTH_MM, width - mm)));
        redraw();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  };
  drag(leftHandle, "left");
  drag(rightHandle, "right");
  window.addEventListener("resize", redraw);

  return { root, redraw };
}
