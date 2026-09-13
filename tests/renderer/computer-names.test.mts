import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { ComputerSettings, type ComputerSettingsProps } from "../../src/renderer/components/ComputerSettings.tsx";
import { dom, mount, query } from "../support/renderer-dom.mts";

function settings(overrides: Partial<ComputerSettingsProps>) {
  return React.createElement(ComputerSettings, {
    found: [],
    searching: false,
    searchError: null,
    name: "zhuo-mac",
    links: [{ id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
    pairing: null,
    onDiscover() {},
    onPair() {},
    onCancelPairing() {},
    onForget() {},
    onRename() {},
    onLabel() {},
    ...overrides,
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
}

test("this computer's name is a field that gives what was typed once it is left, and takes the host's answer back", async () => {
  const renames: string[] = [];
  const view = await mount(settings({ onRename: (name) => renames.push(name) }));
  try {
    const field = query<HTMLInputElement>(view.container, "[data-this-computer] .computer-name input");
    assert.equal(field.value, "zhuo-mac");
    await type(field, " Studio ");
    await act(async () => { field.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
    assert.deepEqual(renames, ["Studio"]);
    await type(field, "zhuo-mac");
    await act(async () => { field.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.deepEqual(renames, ["Studio"], "the name it already has is not given again");
    await type(field, "");
    await act(async () => { field.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
    assert.deepEqual(renames, ["Studio", ""], "an empty name asks for the machine's own");
    assert.equal(field.value, "zhuo-mac", "the field never sits empty");
  } finally {
    await view.unmount();
  }
});

test("a paired computer is renamed in its row, and Escape leaves it as it was", async () => {
  const labels: Array<[string, string]> = [];
  const view = await mount(settings({ onLabel: (id, name) => labels.push([id, name]) }));
  try {
    const row = query(view.container, "[data-computer='linux']");
    assert.equal(query(row, "strong").textContent, "linux-box");
    const rename = [...row.querySelectorAll("button")].find((button) => button.textContent === "Rename")!;
    await act(async () => { rename.click(); });
    const input = query<HTMLInputElement>(row, ".computer-rename");
    assert.equal(input.value, "linux-box");
    await type(input, "Build box");
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(labels, [["linux", "Build box"]]);
    assert.equal(row.querySelector(".computer-rename"), null, "the row is a row again");

    await act(async () => { query(row, "strong").dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
    const again = query<HTMLInputElement>(row, ".computer-rename");
    await act(async () => { again.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.deepEqual(labels, [["linux", "Build box"]]);
    assert.equal(row.querySelector(".computer-rename"), null);
  } finally {
    await view.unmount();
  }
});
