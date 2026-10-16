import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { ComputerSettings, type ComputerSettingsProps } from "../../src/renderer/components/ComputerSettings.tsx";
import { dom, mount } from "../support/renderer-dom.mts";

function settings(overrides: Partial<ComputerSettingsProps>) {
  return React.createElement(ComputerSettings, {
    found: [],
    searching: false,
    searchError: null,
    name: "zhuo-mac",
    links: [],
    pairing: null,
    onDiscover() {},
    onPair() {},
    onCancelPairing() {},
    onForget() {},
    onReconnect() {},
    onRename() {},
    onLabel() {},
    ...overrides,
  });
}

test("a computer the tailnet does not list is paired by its address, with the code it shows", async () => {
  const pairs: Array<[string, string, string]> = [];
  const view = await mount(settings({ onPair: (host, name, code) => pairs.push([host, name, code]) }));
  try {
    const address = view.container.querySelector<HTMLInputElement>(".computer-address input")!;
    assert.equal(view.container.querySelector<HTMLButtonElement>(".computer-address button")!.disabled, true);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(address, "127.0.0.1:7737");
      address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "127.0.0.1:7737" }));
      address.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(view.container.querySelector<HTMLButtonElement>(".computer-address button")!.disabled, false);
    await act(async () => { address.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.deepEqual(pairs, [["127.0.0.1:7737", "127.0.0.1:7737", ""]]);
  } finally {
    await view.unmount();
  }
  const asked = await mount(settings({ pairing: { host: "127.0.0.1:7737", name: "127.0.0.1:7737", busy: false, error: null } }));
  try {
    assert.match(asked.container.querySelector(".computer-code label span")!.textContent!, /127\.0\.0\.1:7737/);
  } finally {
    await asked.unmount();
  }
});

test("a computer that is not connected says whether it is being dialled and why it is down, and offers to reconnect", async () => {
  const reconnected: string[] = [];
  const links: ComputerSettingsProps["links"] = [
    { id: "up", name: "Up", host: "up.tail.ts.net", status: "connected", error: null, pairedAt: 1 },
    { id: "dialling", name: "Dialling", host: "dialling.tail.ts.net", status: "connecting", error: "That computer cannot be reached right now.", pairedAt: 1 },
    { id: "down", name: "Down", host: "down.tail.ts.net", status: "offline", error: null, pairedAt: 1 },
  ];
  const view = await mount(settings({ links, onReconnect: (id) => reconnected.push(id) }));
  try {
    const row = (id: string) => view.container.querySelector(`[data-computer="${id}"]`)!;
    const reconnect = (id: string) => [...row(id).querySelectorAll("button")].find((button) => button.textContent === "Reconnect");
    const status = (id: string) => [...row(id).querySelectorAll(".computer-status span")].map((part) => part.textContent).join(" · ");
    assert.equal(status("up"), "Connected");
    assert.equal(status("dialling"), "Reconnecting… · That computer cannot be reached right now.");
    assert.equal(status("down"), "Offline");
    assert.equal(row("up").querySelector("strong")!.dataset.tip, "up.tail.ts.net", "the address is a hover away");
    assert.equal(reconnect("up"), undefined);
    await act(async () => { reconnect("dialling")!.click(); });
    await act(async () => { reconnect("down")!.click(); });
    assert.deepEqual(reconnected, ["dialling", "down"]);
  } finally {
    await view.unmount();
  }
});

test("a paired computer's row reads as one line and runs its one step", async () => {
  const commands: unknown[] = [];
  const view = await mount(settings({
    links: [{ id: "mac", name: "MacBook", host: "mac.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
    upkeep: [{
      id: "mac",
      parts: [{ text: "Connected", tone: "live" }, { text: "v0.7.10" }, { text: "0.7.11 available" }],
      action: { label: "Update", command: { type: "app.update", computerId: "mac" } },
    }],
    onCommand: (command) => commands.push(command),
  }));
  try {
    const row = view.container.querySelector("[data-computer='mac']")!;
    assert.deepEqual([...row.querySelectorAll(".computer-status span")].map((part) => part.textContent), ["Connected", "v0.7.10", "0.7.11 available"]);
    assert.equal(row.querySelector(".computer-status .live")!.textContent, "Connected");
    await act(async () => { row.querySelector<HTMLButtonElement>("button.primary")!.click(); });
    assert.deepEqual(commands, [{ type: "app.update", computerId: "mac" }]);
    assert.ok(row.querySelector("button[aria-label='Rename MacBook']") && row.querySelector("button[aria-label='Remove MacBook']"));
  } finally {
    await view.unmount();
  }
});
