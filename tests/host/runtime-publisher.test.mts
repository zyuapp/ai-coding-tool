import assert from "node:assert/strict";
import { test } from "vitest";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceUpdate } from "../../src/contracts/workspace-runtime.ts";
import { createRuntimePublisher } from "../../src/host/runtime-publisher.ts";
import type { WorkspaceRuntime } from "../../src/host/workspace-runtime.ts";

function fakeRuntime() {
  let state = emptyWorkspaceState();
  const listeners = new Set<() => void>();
  const refused = { ok: false as const, message: "Cannot move a running thread" };
  const flushed = Promise.withResolvers<void>();
  const runtime = {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    execute: () => ({ accepted: refused, completed: Promise.resolve(refused) }),
    flush: () => flushed.promise,
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    refused,
    flushed,
    set: (next: typeof state) => { state = next; for (const listener of listeners) listener(); },
  };
}

test("the publisher numbers what changed, batches one turn's commits, and answers requests at the revision they left", async () => {
  const fake = fakeRuntime();
  const publisher = createRuntimePublisher(fake.runtime);
  const updates: WorkspaceUpdate[] = [];
  publisher.subscribe((update) => updates.push(update));
  fake.set({ ...fake.runtime.getState(), actionError: "first" });
  fake.set({ ...fake.runtime.getState(), actionError: "second" });
  assert.equal(updates.length, 0);
  await Promise.resolve();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { revision: 1, patches: [{ path: ["actionError"], value: "second" }] });

  assert.deepEqual(await publisher.request({ type: "task.move-worktree", destination: { kind: "local" } }), { ...fake.refused, revision: 1 });
  assert.deepEqual(publisher.snapshot(), { revision: 1, state: fake.runtime.getState() });

  const flushing = publisher.flush();
  fake.set({ ...fake.runtime.getState(), actionError: "saved before exit" });
  fake.flushed.resolve();
  assert.deepEqual(await flushing, { ok: true, revision: 2 });
  assert.deepEqual(updates.at(-1), { revision: 2, patches: [{ path: ["actionError"], value: "saved before exit" }] });
  publisher.dispose();
  fake.set({ ...fake.runtime.getState(), actionError: "after disposal" });
  await Promise.resolve();
  assert.equal(updates.length, 2, "a disposed publisher tells nobody anything");
});
