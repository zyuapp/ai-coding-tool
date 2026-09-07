import { dom, mount as mountElement } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";

import React, { act } from "react";

import { ThreadJump } from "../../../src/renderer/components/ThreadJump.tsx";
import type { JumpView } from "../../../src/application/workspace-jump.ts";

const JUMP: JumpView = {
  query: "pa",
  index: 1,
  options: [
    { kind: "thread", id: "task-a", title: "Panel find", project: "api", engine: "claude", lastActivityAt: 2, running: true },
    { kind: "thread", id: "task-b", title: "Dock the browser panel", project: null, engine: "codex", lastActivityAt: 1, running: false },
    { kind: "setting", id: "settings:appearance", section: "appearance", settingId: null, title: "Appearance", page: null, keywords: "" },
    { kind: "setting", id: "settings:appearance.ui-font", section: "appearance", settingId: "appearance.ui-font", title: "Interface", page: "Appearance", keywords: "" },
  ],
};

type Calls = { queries: string[]; steps: number[]; chosen: string[]; settings: string[]; closed: number };

async function mount(jump: JumpView) {
  const calls: Calls = { queries: [], steps: [], chosen: [], settings: [], closed: 0 };
  const view = await mountElement(React.createElement(ThreadJump, {
      jump,
      actions: {
        setJumpQuery: (query: string) => calls.queries.push(query),
        stepJump: (delta: -1 | 1) => calls.steps.push(delta),
        chooseJump: (taskId: string) => calls.chosen.push(taskId),
        chooseJumpSetting: (section: string, settingId: string | null) => calls.settings.push(`${section}/${settingId ?? ""}`),
        closeJump: () => { calls.closed += 1; },
      },
  }));
  return { ...view, calls };
}

function rows() {
  return [...document.querySelectorAll<HTMLButtonElement>(".thread-jump-row")];
}

test("a row names its thread, the folder it lives in, and whether it is working", async () => {
  const view = await mount(JUMP);
  assert.deepEqual(rows().map((row) => row.textContent), ["Panel findapi", "Dock the browser panel", "Appearance", "InterfaceAppearance"]);
  assert.equal(rows()[0]!.querySelector(".task-spinner")?.getAttribute("aria-label"), "Working");
  assert.equal(rows()[1]!.querySelector(".task-spinner"), null);
  assert.deepEqual(rows().map((row) => row.querySelector("svg")?.getAttribute("aria-label")), ["Claude thread", "Codex thread", "Setting", "Setting"]);
  assert.deepEqual(rows().map((row) => row.getAttribute("aria-selected")), ["false", "true", "false", "false"]);
  assert.equal(document.querySelector(".thread-jump-heading")?.textContent, "Settings");
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

test("a settings row opens its page, and a control row names the control too", async () => {
  const view = await mount(JUMP);
  await act(async () => { rows()[2]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await act(async () => { rows()[3]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(view.calls.settings, ["appearance/", "appearance/appearance.ui-font"]);
  assert.deepEqual(view.calls.chosen, []);
  await view.unmount();
});

test("a name nothing answers says so instead of drawing an empty list", async () => {
  const view = await mount({ query: "nothing", index: 0, options: [] });
  assert.equal(document.querySelector(".thread-jump-list"), null);
  assert.equal(document.querySelector(".thread-jump-empty")?.textContent, "Nothing here is called that");
  await view.unmount();
});
