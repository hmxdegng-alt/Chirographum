// The menu that opens with a right click on the page, like the one in Google
// Docs: an icon, the action and its keyboard shortcut; submenus open to the side.

import { h } from "./dom";

export interface MenuEntry {
  label: string;
  icon?: () => SVGSVGElement;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  submenu?: (MenuEntry | "separator")[];
}

let open: { root: HTMLElement; close: () => void } | null = null;

export function closeContextMenu(): void {
  open?.close();
}

/** Opens the menu at a point of the window (clientX, clientY). */
export function openContextMenu(x: number, y: number, entries: (MenuEntry | "separator")[]): void {
  closeContextMenu();
  const layers: HTMLElement[] = [];
  const close = () => {
    for (const layer of layers) layer.remove();
    layers.length = 0;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("scroll", close, true);
    open = null;
  };
  const outside = (event: PointerEvent) => {
    if (!layers.some((layer) => layer.contains(event.target as Node))) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  /** One level of the menu; `level` 0 is the main one, 1 a submenu. */
  const build = (items: (MenuEntry | "separator")[], level: number): HTMLElement => {
    const menu = h("div", { class: "context-menu", role: "menu" });
    let child: HTMLElement | null = null;
    const closeChild = () => {
      child?.remove();
      if (child) layers.splice(layers.indexOf(child), 1);
      child = null;
    };
    for (const item of items) {
      if (item === "separator") {
        menu.append(h("div", { class: "context-separator", role: "separator" }));
        continue;
      }
      const row = h(
        "button",
        { type: "button", class: `context-item${item.submenu ? " has-submenu" : ""}`, role: "menuitem", disabled: item.disabled },
        h("span", { class: "context-icon" }, item.icon ? item.icon() : ""),
        h("span", { class: "context-label" }, item.label),
        h("span", { class: "context-shortcut" }, item.submenu ? "▸" : (item.shortcut ?? "")),
      );
      // The page keeps the cursor and the selection.
      row.addEventListener("mousedown", (event) => event.preventDefault());
      if (item.submenu) {
        const show = () => {
          if (child) return;
          child = build(item.submenu!, level + 1);
          const box = row.getBoundingClientRect();
          place(child, box.right - 2, box.top - 6, box.left + 2);
        };
        row.addEventListener("pointerenter", show);
        row.addEventListener("click", show);
      } else {
        row.addEventListener("pointerenter", closeChild);
        row.addEventListener("click", () => {
          if (item.disabled) return;
          close();
          item.action?.();
        });
      }
      menu.append(row);
    }
    document.body.append(menu);
    layers.push(menu);
    return menu;
  };

  /** Keeps a menu inside the window: to the left of `left` (a submenu) or above the point if there is no room. */
  const place = (menu: HTMLElement, px: number, py: number, left?: number) => {
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let mx = px;
    if (mx + width > window.innerWidth - 4) mx = left !== undefined ? left - width : window.innerWidth - 4 - width;
    let my = py;
    if (my + height > window.innerHeight - 4) my = Math.max(4, window.innerHeight - 4 - height);
    menu.style.left = `${Math.max(4, mx)}px`;
    menu.style.top = `${my}px`;
  };

  const main = build(entries, 0);
  place(main, x, y);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  document.addEventListener("scroll", close, true);
  open = { root: main, close };
}
