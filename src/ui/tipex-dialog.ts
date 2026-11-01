// "Escribir debajo del Típex": what was written before the correction tape
// went over it. The text can be as long as the tape, measured in millimetres
// with the letters it will really be written with, not in characters.

import { MAX_TIPEX_UNDER } from "../engine/rich-text";
import { es } from "../i18n/es";
import { button, h } from "./dom";

export interface TipexDialogOptions {
  initial: string;
  /** Width of a text written under the tape, and the room the tape leaves, in millimetres. */
  measure(text: string): { widthMm: number; roomMm: number };
  /** The new text ("" = nothing under the tape). */
  onSave(text: string): void;
  onClose(): void;
}

export function openTipexDialog(options: TipexDialogOptions): void {
  const text = es.toolbar.tipexDialog;
  const input = h("input", { type: "text", class: "text-input tipex-input", maxlength: MAX_TIPEX_UNDER, placeholder: text.placeholder, spellcheck: "false" });
  input.value = options.initial;
  const fill = h("span", { class: "tipex-meter-fill" });
  const meter = h("span", { class: "tipex-meter", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const status = h("p", { class: "tipex-status" });
  let accepted = options.initial;
  let caret = accepted.length;

  const show = (full: boolean) => {
    const { widthMm, roomMm } = options.measure(accepted);
    const share = roomMm > 0 ? Math.min(1, widthMm / roomMm) : 1;
    fill.style.width = `${(share * 100).toFixed(1)}%`;
    meter.setAttribute("aria-valuenow", String(Math.round(share * 100)));
    meter.classList.toggle("near", share > 0.85);
    meter.classList.toggle("full", full);
    status.textContent = full ? text.full : text.room(widthMm.toFixed(0), roomMm.toFixed(0));
    status.classList.toggle("full", full);
  };

  // Whatever does not fit is refused, as the pen would run off the tape.
  input.addEventListener("input", () => {
    const value = input.value.replace(/[\r\n\t]+/g, " ");
    const { widthMm, roomMm } = options.measure(value);
    if (widthMm <= roomMm + 0.01) {
      accepted = value;
      if (input.value !== value) input.value = value;
      caret = input.selectionStart ?? value.length;
      show(false);
      return;
    }
    input.value = accepted;
    input.setSelectionRange(caret, caret);
    show(true);
  });
  input.addEventListener("keyup", () => (caret = input.selectionStart ?? accepted.length));
  input.addEventListener("click", () => (caret = input.selectionStart ?? accepted.length));

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    options.onClose();
  };
  const save = (value: string) => {
    options.onSave(value.trim());
    close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && document.activeElement === input) {
      event.preventDefault();
      save(accepted);
    }
  };
  document.addEventListener("keydown", onKey, true);

  const remove = button(text.remove, () => save(""), "ghost");
  remove.hidden = options.initial.trim() === "";
  const panel = h(
    "div",
    { class: "dialog tipex-dialog", role: "dialog", "aria-modal": "true", "aria-label": text.title },
    h("h2", {}, text.title),
    h("p", { class: "muted" }, text.help),
    input,
    meter,
    status,
    h("div", { class: "dialog-actions" }, remove, h("span", { class: "tool-spacer" }), button(text.cancel, close), button(text.save, () => save(accepted), "primary")),
  );
  const backdrop = h("div", { class: "dialog-backdrop" }, panel);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  document.body.append(backdrop);
  show(false);
  input.focus();
  input.select();
}
