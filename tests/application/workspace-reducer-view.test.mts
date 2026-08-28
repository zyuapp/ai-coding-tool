import assert from "node:assert/strict";
import { test } from "vitest";
import { DIFF_PANEL, reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, dockOwner, engineFeeds } from "../../src/application/workspace-state.ts";
import { capabilitiesFor } from "../../src/domain/agent-engine.ts";
import type { FindTarget } from "../../src/domain/find.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import { task, workspace, effectAt, PROJECT, required, run, send } from "./workspace-reducer-fixtures.mts";

test("visiting threads builds a trail that back and forward walk without extending it", () => {
  const state = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "task.select", taskId: "task-c" },
  ]);
  assert.deepEqual(state.history, ["task-a", "task-b", "task-c"]);

  const back = run(state, [{ type: "view.go-back" }, { type: "view.go-back" }]);
  assert.equal(back.currentId, "task-a");
  assert.deepEqual(back.history, ["task-a", "task-b", "task-c"]);
  assert.ok(deriveView(back).canGoForward);
  assert.ok(!deriveView(back).canGoBack);

  const forward = reduce(back, { type: "view.go-forward" }).state;
  assert.equal(forward.currentId, "task-b");
  assert.ok(deriveView(forward).canGoBack);

  assert.equal(reduce(back, { type: "view.go-back" }).state, back, "there is nowhere further back to go");
});

test("history follows wherever the app took the user, not just sidebar clicks", () => {
  const drafted = run(workspace({ tasks: [task("task-a")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.new" },
    { type: "view.set-prompt", prompt: "Inspect the app" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.deepEqual(started.state.history, ["task-a", started.state.currentId]);
  assert.equal(reduce(started.state, { type: "view.go-back" }).state.currentId, "task-a");
});

test("visiting a thread after going back drops the trail ahead of it", () => {
  const walked = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "view.go-back" },
    { type: "task.select", taskId: "task-c" },
  ]);
  assert.deepEqual(walked.history, ["task-a", "task-c"]);
  assert.equal(walked.currentId, "task-c");
  assert.ok(!deriveView(walked).canGoForward);
});

test("back and forward step over threads that are gone or archived", () => {
  const visited = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "task.select", taskId: "task-c" },
  ]);

  const archived = reduce(visited, { type: "task.archive", taskId: "task-b" }).state;
  const back = reduce(archived, { type: "view.go-back" }).state;
  assert.equal(back.currentId, "task-a", "the archived thread in between is skipped");
  assert.equal(reduce(back, { type: "view.go-forward" }).state.currentId, "task-c");

  const emptied = { ...visited, tasks: visited.tasks.filter((item) => item.id !== "task-a") };
  assert.ok(!deriveView({ ...emptied, historyIndex: 1 }).canGoBack, "a thread that no longer exists is nowhere to go");

  const duplicate = workspace({
    tasks: [task("archived", { archivedAt: 0 }), task("shared", { archivedAt: 0 }), task("shared")],
    history: ["archived", "shared"],
    historyIndex: -1,
  });
  assert.equal(reduce(duplicate, { type: "view.go-forward" }).state.currentId, "shared", "an archived entry at time zero is skipped while a live duplicate id stays reachable");
});

/** A thread with the review open in its dock, which is what a review search points at. */
function reviewing() {
  const state = run(workspace({ tasks: [task("task-a")], currentId: "task-a", lastFolder: "/repo" }), [
    { type: "view.open-dock-panel", panel: DIFF_PANEL },
  ]);
  const owner = dockOwner(state);
  const target: FindTarget = { kind: "review", owner };
  return { state: run(state, [{ type: "view.find-open", target }, { type: "view.find-query", query: "needle" }]), target };
}

test("a review counts its own matches and the reducer keeps the place in them", () => {
  const { state, target } = reviewing();

  assert.deepEqual(reduce(state, { type: "view.find-query", query: "needle" }).effects, [], "nothing outside is asked to search a review");
  assert.ok(deriveView(state).find!.counting, "a review that has not reported yet is still counting, not empty");

  const counted = reduce(state, { type: "find.results", target, results: { matches: 3 } }).state;
  assert.equal(deriveView(counted).find!.matches, 3);
  assert.ok(!deriveView(counted).find!.counting);

  const stepped = run(counted, [{ type: "view.find-step", delta: 1 }, { type: "view.find-step", delta: 1 }]);
  assert.equal(deriveView(stepped).find!.index, 2);
  assert.equal(deriveView(reduce(stepped, { type: "view.find-step", delta: 1 }).state).find!.index, 0, "stepping wraps");
});

test("a review still reading says so, and a later patch may move the user with the match they are on", () => {
  const { state, target } = reviewing();
  const counting = reduce(state, { type: "find.results", target, results: { matches: 2, counting: true } }).state;

  assert.ok(deriveView(counting).find!.counting);

  const stepped = reduce(counting, { type: "view.find-step", delta: 1 }).state;
  assert.equal(stepped.find!.index, 1);

  const landed = reduce(stepped, { type: "find.results", target, results: { matches: 9, index: 4 } }).state;
  assert.equal(landed.find!.index, 4, "the match being read keeps the user, wherever it moved to");

  const quiet = reduce(landed, { type: "find.results", target, results: { matches: 9, index: 4 } });
  assert.equal(quiet.state, landed, "a report that says nothing new costs nothing");
});

test("a report from a view the bar is no longer pointed at is not the bar's", () => {
  const { state } = reviewing();
  const other = reduce(state, { type: "find.results", target: { kind: "review", owner: "somebody-else" }, results: { matches: 7 } });

  assert.equal(other.state, state);
});

test("closing the review takes its find bar with it", () => {
  const { state } = reviewing();
  const closed = reduce(state, { type: "view.close-dock-panel", panel: DIFF_PANEL }).state;

  assert.equal(closed.find, null);
  assert.equal(closed.findResults, null);
});

/** A thread with a small panel open in its dock, which is what a panel search points at. */
function panelling() {
  const state = run(workspace({ tasks: [task("task-a")], currentId: "task-a" }), [
    { type: "view.open-dock-panel", panel: "agents" },
  ]);
  const owner = dockOwner(state);
  const target: FindTarget = { kind: "panel", owner, panel: "agents" };
  return { state: run(state, [{ type: "view.find-open", target }, { type: "view.find-query", query: "needle" }]), target };
}

test("a panel reports what it drew, and the reducer alone moves through it", () => {
  const { state, target } = panelling();

  assert.deepEqual(reduce(state, { type: "view.find-query", query: "needle" }).effects, [], "nothing outside is asked to search a panel");

  const counted = reduce(state, { type: "find.results", target, results: { matches: 4 } }).state;
  assert.equal(deriveView(counted).find!.matches, 4);

  const stepped = reduce(counted, { type: "view.find-step", delta: 1 }).state;
  assert.equal(stepped.find!.index, 1);

  assert.equal(reduce(stepped, { type: "find.results", target, results: { matches: 4 } }).state, stepped, "redrawing the same count never fights the user's stepping");
  assert.equal(run(stepped, [{ type: "view.find-step", delta: -1 }, { type: "view.find-step", delta: -1 }]).find!.index, 3, "stepping wraps");
});

test("closing the panel being searched takes its find bar with it", () => {
  const { state } = panelling();
  const closed = reduce(state, { type: "view.close-dock-panel", panel: "agents" }).state;

  assert.equal(closed.find, null);
  assert.equal(closed.findResults, null);
});

test("coming back to the window reads Git again", () => {
  const state = workspace({ projects: [PROJECT], tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const back = reduce({ ...state, focused: false }, { type: "view.set-focused", focused: true });
  assert.deepEqual(back.effects, [{ type: "refresh-environment", workspaceId: required(PROJECT.workspaceId), taskId: "task-a" }]);

  const away = reduce(state, { type: "view.set-focused", focused: false });
  assert.deepEqual(away.effects, [], "a window left alone asks nothing");
});

test("coming back to the window reads an engine the user went off to install, and only that engine", () => {
  const state = workspace({ projects: [PROJECT], tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", focused: false });
  const environment = { type: "refresh-environment", workspaceId: required(PROJECT.workspaceId), taskId: "task-a" };

  const ready = reduce({ ...state, engineStatus: { claude: { access: "ready" } } }, { type: "view.set-focused", focused: true });
  assert.deepEqual(ready.effects, [environment], "a machine with its engines in place pays nothing for switching windows");

  const broken = { ...state, engineStatus: { claude: { access: "missing" as const, fix: "curl -fsSL https://claude.ai/install.sh | bash" } } };
  const asked = reduce(broken, { type: "view.set-focused", focused: true });
  assert.deepEqual(asked.effects, [environment, { type: "engine.read", refresh: true }]);
  assert.equal(asked.state.engineChecking, true);

  const again = reduce({ ...asked.state, focused: false }, { type: "view.set-focused", focused: true });
  assert.deepEqual(again.effects, [environment], "an ask already out is not asked twice");
});

test("a thread's panels are fed only where its engine can fill them", () => {
  const workflow: Workflow = { id: "wf-1", name: "Release", description: "", status: "running", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 };
  const subagent: Subagent = { id: "sub-1", description: "Inspect", status: "working", startedAt: 1, activity: [] };
  const state = workspace({ tasks: [task("task-a", { subagents: [subagent] })], currentId: "task-a", workflows: { "task-a": [workflow] } });
  const claude = deriveView(state);
  assert.deepEqual(claude.capabilities, capabilitiesFor("claude"));
  assert.equal(claude.engineLabel, "Claude");
  assert.deepEqual(claude.workflows, [workflow]);
  assert.deepEqual(claude.subagents, [subagent]);

  const silent = engineFeeds({ ...capabilitiesFor("claude"), workflows: false, subagents: false }, state, state.tasks[0]);
  assert.deepEqual(silent.workflows, []);
  assert.deepEqual(silent.subagents, []);
  const fed = engineFeeds({ ...capabilitiesFor("claude"), workflows: false }, state, state.tasks[0]);
  assert.deepEqual(fed.subagents, [subagent], "each feed is gated on its own flag");

  const codex = deriveView({ ...state, tasks: [{ ...state.tasks[0], engine: "codex", model: "gpt-5.6-sol" }] });
  assert.deepEqual(codex.subagents, [subagent], "Codex feeds the shared subagent panel");
  assert.deepEqual(codex.workflows, []);
});

test("the jump panel opens on the most recent threads, then a name narrows them", () => {
  const state = workspace({
    tasks: [
      task("task-a", { title: "Dock the browser panel", updatedAt: 3 }),
      task("task-b", { title: "Panel find", updatedAt: 2 }),
      task("task-c", { title: "Ship the review", updatedAt: 1 }),
    ],
  });

  const opened = reduce(state, { type: "view.shortcut", action: "thread.jump", surface: "any" }).state;
  assert.deepEqual(required(deriveView(opened).jump).options.map((option) => option.title), ["Dock the browser panel", "Panel find", "Ship the review"]);

  const typed = reduce(opened, { type: "view.jump-query", query: "panel" }).state;
  const jump = required(deriveView(typed).jump);
  assert.deepEqual(jump.options.map((option) => option.title), ["Panel find", "Dock the browser panel"]);
  assert.equal(jump.index, 0);
});

test("the arrow keys walk the rows and wrap, and a name that moves them starts at the top again", () => {
  const state = run(workspace({ tasks: [task("task-a", { updatedAt: 2 }), task("task-b", { updatedAt: 1 })] }), [
    { type: "view.jump-open" },
    { type: "view.jump-step", delta: 1 },
  ]);
  assert.equal(required(deriveView(state).jump).index, 1);

  const wrapped = reduce(state, { type: "view.jump-step", delta: 1 }).state;
  assert.equal(required(deriveView(wrapped).jump).index, 0);
  assert.equal(required(deriveView(reduce(wrapped, { type: "view.jump-step", delta: -1 }).state).jump).index, 1);

  const typed = reduce(state, { type: "view.jump-query", query: "task" }).state;
  assert.equal(required(deriveView(typed).jump).index, 0);
});

test("choosing a row opens that thread and closes the panel", () => {
  const state = run(workspace({ tasks: [task("task-a"), task("task-b")] }), [
    { type: "view.jump-open" },
    { type: "view.jump-choose", taskId: "task-b" },
  ]);
  assert.equal(state.currentId, "task-b");
  assert.equal(deriveView(state).jump, null);
  assert.deepEqual(state.history, ["task-b"], "the thread jumped to is a place the trail records");
});

test("the jump keystroke closes the panel it opened, and settings give way to it", () => {
  const state = workspace({ tasks: [task("task-a")], settingsOpen: true });
  const opened = reduce(state, { type: "view.shortcut", action: "thread.jump", surface: "any" }).state;
  assert.ok(opened.jump);
  assert.ok(!opened.settingsOpen);

  const closed = reduce(opened, { type: "view.shortcut", action: "thread.jump", surface: "any" }).state;
  assert.equal(closed.jump, null);
});

test("the jump keystroke is one the user can rebind", () => {
  const state = reduce(workspace(), { type: "view.set-shortcut", action: "thread.jump", binding: "Mod+P" }).state;
  const setting = required(deriveView(state).shortcuts.find((row) => row.id === "thread.jump"));
  assert.equal(setting.binding, "Mod+P");
  assert.ok(setting.changed);
});
