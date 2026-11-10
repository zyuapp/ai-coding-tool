import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import React, { act, useState } from "react";
import { mount, pumpResizeObservers } from "../support/renderer-dom.mts";
import { useFloatingSidebar } from "../../src/renderer/floating-sidebar.ts";

let toggle: (open: boolean) => void = () => {};
function Shell() {
  const [open, setOpen] = useState(true);
  toggle = setOpen;
  useFloatingSidebar(open, setOpen, false);
  return React.createElement("aside", { "data-open": String(open) });
}

async function floats(on: boolean) {
  document.documentElement.style.setProperty("--sidebar-floats", on ? "1" : "0");
  await pumpResizeObservers();
}

afterEach(() => { document.documentElement.style.removeProperty("--sidebar-floats"); document.body.replaceChildren(); });

test("a sidebar folds away when it starts to float, returns with the room, and one opened while floating is left alone", async () => {
  const view = await mount(React.createElement(Shell));
  const open = () => view.container.querySelector("aside")!.dataset.open;
  await pumpResizeObservers();

  await floats(true);
  assert.equal(open(), "false");
  await floats(false);
  assert.equal(open(), "true");

  await floats(true);
  await act(async () => { toggle(true); });
  await act(async () => { toggle(false); });
  await floats(false);
  assert.equal(open(), "false");
  await view.unmount();
});
