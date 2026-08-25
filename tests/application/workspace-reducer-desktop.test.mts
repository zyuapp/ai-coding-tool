import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, WORKSPACE_ERRORS } from "../../src/application/workspace-reducer.ts";
import { dock, task, workspace, run, running, inside } from "./workspace-reducer-fixtures.mts";

test("a terminal opens in the thread's own checkout and takes a dock tab of its own", () => {
  const state = {
    ...workspace(),
    projects: [{ id: "project-1", root: "/repo" }],
    tasks: [task("task-1", { projectId: "project-1" })],
    currentId: "task-1",
  };

  const opened = reduce(state, { type: "terminal.open" });
  const [terminal] = dock(opened.state).terminals;

  assert.equal(terminal.cwd, "/repo");
  assert.equal(terminal.title, "repo");
  assert.equal(terminal.taskId, "task-1");
  assert.equal(terminal.status, "running");
  assert.equal(dock(opened.state).terminalId, terminal.id);
  assert.equal(dock(opened.state).open, true, "a shell has to land somewhere the user can see it");
  assert.equal(dock(opened.state).tab, terminal.id, "a shell is a tab in the dock, not a tab inside a panel");
  assert.deepEqual(opened.effects, [{ type: "terminal.start", terminalId: terminal.id, cwd: "/repo" }, { type: "focus-window" }], "the shell starts, and the window hands it the keyboard");

  const inWorktree = { ...state, tasks: [task("task-1", { projectId: "project-1", worktreeId: "w1" })], worktrees: [{ id: "w1", projectId: "project-1", root: "/worktrees/repo-w1", workspaceId: "ws-1", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 }] };
  assert.equal(dock(reduce(inWorktree, { type: "terminal.open" }).state).terminals[0].cwd, "/worktrees/repo-w1");
});

test("a file named in a message opens against the checkout that thread works in", () => {
  const state = { ...workspace(), projects: [{ id: "project-1", root: "/repo" }], tasks: [task("task-1", { projectId: "project-1" })], currentId: "task-1" };
  assert.deepEqual(reduce(state, { type: "file.open", path: "src/App.tsx", line: 42 }).effects, [{ type: "file.open", roots: ["/repo"], path: "src/App.tsx", line: 42 }]);

  const checkout = (id: string, lastUsedAt: number) => ({ id, projectId: "project-1", root: `/worktrees/repo-${id}`, workspaceId: `ws-${id}`, baseCommit: id, createdAt: 1, lastUsedAt });
  const inWorktree = { ...state, tasks: [task("task-1", { projectId: "project-1", worktreeId: "w1" })], worktrees: [checkout("w1", 1), checkout("w2", 9)] };
  /** Nearest the thread first: its own checkout, then its project, then the project's other checkouts. */
  assert.deepEqual(reduce(inWorktree, { type: "file.open", path: "src/App.tsx" }).effects, [{ type: "file.open", roots: ["/worktrees/repo-w1", "/repo", "/worktrees/repo-w2"], path: "src/App.tsx", line: null }]);
  const refused = reduce(workspace(), { type: "file.open", path: "src/App.tsx" });
  assert.deepEqual(refused.effects, []);
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.fileFolder);
  const named = reduce(workspace(), { type: "file.open", path: "/etc/hosts" });
  assert.deepEqual(named.effects, [{ type: "file.open", roots: [], path: "/etc/hosts", line: null }], "a file named in full opens without a checkout to look in");
});

test("opening the thread in another application hands over the checkout it works in", () => {
  const state = {
    ...workspace(),
    projects: [{ id: "project-1", root: "/repo" }],
    tasks: [task("task-1", { projectId: "project-1" })],
    currentId: "task-1",
    openMenu: "workspace:open-in",
  };

  const local = reduce(state, { type: "app.open-folder", appId: "cursor" });
  assert.deepEqual(local.effects, [{ type: "app.open-folder", root: "/repo", appId: "cursor" }]);
  assert.equal(local.state.openMenu, null, "choosing an application closes the list");

  const inWorktree = { ...state, tasks: [task("task-1", { projectId: "project-1", worktreeId: "w1" })], worktrees: [{ id: "w1", projectId: "project-1", root: "/worktrees/repo-w1", workspaceId: "ws-1", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 }] };
  assert.deepEqual(
    reduce(inWorktree, { type: "app.open-folder", appId: "terminal" }).effects,
    [{ type: "app.open-folder", root: "/worktrees/repo-w1", appId: "terminal" }],
    "a thread in a worktree hands over the worktree",
  );

  const refused = reduce(workspace(), { type: "app.open-folder", appId: "cursor" });
  assert.deepEqual(refused.effects, []);
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.appFolder);
});

test("a terminal needs a folder to start in", () => {
  const refused = reduce(workspace(), { type: "terminal.open" });

  assert.deepEqual(dock(refused.state).terminals, []);
  assert.deepEqual(refused.effects, []);
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.terminalFolder);
});

test("what a shell reports is the only thing that writes the terminal record, and its output is never state", () => {
  const opened = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const [terminal] = dock(opened.state).terminals;

  const named = reduce(opened.state, { type: "terminal.updated", update: { terminalId: terminal.id, title: "npm run dev" } });
  assert.equal(dock(named.state).terminals[0].title, "npm run dev");

  const exited = reduce(named.state, { type: "terminal.updated", update: { terminalId: terminal.id, status: "exited", exitCode: 1 } });
  assert.equal(dock(exited.state).terminals[0].status, "exited");
  assert.equal(dock(exited.state).terminals[0].exitCode, 1);
  assert.deepEqual(exited.effects, [], "a record change asks for no work");

  const stray = reduce(exited.state, { type: "terminal.updated", update: { terminalId: "gone", title: "Nowhere" } });
  assert.equal(stray.state, exited.state);

  assert.equal(JSON.stringify(exited.state).includes("output"), false);
});

test("typing and resizing a terminal ask for work without touching state", () => {
  const opened = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const [terminal] = dock(opened.state).terminals;

  const typed = reduce(opened.state, { type: "terminal.input", terminalId: terminal.id, data: "ls\r" });
  assert.equal(typed.state, opened.state);
  assert.deepEqual(typed.effects, [{ type: "terminal.write", terminalId: terminal.id, data: "ls\r" }]);

  const resized = reduce(opened.state, { type: "terminal.resize", terminalId: terminal.id, cols: 120, rows: 40 });
  assert.equal(resized.state, opened.state);
  assert.deepEqual(resized.effects, [{ type: "terminal.resize", terminalId: terminal.id, cols: 120, rows: 40 }]);
});

test("closing a terminal hands the panel its neighbour and kills only the shell that went", () => {
  const first = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const second = reduce(first.state, { type: "terminal.open" });
  const [one, two] = dock(second.state).terminals;

  const closed = reduce(second.state, { type: "terminal.close", terminalId: two.id });
  assert.deepEqual(dock(closed.state).terminals.map((terminal) => terminal.id), [one.id]);
  assert.equal(dock(closed.state).terminalId, one.id);
  assert.deepEqual(closed.effects, [{ type: "terminal.close", terminalId: two.id }]);

  const empty = reduce(closed.state, { type: "terminal.close", terminalId: one.id });
  assert.equal(dock(empty.state).terminalId, null);
  assert.deepEqual(dock(empty.state).terminals, []);
});

test("⌘W closes the terminal in front, then the dock behind it", () => {
  const opened = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const [terminal] = dock(opened.state).terminals;

  const closedShell = reduce(opened.state, { type: "view.close-tab" });
  assert.deepEqual(dock(closedShell.state).terminals, []);
  assert.deepEqual(closedShell.effects, [{ type: "terminal.close", terminalId: terminal.id }, { type: "focus-window" }], "what the closed shell was holding comes back to the window");
  assert.equal(dock(closedShell.state).tab, "home", "nothing is left in the dock but the picker");

  assert.equal(dock(reduce(closedShell.state, { type: "view.close-tab" }).state).open, false);
});
