import { seedProjectTasks } from "../support/sidebar.mts";
import { automationView, fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";
import { dom, item, mount, query, rowHeights } from "../support/renderer-dom.mts";
import { settleFrame, settleUntil } from "../support/settle.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");

test("a background run's tool call redraws only its own row, in both sidebar modes", async (t) => {
  const quietTimes = new Set([200_000, 300_000, 400_000]);
  seedProjectTasks([
    { id: "busy", title: "Busy task", sortIndex: 0, updatedAt: 2, createdAt: 2, projectId: undefined },
    { id: "quiet-1", title: "Quiet task", sortIndex: 1, updatedAt: 200_000, createdAt: 200_000, projectId: undefined },
    { id: "quiet-2", title: "Other quiet task", sortIndex: 2, updatedAt: 300_000, createdAt: 300_000, projectId: undefined },
    { id: "quiet-3", title: "Scheduled checkout task", sortIndex: 3, updatedAt: 400_000, createdAt: 400_000, worktreeId: "wt-1" },
  ]);
  const store = JSON.parse(localStorage.getItem("aicodingtool.store.v2")!) as Record<string, string>;
  const worktree = { id: "wt-1", projectId: "project-1", root: "/worktrees/project-wt1", workspaceId: "ws-wt1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({ ...store, worktrees: JSON.stringify({ version: 2, value: [worktree] }) }));
  const heights = rowHeights((element) => element.classList.contains("conversation") ? 900 : 0);
  t.onTestFinished(() => heights.restore());
  const desktop = fakeDesktop({ listAutomations: async () => [automationView({ taskId: "quiet-3" })] });
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const row = (title: string) => query<HTMLElement>(view.container, `.task-row[title="${title}"], .project-task-row[title="${title}"]`);

  await act(async () => { row("Busy task").click(); });
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "Inspect the app");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Send task"]').click(); });
  await settleUntil(() => desktop.sent.some((command) => command.type === "start"), "the run did not start");
  const start = desktop.sent.find((command): command is Extract<RunCommand, { type: "start" }> => command.type === "start")!;
  await act(async () => { row("Quiet task").click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, '.project-main[title="/project"]').click(); });
  await settleFrame();
  const checkoutRow = row("Scheduled checkout task");
  assert.ok(query(checkoutRow, ".task-worktree.worktree-mark") && query(checkoutRow, ".task-automation"), "the checkout row carries its worktree and schedule");

  const formatted: unknown[] = [];
  const originalFormat = item(Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format"));
  Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
    ...originalFormat,
    get(this: Intl.DateTimeFormat) {
      const format = item(originalFormat.get).call(this) as Intl.DateTimeFormat["format"];
      return (value?: number | Date) => { formatted.push(value); return format(value); };
    },
  });
  let sequence = 0;
  const toolCall = async () => {
    formatted.length = 0;
    sequence += 1;
    await act(async () => { desktop.listener({ type: "tool.intent", taskId: start.taskId, runId: start.runId, sequence, intent: { toolId: `tool-${sequence}`, name: "Read", input: { file_path: "src/App.tsx" } } }); });
    await settleFrame();
    assert.ok(formatted.length > 0, "the busy row is drawn again");
    assert.equal(formatted.some((value) => quietTimes.has(value as number)), false, "the quiet rows are left alone");
  };
  try {
    await toolCall();
    assert.ok(query(row("Busy task"), ".task-spinner"), "the busy row keeps its spinner");
    assert.ok(row("Quiet task").classList.contains("active"));

    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]').click(); });
    await settleFrame();
    await toolCall();
    assert.ok(query(row("Busy task"), ".task-spinner"), "the busy row keeps its spinner");

    await act(async () => { row("Other quiet task").click(); });
    assert.ok(row("Other quiet task").classList.contains("active"), "selection still moves the active row");
    assert.equal(row("Quiet task").classList.contains("active"), false);
    await act(async () => { row("Busy task").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
    assert.ok(document.querySelector(".context-menu-popover"), "the busy row still opens its menu");
  } finally {
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", originalFormat);
    await view.unmount();
  }
});
