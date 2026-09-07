import { dom, mount as mountElement } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach, vi } from "vitest";

import React, { act } from "react";

const { TooltipLayer } = await import("../../../src/renderer/components/TooltipLayer.tsx");

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());
const DELAY_MS = 400;

async function rest(ms = DELAY_MS + 20) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function mount() {
  return mountElement(React.createElement(React.Fragment, null,
      React.createElement("button", { type: "button", "data-tip": "Read the comparison again" },
        React.createElement("span", { className: "icon" }, "↻")),
      React.createElement("button", { type: "button", id: "plain" }, "plain"),
      React.createElement(TooltipLayer),
  ));
}

function tooltip() {
  return document.querySelector(".tooltip");
}

function hover(element: Element) {
  element.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
}

describe("The one tooltip", () => {

test("resting on a control says what it does, and moving off takes it away", async () => {
  const view = await mount();
  const tipped = view.container.querySelector("button")!;

  /** The pointer lands on the icon inside the button, which is what a real pointer does. */
  hover(tipped.querySelector(".icon")!);
  assert.equal(tooltip(), null, "nothing appears while the pointer is still moving");

  await rest();
  assert.equal(tooltip()?.textContent, "Read the comparison again");
  assert.equal(tooltip()?.getAttribute("role"), "tooltip");

  hover(view.container.querySelector("#plain")!);
  await act(async () => {});
  assert.equal(tooltip(), null);
  await view.unmount();
});

test("typing takes the tooltip away", async () => {
  const view = await mount();
  hover(view.container.querySelector("button")!);
  await rest();
  assert.ok(tooltip());

  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(tooltip(), null);
  await view.unmount();
});

test("a control with nothing to say says nothing", async () => {
  const view = await mount();
  hover(view.container.querySelector("#plain")!);
  await rest();

  assert.equal(tooltip(), null);
  await view.unmount();
});

});
