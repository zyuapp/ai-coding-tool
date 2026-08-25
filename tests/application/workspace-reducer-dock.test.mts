import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, dockFor, dockOwner } from "../../src/application/workspace-state.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import { dock, task, workspace, preferences, required, run, running } from "./workspace-reducer-fixtures.mts";

test("every thread keeps a dock of its own, panels, pages and shells alike", () => {
  const state = { ...workspace(), lastFolder: "/repo", tasks: [task("task-1"), task("task-2")], currentId: "task-1", history: ["task-1"], historyIndex: 0 };

  const opened = run(state, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "browser.open", url: "https://one.example" },
    { type: "terminal.open" },
  ]);
  const [page] = dock(opened).browserTabs;
  const [shell] = dock(opened).terminals;
  assert.deepEqual(dock(opened).panels, ["agents"], "only a panel there is one of is a panel");
  assert.equal(dock(opened).tab, shell.id);
  assert.equal(dock(opened).open, true);

  const switched = reduce(opened, { type: "task.select", taskId: "task-2" });
  assert.deepEqual(dock(switched.state).panels, [], "the thread the user lands on opens its own dock, which is empty");
  assert.deepEqual(dock(switched.state).browserTabs, []);
  assert.deepEqual(dock(switched.state).terminals, []);
  assert.deepEqual(switched.effects.at(-2), { type: "browser.show", tabId: null }, "and the panel stops drawing the page it was showing");
  assert.deepEqual(switched.effects.at(-1), { type: "focus-window" }, "the page it was drawing does not keep the keys");
  const away = reduce({ ...opened, focused: false }, { type: "task.select", taskId: "task-2" });
  assert.equal(away.effects.some((effect) => effect.type === "focus-window"), false, "a window the user has left is not pulled back");

  const back = reduce(switched.state, { type: "task.select", taskId: "task-1" });
  assert.deepEqual(dock(back.state).panels, ["agents"], "the dock a thread was left in comes back as it was");
  assert.deepEqual(dock(back.state).browserTabs.map((tab) => tab.id), [page.id]);
  assert.deepEqual(dock(back.state).terminals.map((terminal) => terminal.id), [shell.id]);
  assert.equal(dock(back.state).tab, shell.id, "and the one in front keeps showing");

  const closed = reduce(back.state, { type: "terminal.close", terminalId: shell.id });
  assert.equal(dock(closed.state).tab, page.id, "closing a tab hands the dock its neighbour");

  const empty = reduce(closed.state, { type: "browser.close-tab", tabId: page.id });
  assert.equal(dock(empty.state).tab, "agents", "the panel this thread opened is what is left");

  const hidden = reduce(empty.state, { type: "view.set-dock-open", open: false });
  assert.equal(dock(hidden.state).open, false);
});

test("the workflow a thread's panel is following survives a move to another thread and back", () => {
  const state = workspace({
    tasks: [task("task-1"), task("task-2")],
    currentId: "task-1",
    history: ["task-1"],
    historyIndex: 0,
    workflows: { "task-1": [{ id: "wf-1", name: "review-changes", description: "Review changed files", status: "running", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 }] },
  });

  const opened = reduce(state, { type: "view.open-workflow", workflowId: "wf-1" });
  assert.deepEqual(dock(opened.state).panels, ["workflow"]);
  assert.equal(dock(opened.state).workflowId, "wf-1");
  assert.equal(required(deriveView(opened.state).inspectedWorkflow).name, "review-changes");

  const away = reduce(opened.state, { type: "task.select", taskId: "task-2" });
  assert.equal(deriveView(away.state).inspectedWorkflow, null, "another thread's dock follows no workflow");
  assert.deepEqual(dock(away.state, "task-1").panels, ["workflow"], "and leaving does not close the panel behind you");

  const back = reduce(away.state, { type: "task.select", taskId: "task-1" });
  assert.equal(required(deriveView(back.state).inspectedWorkflow).id, "wf-1", "the panel comes back on the workflow it was following");

  const closed = reduce(back.state, { type: "view.close-dock-panel", panel: "workflow" });
  assert.equal(dock(closed.state).workflowId, null, "closing the panel lets the workflow go");
});

test("a workflow panel closes once the record it was following is gone", () => {
  const workflow: Workflow = { id: "wf-1", name: "review-changes", description: "Review changed files", status: "completed", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 };
  const state = workspace({
    tasks: [task("task-1"), task("task-2")],
    currentId: "task-1",
    workflows: { "task-1": [workflow], "task-2": [{ ...workflow, id: "wf-2" }] },
  });

  const opened = run(state, [
    { type: "view.open-workflow", workflowId: "wf-1" },
    { type: "view.open-dock-panel", panel: "agents" },
  ]);
  const following = reduce(opened, { type: "view.open-workflow", workflowId: "wf-2" });
  assert.equal(dock(following.state, "task-1").workflowId, "wf-1", "a workflow in another thread is not this dock's to open");

  const dropped = reduce(opened, { type: "thread.event", event: { type: "workflow.finished", taskId: "task-1", id: "wf-1", status: "completed", summary: "Review completed" } });
  assert.equal(dock(dropped.state).workflowId, "wf-1", "a workflow that finishes is still there to read");

  const cleared = { ...opened, workflows: { "task-2": opened.workflows["task-2"] } };
  const pruned = reduce(cleared, { type: "view.set-dock-open", open: true });
  assert.deepEqual(dock(pruned.state).panels, ["agents"], "the panel goes with the record it was drawing");
  assert.equal(dock(pruned.state).workflowId, null);
});

test("a view the user opens in the dock is handed the keyboard, and a run's own page is not", () => {
  const state = { ...workspace(), tasks: [task("task-1", { continuation: { provider: "claude", value: "main-session" } }), task("task-2", { executionPolicy: "autonomous" })], currentId: "task-1" };

  const shell = reduce(state, { type: "terminal.open", cwd: "/tmp" });
  const terminalId = dock(shell.state).terminals[0].id;
  assert.deepEqual(shell.state.dockFocus, { owner: "task-1", tab: terminalId, count: 1 });
  assert.equal(required(deriveView(shell.state).dockFocus).tab, terminalId);

  const chat = reduce(shell.state, { type: "side-chat.open", chatId: "chat-1" });
  assert.deepEqual(chat.state.dockFocus, { owner: "task-1", tab: "chat-1", count: 2 });

  const page = reduce(chat.state, { type: "browser.new-tab" });
  assert.equal(required(page.state.dockFocus).tab, dock(page.state).browserTabs[0].id, "a blank page is opened to type an address into");

  const stepped = reduce(page.state, { type: "view.select-dock-index", index: 1 });
  assert.equal(required(stepped.state.dockFocus).tab, terminalId, "the tab a keystroke names takes the keys with it");

  const byRun = reduce(stepped.state, { type: "browser.open", taskId: "task-2", url: "https://two.example" });
  assert.deepEqual(byRun.state.dockFocus, stepped.state.dockFocus, "a run's own page never takes the keyboard");
  assert.equal(required(deriveView(byRun.state).dockFocus).tab, terminalId);
});

test("only a page holds the keys itself; everything else in the dock needs the window to take them back", () => {
  const state = { ...workspace(), lastFolder: "/repo", tasks: [task("task-1")], currentId: "task-1" };

  const shell = reduce(state, { type: "terminal.open" });
  assert.deepEqual(shell.effects.at(-1), { type: "focus-window" }, "a shell is drawn in the window");

  const blank = reduce(shell.state, { type: "browser.new-tab" });
  assert.deepEqual(blank.effects.at(-1), { type: "focus-window" }, "a page with no address is answered by the address bar");

  const loaded = reduce(blank.state, { type: "browser.open", url: "https://one.example" });
  assert.equal(loaded.effects.some((effect) => effect.type === "focus-window"), false, "a page the user opens takes the keys itself");

  const panel = reduce(loaded.state, { type: "view.open-dock-panel", panel: "agents" });
  assert.equal(required(panel.state.dockFocus).tab, "agents", "a panel is a view to read, so it takes the keyboard too");
  assert.deepEqual(panel.effects.at(-1), { type: "focus-window" });

  const hidden = reduce(panel.state, { type: "view.set-dock-open", open: false });
  assert.deepEqual(hidden.effects, [{ type: "focus-window" }], "a hidden panel must not keep what it was holding");

  const shown = reduce(hidden.state, { type: "view.set-dock-open", open: true });
  assert.equal(required(shown.state.dockFocus).tab, "agents", "showing the panel again hands the tab in front the keyboard");
});

test("expanding the dock shows it, and the dock gives up the whole workspace before it gives up a tab", () => {
  const state = { ...workspace(), lastFolder: "/repo", tasks: [task("task-1")], currentId: "task-1" };

  const full = reduce(state, { type: "view.set-dock-expanded", expanded: true });
  assert.equal(dockFor(full.state, dockOwner(full.state)).open, true, "asking for the whole workspace is a way of asking for the dock");
  assert.equal(deriveView(full.state).dockExpanded, true);

  const panel = reduce(full.state, { type: "view.open-dock-panel", panel: "agents" });
  const restored = reduce(panel.state, { type: "view.close-tab" });
  assert.equal(dockFor(restored.state, dockOwner(restored.state)).expanded, false, "the first Escape puts the dock back in its column");
  assert.deepEqual(deriveView(restored.state).dockPanels, ["agents"], "and leaves the tab it was drawing alone");

  const closed = reduce(restored.state, { type: "view.close-tab" });
  assert.deepEqual(deriveView(closed.state).dockPanels, [], "the next one closes the tab");
});

test("a hidden dock does not come back expanded, and each thread keeps its own posture", () => {
  const state = { ...workspace(), lastFolder: "/repo", tasks: [task("task-1"), task("task-2")], currentId: "task-1" };

  const full = run(state, [{ type: "view.set-dock-expanded", expanded: true }]);
  const hidden = reduce(full, { type: "view.set-dock-open", open: false });
  assert.equal(dockFor(hidden.state, "task-1").expanded, false, "hiding the dock ends the posture it was hidden in");

  const shown = reduce(hidden.state, { type: "view.set-dock-open", open: true });
  assert.equal(deriveView(shown.state).dockExpanded, false);

  const settings = run(shown.state, [{ type: "view.set-dock-expanded", expanded: true }, { type: "view.set-settings-open", open: true }, { type: "view.set-settings-open", open: false }]);
  assert.equal(deriveView(reduce(settings, { type: "view.set-dock-open", open: true }).state).dockExpanded, false, "settings put the dock away too, so it does not come back covering the workspace");

  const spread = run(shown.state, [{ type: "view.set-dock-expanded", expanded: true }, { type: "task.select", taskId: "task-2" }]);
  assert.equal(deriveView(spread).dockExpanded, false, "the thread next door has a dock of its own");
  assert.equal(dockFor(spread, "task-1").expanded, true, "and the one left behind is still as it was");
});

test("a new thread is opened to type in, so the caret and the keys go to its composer", () => {
  const reading = run(workspace(), [{ type: "browser.new-tab" }]);
  const started = reduce(reading, { type: "task.new" });

  assert.equal(started.state.composerFocus, reading.composerFocus + 1);
  assert.deepEqual(started.effects, [{ type: "focus-window" }], "a page in the panel is holding the keys until the window takes them back");
  assert.deepEqual(reduce(started.state, { type: "view.focus-composer" }).effects, [{ type: "focus-window" }]);
});

test("a restored page waits for the panel to show it before it loads", () => {
  const restored = reduce(workspace(), {
    type: "preferences.loaded",
    preferences: preferences({ sessionPanelOpen: false, browserTabs: { draft: ["https://example.com/docs", "not a url"] }, browserOrigins: ["https://example.com"] }),
  });

  assert.deepEqual(dock(restored.state).browserTabs.map((tab) => tab.url), ["https://example.com/docs"]);
  assert.equal(dock(restored.state).browserTabs[0].loading, false);
  assert.deepEqual(restored.effects, [], "restoring records loads nothing on its own");

  const tabId = dock(restored.state).browserTabs[0].id;
  const shown = reduce(restored.state, { type: "view.select-dock-tab", tab: tabId });
  assert.deepEqual(shown.effects, [
    { type: "browser.open", tabId, url: "https://example.com/docs" },
    { type: "browser.show", tabId },
  ]);

  const kept = reduce(shown.state, { type: "store.loaded", data: { version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null } });
  assert.deepEqual(dock(kept.state).browserTabs, dock(shown.state).browserTabs, "loading the store does not drop the window's pages");
  assert.deepEqual(kept.state.browserOrigins, ["https://example.com"]);
});

test("a side chat is the dock tab it opens, and closing it gives the dock back its last panel", () => {
  const state = { ...workspace(), tasks: [task("task-1")], currentId: "task-1" };

  const opened = run(state, [
    { type: "view.open-dock-panel", panel: "browser" },
    { type: "side-chat.open", chatId: "chat-1" },
  ]);
  assert.equal(dock(opened).tab, "chat-1");
  assert.equal(dock(opened).open, true);

  const closed = reduce(opened, { type: "side-chat.close", chatId: "chat-1" });
  assert.equal(dock(closed.state).tab, "browser");
});

test("closing a tab takes what is in front, and only then the window", () => {
  const base = { ...workspace(), tasks: [task("task-1")], currentId: "task-1" };

  assert.deepEqual(reduce(base, { type: "view.close-tab" }).effects, [{ type: "close-window" }], "nothing is in front of a bare window");

  const settings = reduce(base, { type: "view.set-settings-open", open: true });
  const shut = reduce(settings.state, { type: "view.close-tab" });
  assert.equal(shut.state.settingsOpen, false);
  assert.deepEqual(shut.effects, [], "settings closing is not the window closing");
  assert.deepEqual(settings.effects, [{ type: "focus-window" }], "settings opening takes the keys off whatever was drawing");

  const asked = reduce({ ...base, computerUseSetup: true }, { type: "view.close-tab" });
  assert.equal(asked.state.computerUseSetup, false, "the settings computer use opened close the same way");

  const browsing = run(base, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "browser.open", url: "https://one.example" },
    { type: "browser.open", url: "https://two.example", newTab: true },
  ]);
  const [first, second] = dock(browsing).browserTabs;

  const closedPage = reduce(browsing, { type: "view.close-tab" });
  assert.deepEqual(dock(closedPage.state).browserTabs.map((tab) => tab.id), [first.id], "the page in front is what ⌘W takes");
  assert.equal(closedPage.effects.some((effect) => effect.type === "browser.close" && effect.tabId === second.id), true);
  assert.equal(dock(closedPage.state).tab, first.id, "and the dock lands on its neighbour");

  const closedLast = reduce(closedPage.state, { type: "view.close-tab" });
  assert.deepEqual(dock(closedLast.state).browserTabs, []);
  assert.equal(dock(closedLast.state).tab, "agents", "the panel behind the pages is the next thing in front");

  const closedAgents = reduce(closedLast.state, { type: "view.close-tab" });
  assert.deepEqual(dock(closedAgents.state).panels, []);
  assert.equal(dock(closedAgents.state).tab, "home");

  const closedDock = reduce(closedAgents.state, { type: "view.close-tab" });
  assert.equal(dock(closedDock.state).open, false, "the picker showing means the dock itself is what is in front");
  assert.deepEqual(closedDock.effects, [{ type: "focus-window" }], "and the window is left with the keyboard");

  assert.deepEqual(reduce(closedDock.state, { type: "view.close-tab" }).effects, [{ type: "close-window" }]);
});

test("a side chat in front closes on ⌘W without taking the thread with it", () => {
  const state = run({ ...workspace(), tasks: [task("task-1")], currentId: "task-1" }, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "side-chat.open", chatId: "chat-1" },
  ]);
  assert.equal(dock(state).tab, "chat-1");

  const closed = reduce(state, { type: "view.close-tab" });
  assert.deepEqual(closed.state.sideChats, []);
  assert.equal(closed.state.tasks.some((item) => item.id === "chat-1"), false, "a side chat's thread goes with it");
  assert.equal(dock(closed.state).tab, "agents");
});

test("opening settings puts the dock away, and closing them forgets the computer use ask", () => {
  const opened = run({ ...workspace(), tasks: [task("task-1")], currentId: "task-1", computerUseSetup: true }, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "view.set-settings-open", open: true },
  ]);
  assert.equal(dock(opened).open, false);
  assert.equal(deriveView(opened).settingsOpen, true);

  const closed = reduce(opened, { type: "view.set-settings-open", open: false });
  assert.equal(closed.state.computerUseSetup, false);
  assert.equal(deriveView(closed.state).settingsOpen, false);
});
