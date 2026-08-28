import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThreadJump } from "../../../src/renderer/components/ThreadJump.tsx";
import type { JumpView } from "../../../src/application/workspace-jump.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number });
dom.window.Element.prototype.scrollIntoView = () => {};

afterAll(() => dom.window.close());

const JUMP: JumpView = {
  query: "pa",
  index: 1,
  options: [
    { id: "task-a", title: "Panel find", project: "api", engine: "claude", lastActivityAt: 2, running: true },
    { id: "task-b", title: "Dock the browser panel", project: null, engine: "codex", lastActivityAt: 1, running: false },
  ],
};

type Calls = { queries: string[]; steps: number[]; chosen: string[]; closed: number };

async function mount(jump: JumpView) {
  const calls: Calls = { queries: [], steps: [], chosen: [], closed: 0 };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ThreadJump, {
      jump,
      actions: {
        setJumpQuery: (query: string) => calls.queries.push(query),
        stepJump: (delta: -1 | 1) => calls.steps.push(delta),
        chooseJump: (taskId: string) => calls.chosen.push(taskId),
        closeJump: () => { calls.closed += 1; },
      },
    }));
  });
  return { calls, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

function rows() {
  return [...document.querySelectorAll<HTMLButtonElement>(".thread-jump-row")];
}

test("a row names its thread, the folder it lives in, and whether it is working", async () => {
  const view = await mount(JUMP);
  assert.deepEqual(rows().map((row) => row.textContent), ["Panel findapi", "Dock the browser panel"]);
  assert.equal(rows()[0]!.querySelector(".task-spinner")?.getAttribute("aria-label"), "Working");
  assert.equal(rows()[1]!.querySelector(".task-spinner"), null);
  assert.deepEqual(rows().map((row) => row.querySelector("svg")?.getAttribute("aria-label")), ["Claude thread", "Codex thread"]);
  assert.deepEqual(rows().map((row) => row.getAttribute("aria-selected")), ["false", "true"]);
  assert.equal(document.activeElement, document.querySelector(".thread-jump-search input"));
  await view.unmount();
});

test("the keyboard walks the rows, opens the picked thread, and closes the panel", async () => {
  const view = await mount(JUMP);
  const panel = document.querySelector<HTMLElement>(".thread-jump-panel")!;
  const press = async (key: string) => { await act(async () => { panel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); }); };

  await press("ArrowDown");
  await press("ArrowUp");
  assert.deepEqual(view.calls.steps, [1, -1]);

  await press("Enter");
  assert.deepEqual(view.calls.chosen, ["task-b"], "Enter opens the row the panel has picked");

  await press("Escape");
  assert.equal(view.calls.closed, 1);
  await view.unmount();
});

test("clicking a row opens that thread", async () => {
  const view = await mount(JUMP);
  await act(async () => { rows()[0]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(view.calls.chosen, ["task-a"]);
  await view.unmount();
});

test("a name nothing answers says so instead of drawing an empty list", async () => {
  const view = await mount({ query: "nothing", index: 0, options: [] });
  assert.equal(document.querySelector(".thread-jump-list"), null);
  assert.equal(document.querySelector(".thread-jump-empty")?.textContent, "No thread by that name");
  await view.unmount();
});
