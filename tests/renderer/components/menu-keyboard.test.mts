import { dom, mount } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import { ContextMenu, type MenuEntry } from "../../../src/renderer/components/PopoverMenu.tsx";

const ENTRIES: MenuEntry[] = [
  { label: "Rename" },
  { label: "Role", items: [{ label: "Coordinator" }, { label: "Reviewer" }] },
  { label: "Fork", panel: React.createElement("button", { type: "button", className: "fork-choice" }, "Into a worktree") },
  "separator",
  { label: "Copy link" },
  { label: "Remote only", disabled: true, title: "Not on this computer" },
  { label: "Archive", danger: true },
];

function row(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>(".context-menu-popover > button")].find((button) => button.querySelector(".menu-label")?.textContent === label)!;
}

async function press(target: Element, key: string) {
  await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
}

/** Long enough for the next letter to start a new search. */
async function pause() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); }); }

test("Home and End reach the ends of a menu, and typing a letter jumps to the row it starts", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));
  const menu = document.querySelector<HTMLElement>(".context-menu-popover")!;
  try {
    await press(menu, "End");
    assert.equal(document.activeElement, row("Archive"));
    await press(document.activeElement!, "Home");
    assert.equal(document.activeElement, row("Rename"));
    await press(document.activeElement!, "c");
    await press(document.activeElement!, "o");
    assert.equal(document.activeElement, row("Copy link"), "letters typed together spell one search");
    await pause();
    await press(document.activeElement!, "f");
    assert.equal(document.activeElement, row("Fork"));
    await pause();
    await press(document.activeElement!, "r");
    assert.equal(document.activeElement, row("Rename"), "a disabled row is skipped");
    await press(document.activeElement!, "r");
    assert.equal(document.activeElement, row("Role"), "the same letter again steps to the next row it starts");
  } finally { await view.unmount(); }
});

test("a disabled row names its reason in the shared tooltip", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));
  try {
    assert.equal(row("Remote only").dataset.tip, "Not on this computer");
    assert.equal(row("Remote only").hasAttribute("title"), false);
  } finally { await view.unmount(); }
});

test("an open submenu survives the pointer crossing a sibling on its way in", async () => {
  const view = await mount(React.createElement(ContextMenu, { entries: ENTRIES, at: { x: 20, y: 20 }, onClose() {} }));
  const enter = async (element: Element) => { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: null })); }); };
  const wait = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  try {
    await enter(row("Fork"));
    assert.ok(document.querySelector(".fork-choice"), "resting on an item opens its submenu");
    await enter(row("Copy link"));
    assert.ok(document.querySelector(".fork-choice"), "crossing a sibling does not close it at once");
    await enter(document.querySelector(".fork-choice")!);
    await wait(300);
    assert.ok(document.querySelector(".fork-choice"), "reaching the submenu keeps it");

    await enter(row("Copy link"));
    await wait(300);
    assert.equal(document.querySelector(".fork-choice"), null, "resting on the sibling hands over to it");
    assert.equal(document.activeElement, row("Copy link"));
  } finally { await view.unmount(); }
});
