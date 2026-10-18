import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";

const { PartBoundary } = await import("../../src/renderer/components/PartBoundary.tsx");

test("a part that fails to draw says so in its place and tries again, leaving the rest of the window drawn", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  let broken = true;
  function Fragile() {
    if (broken) throw new Error("Unknown model");
    return React.createElement("p", { className: "drawn" }, "Drawn");
  }
  const view = await mount(React.createElement("div", null,
    React.createElement(PartBoundary, { name: "sidebar", className: "sidebar" }, React.createElement(Fragile)),
    React.createElement("p", { className: "rest" }, "The rest")));
  const fallback = query(view.container, ".part-fallback.sidebar");
  assert.equal(fallback.textContent, "This part couldn’t be shown.Try again");
  assert.equal(query(view.container, ".rest").textContent, "The rest");
  assert.ok(logged.mock.calls.some(([message]) => String(message).includes("The sidebar could not be shown.")), "the failure is logged");

  broken = false;
  await act(async () => { query<HTMLButtonElement>(fallback, "button").click(); });
  assert.equal(query(view.container, ".drawn").textContent, "Drawn");
  logged.mockRestore();
  await view.unmount();
});
