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
  onInput: (value: number) => void;
  /** Value to go back to with the reset button (shown only when different). */
  defaultValue?: number;
  /** Extra words the settings search should find it by. */
  search?: string;
}

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
  const showReset = (value: number) => {
    if (options.defaultValue === undefined) return;
    reset.hidden = Math.abs(value - options.defaultValue) < options.step / 2;
  };
  if (options.defaultValue !== undefined) {
    const label = es.panel.resetValue(options.format(options.defaultValue));
    reset.title = label;
    reset.setAttribute("aria-label", label);
    reset.addEventListener("click", (event) => {
      event.preventDefault();
      input.value = String(options.defaultValue);
      output.textContent = options.format(options.defaultValue!);
      showReset(options.defaultValue!);
      options.onInput(options.defaultValue!);
    });
  }
  input.addEventListener("input", () => {
    const value = Number(input.value);
    output.textContent = options.format(value);
    showReset(value);
    options.onInput(value);
  });
  showReset(options.value);
  const root = h(
    "label",
    { class: "slider", "data-search": searchKey(`${options.label} ${options.search ?? ""}`) },
    h("span", { class: "slider-head" }, h("span", {}, options.label), h("span", { class: "slider-right" }, reset, output)),
    input,
  );
  return {
    root,
    set(value: number) {
      input.value = String(value);
      output.textContent = options.format(value);
      showReset(value);
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
