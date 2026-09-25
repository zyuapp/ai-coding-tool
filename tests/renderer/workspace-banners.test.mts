import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { App } from "../../src/renderer/App.tsx";
import { mount, query } from "../support/renderer-dom.mts";

test("an error and a notice under the header take a row each, so neither is drawn over the other", async () => {
  localStorage.clear();
  const project = { id: "project-1", root: "/repo", workspaceId: "workspace-1" };
  const desktop = fakeDesktop({
    loadTaskStore: async () => ({ version: 2, hiddenTasks: 1, projects: [project], worktrees: [], tasks: [], lastFolder: project.root }),
  });
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  await act(async () => {});
  await act(async () => {
    desktop.refuseShortcut({ binding: "Alt+Shift+S", reason: "taken" });
  });
  const banners = query(view.container, ".workspace-banners");
  const rows = [...banners.children].map((child) => child.className);
  assert.deepEqual(rows, ["storage-error", "storage-notice"]);
  assert.match(query(banners, ".storage-error").textContent, /belongs to another app/);
  assert.match(query(banners, ".storage-notice").textContent, /1 thread needs a newer version/);
  await view.unmount();
});
