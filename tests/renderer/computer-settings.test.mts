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
    links: [],
    pairing: null,
    onDiscover() {},
    onPair() {},
    onCancelPairing() {},
    onForget() {},
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
