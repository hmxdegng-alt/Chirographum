// Shared application state with a tiny subscribe mechanism.

import { bridge, loadPreference, savePreference } from "./bridge";
import { createHand, serializeHand, type Hand } from "./engine/hand";
import { es } from "./i18n/es";

export interface AppState {
  hand: Hand;
  /** Test phrase whose characters the user draws. */
  phrase: string;
  /** Characters added from the sheet text that are not in the phrase. */
  extraChars: string[];
  variantsTarget: number;
  tab: "draw" | "sheet";
  /** A letter "Tu letra" should open on (set by "Dibujarlas ahora"). */
  drawFocus: string | null;
}

type Listener = (state: AppState, previous: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private autosaveTimer: number | undefined;

  constructor(initial: AppState) {
    this.state = initial;
  }

  get(): AppState {
    return this.state;
  }

  update(patch: Partial<AppState>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    if (patch.phrase !== undefined) savePreference("phrase", this.state.phrase);
    if (patch.extraChars !== undefined) savePreference("extraChars", this.state.extraChars);
    if (patch.variantsTarget !== undefined) savePreference("variantsTarget", this.state.variantsTarget);
    if (patch.hand !== undefined) this.scheduleAutosave();
    for (const listener of this.listeners) listener(this.state, previous);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      void bridge.autosaveHand(serializeHand(this.state.hand));
    }, 400);
  }
}

export function initialState(hand: Hand | null): AppState {
  return {
    hand: hand ?? createHand(es.hand.defaultName),
    phrase: loadPreference("phrase", es.draw.defaultPhrase),
    extraChars: loadPreference<string[]>("extraChars", []),
    variantsTarget: loadPreference("variantsTarget", 3),
    tab: "draw",
    drawFocus: null,
  };
}
