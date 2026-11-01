// Minimal DOM helpers: the app has no UI framework.

import { es } from "../i18n/es";

type Attributes = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === "class") element.className = String(value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

/** Text as the settings search compares it: lower case, without accents. */
export function searchKey(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function button(label: string, onClick: () => void, variant: "primary" | "secondary" | "ghost" = "secondary"): HTMLButtonElement {
  const element = h("button", { class: `btn btn-${variant}`, type: "button" }, label);
  element.addEventListener("click", onClick);
  return element;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  /**
   * The new value, once the slider is let go (or moved with the keyboard):
   * redrawing the page while dragging would make the slider stutter.
   */
  onInput: (value: number) => void;
  /** Cheap updates while dragging (a small preview), if any. */
  live?: (value: number) => void;
  /** Value to go back to with the reset button (shown only when different). */
  defaultValue?: number;
  /** Extra words the settings search should find it by. */
  search?: string;
  /**
   * What people usually use. Beyond it the slider turns yellow for a short
   * stretch (`caution`, in the slider's units) and then red. It is only a
   * hint: every value still works.
   */
  usual?: [number, number];
  caution?: number;
}

export type SliderZone = "usual" | "caution" | "excess";

/** Where a value falls: usual, a little unusual (yellow) or excessive (red). */
export function sliderZone(value: number, usual: [number, number] | undefined, caution: number): SliderZone {
  if (!usual) return "usual";
  const [low, high] = usual;
  if (value >= low && value <= high) return "usual";
  const beyond = value < low ? low - value : value - high;
  return beyond <= caution + 1e-9 ? "caution" : "excess";
}

const ZONE_FILL: Record<SliderZone, string> = { usual: "#2a47a6", caution: "#d99a00", excess: "#c62828" };
const ZONE_TRACK: Record<SliderZone, string> = { usual: "#d6dbe4", caution: "#f3dc9a", excess: "#f2b8b5" };

export function slider(options: SliderOptions): { root: HTMLElement; set: (value: number) => void } {
  const output = h("span", { class: "slider-value" }, options.format(options.value));
  const input = h("input", {
    type: "range",
    min: options.min,
    max: options.max,
    step: options.step,
    value: options.value,
    "aria-label": options.label,
  });
  const reset = h("button", { type: "button", class: "reset-button", hidden: true }, "↺");
  const caution = options.caution ?? (options.max - options.min) * 0.08;
  const span = Math.max(1e-9, options.max - options.min);
  const at = (value: number) => (Math.max(0, Math.min(1, (value - options.min) / span)) * 100).toFixed(2);
  // The track shows where the unusual values start; the part up to the thumb takes the colour of its zone.
  const bands: { from: number; to: number; zone: SliderZone }[] = [];
  if (options.usual) {
    const [low, high] = options.usual;
    const cut = [options.min, low - caution, low, high, high + caution, options.max].map((v) => Math.max(options.min, Math.min(options.max, v)));
    const zones: SliderZone[] = ["excess", "caution", "usual", "caution", "excess"];
    zones.forEach((zone, i) => {
      if (cut[i + 1] > cut[i]) bands.push({ from: cut[i], to: cut[i + 1], zone });
    });
  } else bands.push({ from: options.min, to: options.max, zone: "usual" });
  const root = h("label", { class: "slider", "data-search": searchKey(`${options.label} ${options.search ?? ""}`) });
  const paint = (value: number) => {
    const zone = sliderZone(value, options.usual, caution);
    const stops = [`${ZONE_FILL[zone]} 0%`, `${ZONE_FILL[zone]} ${at(value)}%`];
    for (const band of bands) {
      if (band.to <= value) continue;
      const from = Math.max(band.from, value);
      stops.push(`${ZONE_TRACK[band.zone]} ${at(from)}%`, `${ZONE_TRACK[band.zone]} ${at(band.to)}%`);
    }
    input.style.setProperty("--track", `linear-gradient(to right, ${stops.join(", ")})`);
    input.style.setProperty("--thumb", ZONE_FILL[zone]);
    root.classList.toggle("zone-caution", zone === "caution");
    root.classList.toggle("zone-excess", zone === "excess");
    root.title = zone === "usual" ? "" : zone === "caution" ? es.panel.cautionValue : es.panel.excessValue;
  };
  const showReset = (value: number) => {
    if (options.defaultValue === undefined) return;
    reset.hidden = Math.abs(value - options.defaultValue) < options.step / 2;
  };
  const show = (value: number) => {
    output.textContent = options.format(value);
    showReset(value);
    paint(value);
  };
  if (options.defaultValue !== undefined) {
    const label = es.panel.resetValue(options.format(options.defaultValue));
    reset.title = label;
    reset.setAttribute("aria-label", label);
    reset.addEventListener("click", (event) => {
      event.preventDefault();
      input.value = String(options.defaultValue);
      show(options.defaultValue!);
      options.onInput(options.defaultValue!);
    });
  }
  input.addEventListener("input", () => {
    const value = Number(input.value);
    show(value);
    options.live?.(value);
  });
  input.addEventListener("change", () => options.onInput(Number(input.value)));
  root.append(h("span", { class: "slider-head" }, h("span", {}, options.label), h("span", { class: "slider-right" }, reset, output)), input);
  show(options.value);
  return {
    root,
    set(value: number) {
      input.value = String(value);
      show(value);
    },
  };
}

let toastTimer: number | undefined;

export function toast(message: string): void {
  let element = document.querySelector<HTMLElement>(".toast");
  if (!element) {
    element = h("div", { class: "toast", role: "status" });
    document.body.append(element);
  }
  element.textContent = message;
  element.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element?.classList.remove("visible"), 3200);
}

export const percent = (value: number): string => `${Math.round(value * 100)} %`;
