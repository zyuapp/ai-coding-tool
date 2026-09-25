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
