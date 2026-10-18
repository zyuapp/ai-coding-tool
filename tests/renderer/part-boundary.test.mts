import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";

const { PartBoundary } = await import("../../src/renderer/components/PartBoundary.tsx");

let broken = true;
function Fragile() {
  if (broken) throw new Error("Unknown model");
  return React.createElement("div", { className: "drawn" }, React.createElement("button", { type: "button" }, "First control"));
}

test("a part that fails to draw says so in its place and tries again, leaving the rest of the window drawn", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  broken = true;
  const view = await mount(React.createElement("div", null,
    React.createElement(PartBoundary, { name: "sidebar", className: "sidebar" }, React.createElement(Fragile)),
    React.createElement("p", { className: "rest" }, "The rest")));
  const fallback = query(view.container, ".sidebar > .part-fallback");
  assert.equal(fallback.textContent, "This part couldn’t be shown.Try again", "the part's own box holds it, so its place in the layout is kept");
  assert.equal(query(view.container, ".rest").textContent, "The rest");
  assert.ok(logged.mock.calls.some(([message]) => String(message).includes("The sidebar could not be shown.")), "the failure is logged");

  broken = false;
  await act(async () => { const retry = query<HTMLButtonElement>(fallback, "button"); retry.focus(); retry.click(); });
  assert.equal(query(view.container, ".drawn").textContent, "First control");
  assert.equal(dom.window.document.activeElement?.textContent, "First control", "a retry that draws hands the keyboard to the part");
  logged.mockRestore();
  await view.unmount();
});

test("a part that failed on one thread draws again for the next", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  broken = true;
  const part = (resetKey: string) => React.createElement(PartBoundary, { name: "conversation", className: "work-area", resetKey }, React.createElement(Fragile));
  const view = await mount(part("t1"));
  assert.ok(view.container.querySelector(".part-fallback"));
  broken = false;
  await view.render(part("t1"));
  assert.ok(view.container.querySelector(".part-fallback"), "the same thread keeps its notice until Try again");
  await view.render(part("t2"));
  assert.equal(view.container.querySelector(".part-fallback"), null);
  assert.equal(query(view.container, ".drawn").textContent, "First control");
  logged.mockRestore();
  await view.unmount();
});
