import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { App } from "../../src/renderer/App.tsx";
import { mount } from "../support/renderer-dom.mts";
import type { LoadedTaskStore } from "../../src/contracts/task-store.ts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

test("the window draws an empty shell until the store has loaded, never an empty workspace", async () => {
  localStorage.clear();
  const project = { id: "project-1", root: "/repo", workspaceId: "workspace-1" };
  let load: (store: LoadedTaskStore) => void = () => undefined;
  const desktop = fakeDesktop({ loadTaskStore: () => new Promise<LoadedTaskStore>((resolve) => { load = resolve; }) });
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  await act(async () => {});
  const shell = view.container.querySelector("main.app-shell");
  assert.ok(shell);
  assert.equal(shell.childElementCount, 0);
  assert.doesNotMatch(view.container.textContent ?? "", /No chats|Choose a project folder/);

  await act(async () => {
    load({ version: 2, hiddenTasks: 0, projects: [project], worktrees: [], tasks: [], lastFolder: project.root });
  });
  await act(async () => {});
  assert.ok(view.container.querySelector("aside.sidebar"));
  assert.ok(view.container.querySelector(".composer textarea"));
  await view.unmount();
});
