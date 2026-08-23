import assert from "node:assert/strict";
import { test } from "vitest";
import type { TaskStoreDelta } from "../src/contracts/ipc.ts";
import type { Task } from "../src/domain/task.ts";
import {
  drainLatestPersistence,
  type PersistenceQueue,
  type PersistenceState,
} from "../src/renderer/task-workspace/workspace-persistence.ts";

function snapshot(text: string): PersistenceState {
  const task: Task = {
    id: "task-1",
    title: "Task",
    executionPolicy: "confirm",
    messages: [{ id: "message-1", kind: "assistant", text, at: 1 }],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
  return { tasks: [task], sideChats: [], projects: [], worktrees: [], lastFolder: null };
}

test("slow persistence keeps only the latest workspace snapshot queued", async () => {
  const queue: PersistenceQueue = { persisted: null, pending: snapshot("one"), inFlight: false };
  const firstWrite = Promise.withResolvers<void>();
  const deltas: TaskStoreDelta[] = [];
  const draining = drainLatestPersistence(queue, async (delta) => {
    deltas.push(delta);
    if (deltas.length === 1) await firstWrite.promise;
  });
  await Promise.resolve();

  queue.pending = snapshot("one two");
  queue.pending = snapshot("one two three");
  await drainLatestPersistence(queue, async () => assert.fail("a second drain must not start"));
  assert.equal(deltas.length, 1);

  firstWrite.resolve();
  await draining;
  assert.equal(deltas.length, 2);
  assert.equal(deltas[1].tasks[0].messages[0].message.text, "one two three");
});
