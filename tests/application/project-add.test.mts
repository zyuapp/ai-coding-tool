import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, deriveView } from "../../src/application/workspace-state.ts";
import { routeInput } from "../../src/application/computers.ts";
import { isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";
import { executeWorkspaceInput } from "../../src/application/workspace-execution.ts";
import { runWorkspaceEffect } from "../../src/host/workspace-effects.ts";
import { projectEffects } from "../../src/host/project-effects.ts";
import type { EffectHost } from "../../src/host/effect-host.ts";
import { settledUnlisted } from "../../src/application/project-commands.ts";
import { sidebarLists } from "../../src/application/sidebar-lists.ts";
import { task } from "./workspace-reducer-fixtures.mts";

function workspace() {
  const state = emptyWorkspaceState();
  state.computers = { ...state.computers, name: "Mac", filter: "linux", active: "linux", paired: [{ id: "linux", name: "Linux", host: "linux", pairedAt: 1, status: "connected", error: null, state: emptyWorkspaceState() }] };
  return state;
}

test("opening a local project uses the native picker unless a connected computer needs a device choice", () => {
  for (const filter of ["all", "this"]) {
    const state = emptyWorkspaceState();
    state.computers = { ...state.computers, filter };
    assert.deepEqual(reduce(state, { type: "project.open" }).effects, [{ type: "pick-project" }]);
    for (const status of ["offline", "connecting", "connected"] as const) {
      state.computers.paired = [{ ...workspace().computers.paired[0]!, status }];
      const opened = reduce(state, { type: "project.open" });
      if (status === "connected") {
        assert.deepEqual(opened.effects, []);
        assert.equal(opened.state.projectAdd?.computerId, "this");
      } else {
        assert.deepEqual(opened.effects, [{ type: "pick-project" }]);
        assert.equal(opened.state.projectAdd, null);
      }
    }
  }
});

test("a filter naming a paired computer opens the dialog even when that computer is down", () => {
  for (const status of ["offline", "connecting", "connected"] as const) {
    const state = workspace();
    state.computers.paired[0] = { ...state.computers.paired[0]!, status };
    const opened = reduce(state, { type: "project.open" });
    assert.deepEqual(opened.effects, []);
    assert.equal(opened.state.projectAdd?.computerId, "linux");
  }
});

test("add defaults to the filtered device and explicit path commands route even with no projects", () => {
  const state = workspace();
  const opened = reduce(state, { type: "project.open" });
  assert.equal(opened.state.projectAdd?.computerId, "linux");
  assert.equal(deriveView(opened.state).projectAdd?.computerId, "linux");
  assert.deepEqual(opened.effects, []);
  for (const filter of ["all", "this"]) {
    assert.equal(reduce({ ...state, computers: { ...state.computers, filter } }, { type: "project.open" }).state.projectAdd?.computerId, "this");
  }
  const route = routeInput(state, { type: "project.add", root: "~/app", computerId: "linux" });
  assert.equal(route.kind, "computer");
  if (route.kind === "computer") assert.deepEqual(route.inputs, [{ type: "project.add", root: "~/app" }]);
  assert.deepEqual(reduce(state, { type: "project.add", root: "~/app", computerId: "linux" }).effects, [
    { type: "computer.forward", id: "linux", inputs: [{ type: "project.add", root: "~/app" }] },
  ]);
  assert.deepEqual(routeInput(state, { type: "project.add", root: "/local" }), { kind: "local" });
  assert.equal(routeInput(emptyWorkspaceState(), { type: "project.add", root: "/app", computerId: "forgotten" }).kind, "refuse");
  const offline = workspace();
  offline.computers.paired[0] = { ...offline.computers.paired[0]!, status: "offline", error: "Connection refused" };
  assert.deepEqual(routeInput(offline, { type: "project.add", root: "/app", computerId: "linux" }), { kind: "refuse", message: "Connection refused" });
  const refused = reduce(offline, { type: "project.add", root: "/app", computerId: "linux" });
  assert.deepEqual(refused.effects, []);
  assert.deepEqual(refused.result, { ok: false, message: "Connection refused" });
  offline.computers.paired[0] = { ...offline.computers.paired[0]!, error: null };
  assert.deepEqual(routeInput(offline, { type: "project.add", root: "/app", computerId: "linux" }), { kind: "refuse", message: "Linux is offline." });
});

test("directory replies and picker replies cannot overwrite a newer device, path or dialog", () => {
  let state = reduce(workspace(), { type: "project.open" }).state;
  const typed = reduce(state, { type: "view.add-project-path", root: "/wo" });
  state = typed.state;
  const request = state.projectAdd!.request;
  assert.deepEqual(typed.effects, [{ type: "project-add.directories", prefix: "/wo", computerId: "linux", request }]);
  state = reduce(state, { type: "project.directories", request, directories: ["/work/", "/world/"] }).state;
  state = reduce(state, { type: "view.add-project-key", key: "ArrowUp" }).state;
  assert.equal(state.projectAdd?.selected, 1);
  state = reduce(state, { type: "view.add-project-key", key: "Enter" }).state;
  assert.equal(state.projectAdd?.root, "/world/");
  assert.deepEqual(state.projectAdd?.suggestions, []);
  state = reduce(state, { type: "view.add-project-device", computerId: "this" }).state;
  assert.equal(state.projectAdd?.root, "");
  assert.equal(reduce(state, { type: "project.directories", request, directories: ["/wrong/"] }).state, state);
  assert.equal(reduce(state, { type: "project.path-picked", request, root: "/wrong" }).state, state);
  const newRequest = state.projectAdd!.request;
  state = reduce(state, { type: "project.path-picked", request: newRequest, root: "/chosen" }).state;
  assert.equal(state.projectAdd?.root, "/chosen");
  assert.equal(state.projects.length, 0);
  state = reduce(state, { type: "view.add-project-close" }).state;
  state = reduce(state, { type: "project.open" }).state;
  assert.equal(reduce(state, { type: "project.add-finished", request: newRequest }).state, state);
});

test("local and remote registration failures return to the submitting dialog, then a retry registers once", async () => {
  for (const computerId of ["this", "linux"]) {
    let state = reduce(workspace(), { type: "project.open" }).state;
    state = reduce(state, { type: "view.add-project-device", computerId }).state;
    state = reduce(state, { type: "view.add-project-path", root: "/app" }).state;
    let remote: ReturnType<typeof emptyWorkspaceState> = { ...emptyWorkspaceState(), currentId: "held-thread" };
    let fail = true;
    const registered = { id: "ws", kind: "project" as const, root: "/app" };
    const desktop = { registerProject: async () => { if (fail) throw new Error("There is no folder at /app."); return registered; } } as unknown as EffectHost["desktop"];
    const run = (input: WorkspaceInput, remoteHost = false) => executeWorkspaceInput(input, {
      state: () => remoteHost ? remote : state,
      commit: (next) => { if (remoteHost) remote = next; else state = next; },
      perform: (effect, dispatch) => runWorkspaceEffect(effect, { desktop, dispatch } as EffectHost),
    }).completed;
    desktop.sendToComputer = async (id, inputs) => { assert.equal(id, "linux"); return run(inputs[0]!, true); };
    const queryRequest = state.projectAdd!.request;
    const failure = await run({ type: "view.add-project-submit" });
    assert.equal(failure.ok, false);
    assert.equal(state.projectAdd?.error, "There is no folder at /app.");
    assert.equal(state.projectAdd?.saving, false);
    await run({ type: "project.directories", request: queryRequest, directories: [] });
    assert.equal(state.projectAdd?.error, "There is no folder at /app.", "late autocomplete must not erase the submission error");
    assert.equal(state.projects.length, 0);
    fail = false;
    assert.equal((await run({ type: "view.add-project-submit" })).ok, true);
    assert.equal(state.projectAdd, null);
    const holder = computerId === "this" ? state : remote;
    assert.equal(holder.projects.length, 1);
    assert.equal(holder.projects[0]?.root, "/app");
    if (computerId === "linux") assert.equal(remote.currentId, "held-thread");
    await run({ type: "project.add", root: "/app", computerId });
    assert.equal((computerId === "this" ? state : remote).projects.length, 1);
  }
});

test("path queries debounce before reading disk", async () => {
  vi.useFakeTimers();
  try {
    const calls: unknown[] = [];
    const desktop = { directories: async (...args: unknown[]) => { calls.push(args); return []; } } as unknown as EffectHost["desktop"];
    const host = { desktop, dispatch: async () => {} } as unknown as EffectHost;
    const first = projectEffects["project-add.directories"]({ type: "project-add.directories", computerId: "linux", prefix: "/w", request: 1 }, host);
    const second = projectEffects["project-add.directories"]({ type: "project-add.directories", computerId: "this", prefix: "/work", request: 2 }, host);
    await vi.advanceTimersByTimeAsync(179);
    assert.deepEqual(calls, []);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    assert.deepEqual(calls, [["/work", "this"]]);
  } finally { vi.useRealTimers(); }
});

test("external path commands are bounded and validated", () => {
  assert.equal(isWorkspaceViewInput({ type: "project.add", root: "~/app", computerId: "linux" }), true);
  for (const root of ["", "  ", "a".repeat(4097), "a\0b", 42]) assert.equal(isWorkspaceViewInput({ type: "project.add", root }), false);
  assert.equal(isWorkspaceViewInput({ type: "project.add", root: "/app", computerId: 42 }), false);
  assert.equal(isWorkspaceViewInput({ type: "view.add-project-accept", index: -1 }), false);
});

const sidebarProjects = (state: ReturnType<typeof emptyWorkspaceState>) => sidebarLists(state, state.projects, state.threads, new Set(), new Set()).projects.map((project) => project.root);

test("the start shortcut asks for a path, then opens a draft in a folder the sidebar leaves out until a thread starts", () => {
  let state = reduce(emptyWorkspaceState(), { type: "view.shortcut", action: "project.start", surface: "any" }).state;
  assert.equal(state.projectAdd?.start, true);
  assert.equal(state.projectAdd?.computerId, "this");
  state = reduce(state, { type: "view.add-project-path", root: "/app" }).state;
  const submitted = reduce(state, { type: "view.add-project-submit" });
  const request = state.projectAdd!.request + 1;
  assert.deepEqual(submitted.effects, [{ type: "add-project", root: "/app", request, start: true }]);
  state = reduce(submitted.state, { type: "project.added", workspace: { id: "ws", kind: "project", root: "/app" }, request, start: true }).state;
  const id = state.projects[0]!.id;
  assert.equal(state.projectAdd, null);
  assert.equal(state.currentId, null);
  assert.equal(state.draftProjectId, id);
  assert.equal(state.projects[0]!.unlisted, true);
  assert.deepEqual(sidebarProjects(state), []);
  const started = settledUnlisted(state, { ...state, threads: [task("t1", { projectId: id })] });
  assert.equal(started.projects[0]!.unlisted, undefined);
  assert.deepEqual(sidebarProjects(started), ["/app"]);
  const left = reduce(state, { type: "task.new" }).state;
  assert.deepEqual(left.projects, []);
  assert.equal(left.expandedProjects.has(id), false);
});

test("starting in a listed folder keeps it listed, and adding an unlisted one lists it", () => {
  const workspaceRecord = { id: "ws", kind: "project" as const, root: "/app" };
  let state = reduce(emptyWorkspaceState(), { type: "project.opened", workspace: workspaceRecord }).state;
  state = reduce(state, { type: "project.added", workspace: workspaceRecord, start: true }).state;
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0]!.unlisted, undefined);
  state = reduce(emptyWorkspaceState(), { type: "project.added", workspace: workspaceRecord, start: true }).state;
  assert.equal(state.projects[0]!.unlisted, true);
  state = reduce(state, { type: "project.opened", workspace: workspaceRecord }).state;
  assert.equal(state.projects[0]!.unlisted, undefined);
});

test("Enter submits a path typed out in full and completes a partial one", () => {
  let state = reduce(emptyWorkspaceState(), { type: "project.open", start: true }).state;
  state = reduce(state, { type: "view.add-project-path", root: "/app" }).state;
  state = reduce(state, { type: "project.directories", request: state.projectAdd!.request, directories: ["/app/", "/apple/"] }).state;
  assert.equal(reduce(state, { type: "view.add-project-key", key: "Enter" }).state.projectAdd?.saving, true);
  state = reduce(state, { type: "view.add-project-path", root: "/ap" }).state;
  state = reduce(state, { type: "project.directories", request: state.projectAdd!.request, directories: ["/app/", "/apple/"] }).state;
  assert.equal(reduce(state, { type: "view.add-project-key", key: "Enter" }).state.projectAdd?.root, "/app/");
});

test("a start answered after the dialog closed does not move the window", () => {
  let state = reduce(emptyWorkspaceState(), { type: "project.open", start: true }).state;
  state = reduce(state, { type: "view.add-project-path", root: "/app" }).state;
  state = reduce(state, { type: "view.add-project-submit" }).state;
  const request = state.projectAdd!.request;
  state = reduce(state, { type: "view.add-project-close" }).state;
  const answered = reduce(state, { type: "project.added", workspace: { id: "ws", kind: "project", root: "/app" }, request, start: true }).state;
  assert.deepEqual(answered.projects, []);
});

test("starting in a folder on a paired computer opens its draft there and puts that computer on screen", async () => {
  let state = workspace();
  state.computers = { ...state.computers, active: null };
  let remote: ReturnType<typeof emptyWorkspaceState> = { ...emptyWorkspaceState(), currentId: "held-thread" };
  const stubs: Record<string, unknown> = { registerProject: async () => ({ id: "ws", kind: "project" as const, root: "/app" }) };
  const desktop = new Proxy(stubs, { get: (target, key: string) => target[key] ?? (async () => {}) }) as unknown as EffectHost["desktop"];
  const run = (input: WorkspaceInput, remoteHost = false) => executeWorkspaceInput(input, {
    state: () => remoteHost ? remote : state,
    commit: (next) => { if (remoteHost) remote = next; else state = next; },
    perform: (effect, dispatch) => runWorkspaceEffect(effect, { desktop, dispatch } as EffectHost),
  }).completed;
  desktop.sendToComputer = async (_id, inputs) => {
    let result = { ok: true } as Awaited<ReturnType<typeof run>>;
    for (const input of inputs) result = await run(input, true);
    return result;
  };
  await run({ type: "project.open", start: true });
  assert.equal(state.projectAdd?.computerId, "linux");
  await run({ type: "view.add-project-path", root: "/app" });
  assert.equal((await run({ type: "view.add-project-submit" })).ok, true);
  assert.equal(state.projectAdd, null);
  assert.equal(state.computers.active, "linux");
  assert.equal(state.projects.length, 0);
  assert.equal(remote.currentId, null);
  assert.equal(remote.draftProjectId, remote.projects[0]?.id);
  assert.equal(remote.projects[0]?.unlisted, true);
});

test("start options are validated and the shortcut is configurable", () => {
  assert.equal(isWorkspaceViewInput({ type: "project.open", start: true }), true);
  assert.equal(isWorkspaceViewInput({ type: "project.open", start: false }), false);
  assert.equal(isWorkspaceViewInput({ type: "project.add", root: "/app", start: true }), true);
  assert.equal(isWorkspaceViewInput({ type: "project.add", root: "/app", start: "yes" }), false);
});
