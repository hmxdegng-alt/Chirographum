// Zoom for a scrollable view: Ctrl + mouse wheel (or trackpad pinch) and a
// small bar with −, the percentage, + and "Ajustar". The point under the
// mouse stays put while zooming.

import { es } from "../i18n/es";
import { button, h } from "./dom";

export interface ZoomOptions {
  /** Element that scrolls when the content is bigger than the view. */
  scroller: HTMLElement;
  /** Element whose size changes with the zoom (used to keep the mouse point fixed). */
  content: () => HTMLElement;
  min: number;
  max: number;
  /** Scale that fits the content in the view. */
  fit: () => number;
  /** Resizes the content for a scale; must change its size synchronously. */
  apply: (scale: number) => void;
  /** Adds a "100 %" button (true size). */
  actualSize?: boolean;
}

export interface ZoomControl {
  bar: HTMLElement;
  scale(): number;
  /** Recomputes the fit scale (after a window resize) when in fit mode. */
  refit(): void;
  reset(): void;
}

/** Fine steps: about 11 % per wheel notch, 10 % per button press. */
const WHEEL_SENSITIVITY = 0.0011;
const BUTTON_STEP = 0.1;

export function createZoomControl(options: ZoomOptions): ZoomControl {
  let fitMode = true;
  let scale = 1;
  const label = h("span", { class: "zoom-value", title: es.zoom.hint });

  const clamp = (value: number) => Math.max(options.min, Math.min(options.max, value));

  function set(value: number, point?: { x: number; y: number }): void {
    const next = clamp(value);
    const content = options.content();
    const before = content.getBoundingClientRect();
    const anchor = point ?? {
      x: options.scroller.getBoundingClientRect().left + options.scroller.clientWidth / 2,
      y: options.scroller.getBoundingClientRect().top + options.scroller.clientHeight / 2,
    };
    const fx = before.width > 0 ? (anchor.x - before.left) / before.width : 0.5;
    const fy = before.height > 0 ? (anchor.y - before.top) / before.height : 0.5;
    scale = next;
    options.apply(scale);
    const after = content.getBoundingClientRect();
    options.scroller.scrollLeft += after.left + fx * after.width - anchor.x;
    options.scroller.scrollTop += after.top + fy * after.height - anchor.y;
    label.textContent = `${Math.round(scale * 100)} %`;
    fitButton.classList.toggle("active", fitMode);
    actualButton?.classList.toggle("active", !fitMode && Math.abs(scale - 1) < 0.005);
  }

  const step = (direction: 1 | -1) => {
    fitMode = false;
    const percent = scale / BUTTON_STEP;
    const next = direction > 0 ? Math.floor(percent + 1e-6) + 1 : Math.ceil(percent - 1e-6) - 1;
    set(next * BUTTON_STEP);
  };

  const outButton = button("−", () => step(-1), "ghost");
  outButton.title = es.zoom.out;
  outButton.setAttribute("aria-label", es.zoom.out);
  const inButton = button("+", () => step(1), "ghost");
  inButton.title = es.zoom.in;
  inButton.setAttribute("aria-label", es.zoom.in);
  const fitButton = button(es.zoom.fit, () => {
    fitMode = true;
    set(options.fit());
  }, "ghost");
  const actualButton = options.actualSize
    ? button("100 %", () => {
        fitMode = false;
        set(1);
      }, "ghost")
    : null;

  options.scroller.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      fitMode = false;
      set(scale * Math.exp(-delta * WHEEL_SENSITIVITY), { x: event.clientX, y: event.clientY });
    },
    { passive: false },
  );

  const bar = h("div", { class: "zoom-bar" }, outButton, label, inButton, fitButton, actualButton);

  return {
    bar,
    scale: () => scale,
    refit() {
      if (fitMode) set(options.fit());
    },
    reset() {
      fitMode = true;
      set(options.fit());
    },
  };
}
