// Options of the "Ver" menu. The page is the source of truth (saved with the
// other preferences); the menu only shows them as ticks and reports clicks.

import { bridge, loadPreference, savePreference } from "./bridge";

export interface ViewOptions {
  /** Letters of the word being typed keep changing drawing, like a cartoon. */
  typingAnimation: boolean;
  /** The preview imitates how an inkjet printer lays the ink on paper. */
  printedLook: boolean;
  /** The settings panel beside the sheet. */
  settingsPanel: boolean;
}

type Listener = (options: ViewOptions) => void;

let options: ViewOptions = {
  typingAnimation: loadPreference("view.typingAnimation", false),
  printedLook: loadPreference("view.printedLook", false),
  settingsPanel: loadPreference("view.settingsPanel", true),
};
const listeners = new Set<Listener>();

export function viewOptions(): ViewOptions {
  return options;
}

export function setViewOption<K extends keyof ViewOptions>(name: K, value: ViewOptions[K]): void {
  if (options[name] === value) return;
  options = { ...options, [name]: value };
  savePreference(`view.${name}`, value);
  bridge.setViewOption(name, value);
  for (const listener of listeners) listener(options);
}

export function onViewOptions(listener: Listener): void {
  listeners.add(listener);
}

/** Ticks the menu items and listens to them. */
export function connectViewMenu(): void {
  for (const [name, value] of Object.entries(options)) bridge.setViewOption(name, value);
  bridge.onViewOption((name, value) => {
    if (name === "typingAnimation" || name === "printedLook" || name === "settingsPanel") setViewOption(name, value);
  });
}
