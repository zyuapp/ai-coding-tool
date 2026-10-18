import assert from "node:assert/strict";
import { test } from "vitest";
import React from "react";

import { dom, mount, query } from "../support/renderer-dom.mts";

test("a comparison holding a mounted node fails naming each node in a line, never printing the tree", async () => {
  const view = await mount(React.createElement("div", null,
    React.createElement("button", { id: "save", className: "primary wide" }, "Save"),
    React.createElement("button", { "aria-label": "Close" }, "×")));
  const save = query<HTMLButtonElement>(view.container, "#save");
  const close = query<HTMLButtonElement>(view.container, '[aria-label="Close"]');

  assert.throws(() => assert.equal(dom.window.document.activeElement, save, "focus"), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.message, "focus");
    assert.equal(error.actual, "<body>");
    assert.equal(error.expected, "<button#save.primary.wide>");
    return true;
  });
  assert.throws(() => assert.deepEqual([save], [close]), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.deepEqual(error.expected, ['<button aria-label="Close">']);
    return true;
  });

  save.focus();
  assert.equal(dom.window.document.activeElement, save, "the same node still passes");
  assert.notEqual(save, close);
  assert.deepEqual([save, close], [save, close]);
  assert.equal(1 + 1, 2, "a comparison of plain values is node:assert's own");
  await view.unmount();
});
