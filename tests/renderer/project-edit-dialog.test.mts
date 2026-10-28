import assert from "node:assert/strict";
import { test } from "vitest";
import { act, createElement } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import type { ProjectEditorView } from "../../src/application/workspace-dialogs.ts";
const { ProjectEditDialog } = await import("../../src/renderer/components/ProjectEditDialog.tsx");
const { HostMark } = await import("../../src/renderer/components/HostMark.tsx");

const editor: ProjectEditorView = { project: { id: "p", root: "/work/api" }, checkouts: 0, saving: false, error: null };

async function dialog(openFolder: () => Promise<{ root: string } | null>) {
  Object.defineProperty(window, "desktop", { configurable: true, value: { openFolder } });
  const saved: Array<{ name: string | null; root: string }> = [];
  let closed = 0;
  const view = await mount(createElement(ProjectEditDialog, { editor, onSave: (edit) => saved.push(edit), onClose: () => { closed += 1; } }));
  return { ...view, saved, closed: () => closed };
}

const choose = () => [...document.querySelectorAll<HTMLButtonElement>(".project-edit-path button")][0]!;
const rootField = () => query<HTMLInputElement>(document.body, ".project-edit-path input");

test("a folder picker that fails says so in the dialog, and typing a path clears it", async () => {
  const view = await dialog(() => Promise.reject(new Error("Picker unavailable")));
  try {
    await act(async () => { choose().click(); });
    assert.equal(query(document.body, ".project-edit-error[role=alert]").textContent, "Picker unavailable");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      rootField().focus();
      setValue.call(rootField(), "/work/web");
      rootField().dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      rootField().dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true, key: "b" }));
    });
    assert.equal(document.querySelector(".project-edit-error"), null);
  } finally { await view.unmount(); }
});

test("a chosen folder fills the field and enables Save; a cancelled pick leaves both alone", async () => {
  let answer: { root: string } | null = null;
  const view = await dialog(() => Promise.resolve(answer));
  try {
    const save = query<HTMLButtonElement>(document.body, "button[type=submit]");
    await act(async () => { choose().click(); });
    assert.equal(rootField().value, "/work/api");
    assert.equal(save.disabled, true);
    answer = { root: "/work/web" };
    await act(async () => { choose().click(); });
    assert.equal(rootField().value, "/work/web");
    assert.equal(save.disabled, false);
    assert.equal(document.querySelector(".project-edit-error"), null);
  } finally { await view.unmount(); }
});

test("Escape closes the editor", async () => {
  const view = await dialog(() => Promise.resolve(null));
  try {
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    assert.equal(view.closed(), 1);
    assert.deepEqual(view.saved, []);
  } finally { await view.unmount(); }
});

test("a computer's mark names an offline or reconnecting state in its glyph and tip, and stays plain when connected", async () => {
  const view = await mount(createElement("div", null,
    createElement(HostMark, { name: "Studio" }),
    createElement(HostMark, { name: "Linux", offline: true }),
    createElement(HostMark, { name: "Laptop", offline: true, reconnecting: true }),
  ));
  try {
    const [online, offline, reconnecting] = [...view.container.querySelectorAll<HTMLElement>(".host-mark")];
    assert.equal(online!.dataset.tip, undefined);
    assert.equal(online!.classList.contains("offline"), false);
    assert.equal(query(online!, "svg").getAttribute("aria-hidden"), "true");
    assert.equal(offline!.dataset.tip, "Linux · Offline");
    assert.equal(query(offline!, "svg").getAttribute("aria-label"), "Offline");
    assert.equal(offline!.classList.contains("reconnecting"), false);
    assert.equal(reconnecting!.dataset.tip, "Laptop · Reconnecting");
    assert.equal(reconnecting!.classList.contains("reconnecting"), true);
  } finally { await view.unmount(); }
});
