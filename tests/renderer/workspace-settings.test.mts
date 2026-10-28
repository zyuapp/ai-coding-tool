import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { Thread } from "../../src/domain/thread.ts";
import { openSettingsPage } from "../support/settings-panel.mts";
import { mount } from "../support/renderer-dom.mts";
import { settleUntil } from "../support/settle.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");

test("an archived thread names its project on the Archive page", async () => {
  const project = { id: "project-1", root: "/code/parser", workspaceId: "workspace-1" };
  const archived: Thread = {
    id: "task-1", title: "Old parser fix", projectId: project.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, archivedAt: Date.now(),
  };
  window.desktop = fakeDesktop({ loadTaskStore: async () => ({ version: 2, hiddenTasks: 0, projects: [project], worktrees: [], tasks: [archived], lastFolder: project.root }) });
  const view = await mount(React.createElement(App));
  await act(async () => {});
  await openSettingsPage(view, "Archived threads");
  await settleUntil(() => /Old parser fix/.test(view.container.textContent ?? ""), "archive row never showed");
  const row = [...view.container.querySelectorAll(".setting-row")].find((candidate) => /Old parser fix/.test(candidate.textContent ?? ""));
  assert.match(row?.textContent ?? "", /parser ·/);
  await view.unmount();
});
