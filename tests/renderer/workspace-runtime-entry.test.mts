import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import "../support/renderer-dom.mts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceBridge, WorkspaceRequest, WorkspaceResponse, WorkspaceUpdate } from "../../src/contracts/workspace-runtime.ts";

const runtimeFactory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../src/renderer/task-workspace/workspace-runtime.ts", () => ({ createWorkspaceRuntime: runtimeFactory.create }));

afterEach(() => { delete window.workspace; });

test("runtime transport forwards command refusal and batches synchronous state publications", async () => {
  vi.resetModules();
  let state = emptyWorkspaceState();
  let publish!: () => void;
  let receive!: (request: WorkspaceRequest) => void;
  const responses: WorkspaceResponse[] = [];
  const updates: WorkspaceUpdate[] = [];
  const ready = vi.fn();
  const flushed = Promise.withResolvers<void>();
  const refused = { ok: false as const, message: "Cannot move a running thread" };
  runtimeFactory.create.mockReturnValue({
    getState: () => state,
    subscribe: (listener: () => void) => { publish = listener; },
    start: async () => {},
    execute: () => ({ accepted: refused, completed: Promise.resolve(refused) }),
    flush: () => flushed.promise,
    dispatch: async () => {},
  });
  window.workspace = {
    owner: true,
    onRequest: (listener: (request: WorkspaceRequest) => void) => { receive = listener; return () => {}; },
    publish: (update: WorkspaceUpdate) => updates.push(update),
    respond: (response: WorkspaceResponse) => responses.push(response),
    ready,
  } as unknown as WorkspaceBridge;
  await import("../../src/renderer/workspace-runtime-entry.ts");
  await vi.waitFor(() => assert.equal(ready.mock.calls.length, 1));
  state = { ...state, actionError: "first" };
  publish();
  state = { ...state, actionError: "second" };
  publish();
  assert.equal(updates.length, 0);
  await Promise.resolve();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { revision: 1, patches: [{ path: ["actionError"], value: "second" }] });
  receive({ id: "refused", input: { type: "task.move-worktree", destination: { kind: "local" } } });
  await vi.waitFor(() => assert.equal(responses.length, 1));
  assert.deepEqual(responses[0], { id: "refused", result: { ...refused, revision: 1 } });
  receive({ id: "snapshot" });
  await vi.waitFor(() => assert.equal(responses.length, 2));
  assert.deepEqual(updates.at(-1), { revision: 1, state });
  receive({ id: "flush", flush: true });
  await Promise.resolve();
  assert.equal(responses.length, 2);
  state = { ...state, actionError: "saved before exit" };
  publish();
  flushed.resolve();
  await vi.waitFor(() => assert.equal(responses.length, 3));
  assert.deepEqual(responses[2], { id: "flush", result: { ok: true, revision: 2 } });
  assert.deepEqual(updates.at(-1), { revision: 2, patches: [{ path: ["actionError"], value: "saved before exit" }] });
});

test("startup failure becomes readable state and releases requests waiting for readiness", async () => {
  vi.resetModules();
  let state = emptyWorkspaceState();
  let publish!: () => void;
  const updates: WorkspaceUpdate[] = [];
  const ready = vi.fn();
  runtimeFactory.create.mockReturnValue({
    getState: () => state,
    subscribe: (listener: () => void) => { publish = listener; },
    start: async () => { throw new Error("Storage unavailable"); },
    dispatch: async () => { state = { ...state, storageError: "Storage unavailable" }; publish(); },
  });
  window.workspace = {
    owner: true,
    onRequest: () => () => {},
    publish: (update: WorkspaceUpdate) => updates.push(update),
    ready,
  } as unknown as WorkspaceBridge;
  await import("../../src/renderer/workspace-runtime-entry.ts");
  await vi.waitFor(() => assert.equal(ready.mock.calls.length, 1));
  assert.deepEqual(updates.at(-1), { revision: 1, patches: [{ path: ["storageError"], value: "Storage unavailable" }] });
});
