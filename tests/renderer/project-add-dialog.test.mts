import assert from "node:assert/strict";
import { test } from "vitest";
import { act, createElement, useReducer } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
const { ProjectAddDialog } = await import("../../src/renderer/components/ProjectAddDialog.tsx");

const links: ComputerLink[] = [
  { id: "linux", name: "zyuapp", host: "linux", status: "connected", error: null, pairedAt: 1 },
  { id: "old", name: "Old laptop", host: "old", status: "offline", error: "Connection refused", pairedAt: 1 },
];

async function dialog(filter = "linux") {
  let state = emptyWorkspaceState();
  state.computers = { ...state.computers, name: "Mac", filter, paired: links.map((link) => ({ ...link, state: null })) };
  state = reduce(state, { type: "project.open" }).state;
  const commands: WorkspaceInput[] = [];
  let send: (input: WorkspaceInput) => void = () => {};
  function Harness() {
    const [current, dispatch] = useReducer((held: typeof state, input: WorkspaceInput) => reduce(held, input).state, state);
    state = current;
    send = (input) => { commands.push(input); dispatch(input); };
    return current.projectAdd ? createElement(ProjectAddDialog, { add: current.projectAdd, name: "Mac", links, dispatch: send }) : null;
  }
  const view = await mount(createElement(Harness));
  for (const node of document.querySelectorAll("select, input, button")) Object.defineProperty(node, "offsetParent", { configurable: true, get: () => document.body });
  return { ...view, commands, state: () => state, send: async (input: WorkspaceInput) => { await act(async () => send(input)); } };
}

async function key(name: string) {
  await act(async () => { const input = query(document.body, "input"); input.focus(); input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
}

test("the dialog names the chosen host, only offers reachable devices, and dispatches folder picking locally", async () => {
  const view = await dialog();
  try {
    assert.equal(query(document.body, "h2").textContent, "Add project on zyuapp");
    const select = query<HTMLSelectElement>(document.body, "select");
    assert.deepEqual([...select.options].map((option) => option.text), ["This computer (Mac)", "zyuapp"]);
    assert.equal(document.body.textContent?.includes("Choose folder…"), false);
    await act(async () => { select.value = "this"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(query(document.body, "h2").textContent, "Add project on Mac");
    await act(async () => query(document.body, ".project-edit-path button").click());
    assert.equal(view.commands.at(-1)?.type, "view.add-project-pick");
    await view.send({ type: "project.path-picked", request: view.state().projectAdd!.request, root: "/chosen" });
    assert.equal(query<HTMLInputElement>(document.body, "input").value, "/chosen");
    assert.equal(view.state().projects.length, 0);
  } finally { await view.unmount(); }
});

test("arrows navigate, Tab and Enter accept directories, Escape dismisses suggestions before the dialog", async () => {
  const view = await dialog();
  try {
    await view.send({ type: "view.add-project-path", root: "/wo" });
    await view.send({ type: "project.directories", request: view.state().projectAdd!.request, directories: ["/work/", "/world/"] });
    await key("ArrowDown");
    assert.equal(query(document.body, "[aria-selected='true']").textContent, "/work/");
    await key("ArrowDown");
    await key("Tab");
    assert.equal(query<HTMLInputElement>(document.body, "input").value, "/world/");
    assert.equal(document.body.querySelector("[role='listbox']"), null);
    assert.equal(view.state().projectAdd?.saving, false);
    await view.send({ type: "project.directories", request: view.state().projectAdd!.request, directories: ["/world/app/"] });
    await key("Enter");
    assert.equal(query<HTMLInputElement>(document.body, "input").value, "/world/app/");
    await view.send({ type: "project.directories", request: view.state().projectAdd!.request, directories: ["/world/app/src/"] });
    await key("Escape");
    assert.ok(document.body.querySelector("[role='dialog']"));
    assert.equal(document.body.querySelector("[role='listbox']"), null);
    await key("Escape");
    assert.equal(document.body.querySelector("[role='dialog']"), null);
  } finally { await view.unmount(); }
});

test("submission waits in the dialog and displays registration errors inline", async () => {
  const view = await dialog();
  try {
    await view.send({ type: "view.add-project-path", root: "/missing" });
    await act(async () => query(document.body, "form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(query<HTMLButtonElement>(document.body, "button[type='submit']").disabled, true);
    assert.equal(query<HTMLSelectElement>(document.body, "select").disabled, true);
    await view.send({ type: "project.add-finished", request: view.state().projectAdd!.request, error: "There is no folder at /missing." });
    assert.equal(query(document.body, "[role='alert']").textContent, "There is no folder at /missing.");
    assert.equal(query<HTMLButtonElement>(document.body, "button[type='submit']").disabled, false);
  } finally { await view.unmount(); }
});

test("an offline filtered computer remains explicit and cannot submit a path locally", async () => {
  const view = await dialog("old");
  try {
    assert.equal(query(document.body, "h2").textContent, "Add project on Old laptop");
    assert.equal(query(document.body, "[role='alert']").textContent, "Connection refused");
    assert.equal(query<HTMLButtonElement>(document.body, "button[type='submit']").disabled, true);
    assert.equal(query<HTMLSelectElement>(document.body, "select").value, "old");
  } finally { await view.unmount(); }
});
