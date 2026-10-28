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

test("a paired computer's row lists its software in one column of steps", async () => {
  const commands: unknown[] = [];
  const view = await mount(settings({
    links: [{ id: "mac", name: "MacBook", host: "mac.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
    upkeep: [{
      id: "mac",
      status: [{ text: "Connected", tone: "live" }],
      action: null,
      items: [
        { key: "app", label: "AI Coding Tool", version: "0.7.10", state: { text: "0.7.11 available", tone: "offer" }, action: { label: "Update", command: { type: "app.update", computerId: "mac" } } },
        { key: "claude", label: "Claude", version: "2.1.301", state: { text: "Up to date", tone: "quiet" }, action: null },
        { key: "codex", label: "Codex", version: "0.160.0", state: { text: "Needs 0.162.1 to run", tone: "error" }, action: { label: "Update", command: { type: "engine.update", engine: "codex", computerId: "mac" } } },
      ],
    }],
    onCommand: (command) => commands.push(command),
  }));
  try {
    const row = view.container.querySelector("[data-computer='mac']")!;
    assert.equal(row.querySelector(".computer-status")!.textContent, "Connected");
    assert.deepEqual([...row.querySelectorAll("[data-software]")].map((line) => line.textContent), ["AI Coding Tool0.7.100.7.11 availableUpdate", "Claude2.1.301Up to date", "Codex0.160.0Needs 0.162.1 to runUpdate"]);
    assert.equal(row.querySelector("[data-software='claude'] button"), null, "nothing to do, nothing to press");
    assert.ok(row.querySelector("[data-software='codex'] button.primary"), "the update that unblocks runs stands out");
    assert.equal(row.querySelector("[data-software='app'] button.primary"), null);
    await act(async () => { row.querySelector<HTMLButtonElement>("[data-software='codex'] button")!.click(); });
    await act(async () => { row.querySelector<HTMLButtonElement>("[data-software='app'] button")!.click(); });
    assert.deepEqual(commands, [{ type: "engine.update", engine: "codex", computerId: "mac" }, { type: "app.update", computerId: "mac" }]);
    assert.ok(row.querySelector("button[aria-label='Rename MacBook']") && row.querySelector("button[aria-label='Remove MacBook']"));
  } finally {
    await view.unmount();
  }
});

test("removing a paired computer asks once more before it forgets it", async () => {
  const forgotten: string[] = [];
  const view = await mount(settings({
    links: [{ id: "mac", name: "MacBook", host: "mac.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
    onForget: (id) => forgotten.push(id),
  }));
  try {
    const row = view.container.querySelector("[data-computer='mac']")!;
    await act(async () => { row.querySelector<HTMLButtonElement>("button[aria-label='Remove MacBook']")!.click(); });
    assert.deepEqual(forgotten, []);
    assert.equal(dom.window.document.activeElement?.textContent, "Cancel");
    await act(async () => { row.querySelector<HTMLButtonElement>("button.danger")!.click(); });
    assert.deepEqual(forgotten, ["mac"]);
  } finally {
    await view.unmount();
  }
});

test("this computer's name says it was saved, and an unchanged name saves nothing", async () => {
  const renamed: string[] = [];
  const view = await mount(settings({ onRename: (name) => renamed.push(name) }));
  try {
    const field = view.container.querySelector<HTMLInputElement>(".computer-name input")!;
    assert.equal(view.container.querySelector(".computer-name label strong")!.textContent, "This computer's name");
    const saved = () => view.container.querySelector(".computer-name-saved")!.textContent;
    await act(async () => { field.focus(); field.blur(); });
    assert.deepEqual(renamed, []);
    assert.equal(saved(), "");
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      field.focus();
      setter.call(field, "studio");
      field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    });
    await act(async () => { field.blur(); });
    assert.deepEqual(renamed, ["studio"]);
    assert.equal(saved(), "Saved");
  } finally {
    await view.unmount();
  }
});

test("the address field reads as the only way to pair until the tailnet lists a computer", async () => {
  const label = (view: Awaited<ReturnType<typeof mount>>) => view.container.querySelector(".computer-address label span")!.textContent;
  const alone = await mount(settings({}));
  try {
    assert.equal(label(alone), "Pair by address");
    assert.equal(alone.container.querySelector("[data-this-computer] .setting-status"), null, "this computer's name row carries no step circle");
  } finally {
    await alone.unmount();
  }
  const listed = await mount(settings({ found: [{ host: "studio:7737", name: "studio" } as ComputerSettingsProps["found"][number]] }));
  try {
    assert.equal(label(listed), "Or pair by address");
  } finally {
    await listed.unmount();
  }
});

test("looking for computers reads as busy rather than unavailable", async () => {
  const view = await mount(settings({ searching: true }));
  try {
    const look = view.container.querySelector<HTMLButtonElement>(".settings-group-action button")!;
    assert.equal(look.textContent, "Looking…");
    assert.equal(look.getAttribute("aria-busy"), "true");
  } finally {
    await view.unmount();
  }
});
