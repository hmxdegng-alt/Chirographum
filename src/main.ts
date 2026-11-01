import logoUrl from "../assets/logo.png";
import { bridge } from "./bridge";
import { parseHand, type Hand } from "./engine/hand";
import { es } from "./i18n/es";
import { initialState, Store } from "./store";
import { h } from "./ui/dom";
import { createDocumentController } from "./ui/document-controller";
import { createDrawView } from "./ui/draw-view";
import { createSheetView } from "./ui/sheet-view";
import { connectViewMenu } from "./view-options";
import "./styles.css";

async function loadAutosavedHand(): Promise<Hand | null> {
  try {
    const text = await bridge.loadAutosavedHand();
    return text ? parseHand(text) : null;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  connectViewMenu();
  const store = new Store(initialState(await loadAutosavedHand()));
  const drawView = createDrawView(store);
  const sheetView = createSheetView(store);

  const tabButton = (tab: "draw" | "sheet", label: string) => {
    const element = h("button", { type: "button", class: "tab", role: "tab" }, label);
    element.addEventListener("click", () => store.update({ tab }));
    return element;
  };
  const drawTab = tabButton("draw", es.tabs.draw);
  const sheetTab = tabButton("sheet", es.tabs.sheet);

  const docLabel = h("div", { class: "doc-label" });
  const topbar = h(
    "header",
    { class: "topbar" },
    h("img", { class: "logo", src: logoUrl, alt: "" }),
    h("div", { class: "brand" }, h("span", { class: "brand-name" }, es.appName), h("span", { class: "brand-phase" }, es.phaseLabel)),
    h("nav", { class: "tabs", role: "tablist" }, drawTab, sheetTab),
    docLabel,
  );

  const content = h("main", { class: "content" }, drawView.root, sheetView.root);
  document.getElementById("app")!.replaceChildren(topbar, content);

  const showTab = (tab: "draw" | "sheet") => {
    drawView.root.hidden = tab !== "draw";
    sheetView.root.hidden = tab !== "sheet";
    drawTab.classList.toggle("active", tab === "draw");
    sheetTab.classList.toggle("active", tab === "sheet");
    drawTab.setAttribute("aria-selected", String(tab === "draw"));
    sheetTab.setAttribute("aria-selected", String(tab === "sheet"));
    (tab === "draw" ? drawView : sheetView).onShow();
  };

  store.subscribe((state, previous) => {
    if (state.tab !== previous.tab) showTab(state.tab);
  });
  showTab(store.get().tab);
  createDocumentController(sheetView.document, store, docLabel);
}

void start();
