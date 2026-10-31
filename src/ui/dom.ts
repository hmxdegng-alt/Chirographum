// Minimal DOM helpers: the app has no UI framework in phase 0.

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
  input.addEventListener("input", () => {
    const value = Number(input.value);
    output.textContent = options.format(value);
    options.onInput(value);
  });
  const root = h("label", { class: "slider" }, h("span", { class: "slider-head" }, h("span", {}, options.label), output), input);
  return {
    root,
    set(value: number) {
      input.value = String(value);
      output.textContent = options.format(value);
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
