import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ContextMenu, type MenuEntry } from "../../../src/renderer/components/PopoverMenu.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number });

/** jsdom measures nothing, so a menu is given a size to be placed against the window's edges. */
function sized(width: number, height: number) {
  const original = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function measured(this: Element) {
    return this.classList.contains("menu-popover")
      ? { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      : original.call(this);
  };
  return () => { dom.window.Element.prototype.getBoundingClientRect = original; };
}

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

function items(root: ParentNode, selector = ".context-menu-popover > button") {
  return [...root.querySelectorAll<HTMLButtonElement>(selector)];
}

afterAll(() => dom.window.close());

const ENTRIES: MenuEntry[] = [
  { label: "Rename" },
  { label: "Move to folder", items: [{ label: "No folder", checked: true }, { label: "api", checked: false }] },
  "separator",
  { label: "Copy link" },
  { label: "Archive", danger: true, shortcut: "⌫" },
];

test("a right-click menu draws its groups, its rules, and the keystrokes its items answer to", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));

  assert.deepEqual(items(document).map((button) => button.textContent), ["Rename", "Move to folder", "Copy link", "Archive⌫"]);
  assert.equal(document.querySelectorAll(".context-menu-popover > .menu-separator").length, 1);
  assert.equal(items(document)[1]!.getAttribute("aria-haspopup"), "menu");
  assert.equal(items(document)[3]!.className, "danger-menu-item");
  await view.unmount();
});

test("a menu opens without a highlighted row, then the arrow keys walk its items", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));
  const menu = document.querySelector<HTMLElement>(".context-menu-popover")!;
  const press = async (key: string) => { await act(async () => { menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); }); };

  assert.equal(document.activeElement, menu, "the menu is ready for the keyboard without selecting an item");
  await press("ArrowDown");
  assert.equal(document.activeElement?.textContent, "Rename");
  await press("ArrowDown");
  await press("ArrowDown");
  assert.equal(document.activeElement?.textContent, "Copy link", "the rule is not an item to stop on");
  await press("ArrowUp");
  assert.equal(document.activeElement?.textContent, "Move to folder");
  await view.unmount();
});

test("an item with a list of its own opens it under the pointer, and leaves the keyboard where it was", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));
  const menu = document.querySelector<HTMLElement>(".context-menu-popover")!;

  await act(async () => { items(document)[1]!.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })); });
  const submenu = document.querySelector<HTMLElement>(".menu-submenu")!;
  assert.deepEqual(items(submenu, "button").map((button) => button.textContent), ["No folder", "api"]);
  assert.equal(document.activeElement?.textContent, "Move to folder", "hovering it does not put the keyboard inside it");
  assert.equal(items(submenu, "button")[0]!.getAttribute("aria-checked"), "true", "the folder it is already in is ticked");
  assert.equal(submenu.classList.contains("menu-checkable"), true);
  assert.equal(menu.classList.contains("menu-checkable"), false, "only a list that has ticks makes room for them");
  await view.unmount();
});

test("ArrowRight opens an item's own list and ArrowLeft comes back out of it", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));
  const menu = document.querySelector<HTMLElement>(".context-menu-popover")!;
  const press = async (target: HTMLElement, key: string) => { await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); }); };

  await press(menu, "ArrowDown");
  await press(menu, "ArrowDown");
  await press(menu, "ArrowRight");
  assert.equal(document.activeElement?.textContent, "No folder", "the keyboard lands on the first item of the list it opened");

  await press(document.querySelector<HTMLElement>(".menu-submenu")!, "ArrowLeft");
  assert.equal(document.querySelector(".menu-submenu"), null);
  assert.equal(document.activeElement?.textContent, "Move to folder");
  await view.unmount();
});

test("a menu asked for near an edge is drawn back inside the window", async () => {
  const restore = sized(200, 120);
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: innerWidth - 40, y: innerHeight - 30 }, onClose() {} }));
  const menu = document.querySelector<HTMLElement>(".context-menu-popover")!;

  assert.equal(menu.style.left, `${innerWidth - 40 - 200}px`, "it opens to the left of the pointer instead");
  assert.equal(menu.style.top, `${innerHeight - 120 - 8}px`, "and it is lifted clear of the bottom");
  assert.equal(menu.style.visibility, "", "it is only shown once it has been placed");
  restore();
  await view.unmount();
});

test("choosing an item closes the menu before it acts", async () => {
  const order: string[] = [];
  const view = await mount(React.createElement(ContextMenu, {
    entries: [{ label: "Rename", onSelect: () => order.push("selected") }],
    at: { x: 10, y: 10 },
    onClose: () => order.push("closed"),
  }));

  await act(async () => { items(document)[0]!.click(); });
  assert.deepEqual(order, ["closed", "selected"]);
  await view.unmount();
});
