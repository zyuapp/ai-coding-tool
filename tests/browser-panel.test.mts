import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../src/application/workspace-reducer.ts";
import {
  browserTarget,
  dockFor,
  dockOwner,
  emptyWorkspaceState,
  type ThreadDock,
  type WorkspaceState,
} from "../src/application/workspace-state.ts";
import type { Task } from "../src/domain/task.js";

/** The dock a thread was left in: the one on screen unless a thread is named. */
function dock(state: WorkspaceState, owner?: string): ThreadDock {
  return dockFor(state, owner ?? dockOwner(state));
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

test("a run drives its own thread's dock, whichever thread the user is looking at", () => {
  const state = { ...workspace(), tasks: [task("task-1"), task("task-2", { executionPolicy: "autonomous" })], currentId: "task-1", history: ["task-1"], historyIndex: 0 };

  const opened = reduce(state, { type: "browser.open", taskId: "task-2", url: "https://two.example" });
  assert.deepEqual(dock(opened.state).browserTabs, [], "the dock on screen belongs to the thread the user is reading");
  const pageId = dock(opened.state, "task-2").browserTabs[0].id;
  assert.equal(dock(opened.state, "task-2").browserTabs[0].url, "https://two.example/");
  assert.equal(dock(opened.state, "task-2").open, false, "a run's page leaves its dock shut");
  assert.equal(dock(opened.state, "task-2").tab, "home", "and leaves it on the tab it was showing");
  assert.ok(!opened.effects.some((effect) => effect.type === "browser.show"), "a page nobody is looking at never claims the panel");

  const landed = reduce(opened.state, { type: "task.select", taskId: "task-2" });
  assert.equal(dock(landed.state).open, false, "landing on that thread finds the dock as the user left it");

  const shown = reduce(landed.state, { type: "browser.select-tab", tabId: pageId });
  assert.equal(dock(shown.state).tab, pageId, "asking for the page is what shows it");
  const effect = shown.effects.at(-1);
  assert.ok(effect);
  assert.equal(effect.type, "browser.show");
});

test("a run's page never takes the panel from the page the user is reading", () => {
  const state = { ...workspace(), tasks: [task("task-1", { executionPolicy: "autonomous" })], currentId: "task-1" };

  const mine = reduce(state, { type: "browser.open", url: "https://mine.example" });
  const myPage = dock(mine.state).browserTabs[0].id;
  assert.equal(dock(mine.state).open, true, "the user's own page opens the dock");

  const byRun = reduce(mine.state, { type: "browser.open", taskId: "task-1", url: "https://run.example", newTab: true });
  assert.equal(dock(byRun.state).tab, myPage, "the panel keeps drawing the page the user chose");
  assert.equal(dock(byRun.state).browserTabs.length, 2, "the run's page is still a tab to open");
  assert.ok(!byRun.effects.some((effect) => effect.type === "browser.show"));

  const read = browserTarget(dock(byRun.state), undefined);
  assert.ok(read);
  assert.equal(read.url, "https://run.example/", "a read that names no tab still finds the page the run just opened");
});
