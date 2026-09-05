import assert from "node:assert/strict";
import { test } from "vitest";
import { TerminalOutput } from "../../src/renderer/task-workspace/terminal-output.ts";
import type { TerminalScreenSnapshot } from "../../src/contracts/ipc.ts";

const snapshot = (sequence: number, data = "snapshot"): TerminalScreenSnapshot => ({ sequence, data, cols: 80, rows: 24 });

test("a reload restores output once and orders newer live chunks after its snapshot", async () => {
  const reply = Promise.withResolvers<TerminalScreenSnapshot | null>();
  const writes: string[] = [];
  const output = new TerminalOutput(() => reply.promise, (value) => writes.push(value.data), (data) => writes.push(data));
  output.push({ terminalId: "t", sequence: 1, data: "old" });
  const loading = output.start();
  output.push({ terminalId: "t", sequence: 2, data: "captured" });
  output.push({ terminalId: "t", sequence: 3, data: "new" });
  assert.deepEqual(writes, []);
  reply.resolve(snapshot(2));
  await loading;
  output.push({ terminalId: "t", sequence: 3, data: "duplicate" });
  output.push({ terminalId: "t", sequence: 4, data: "latest" });
  assert.deepEqual(writes, ["snapshot", "new", "latest"]);
});

test("overflow requests a newer bounded snapshot before releasing live output", async () => {
  const first = Promise.withResolvers<TerminalScreenSnapshot | null>();
  const second = Promise.withResolvers<TerminalScreenSnapshot | null>();
  let requests = 0;
  const writes: string[] = [];
  const output = new TerminalOutput(() => ++requests === 1 ? first.promise : second.promise, (value) => writes.push(value.data), (data) => writes.push(data));
  const loading = output.start();
  for (let sequence = 1; sequence <= 50; sequence++) output.push({ terminalId: "t", sequence, data: "x".repeat(512 * 1024) });
  first.resolve(snapshot(1));
  await Promise.resolve();
  assert.equal(requests, 2);
  assert.deepEqual(writes, []);
  output.push({ terminalId: "t", sequence: 51, data: "after" });
  second.resolve(snapshot(50, "recovered"));
  await loading;
  assert.deepEqual(writes, ["recovered", "after"]);
});

test("a failed snapshot retries without losing queued output and disposal ignores late replies", async () => {
  let requests = 0;
  const writes: string[] = [];
  const output = new TerminalOutput(async () => { if (++requests === 1) throw new Error("reload"); return snapshot(1); }, (value) => writes.push(value.data), (data) => writes.push(data));
  output.push({ terminalId: "t", sequence: 2, data: "new" });
  await assert.rejects(output.start(), /reload/);
  await output.start();
  assert.deepEqual(writes, ["snapshot", "new"]);
  const reply = Promise.withResolvers<TerminalScreenSnapshot | null>();
  const disposed = new TerminalOutput(() => reply.promise, () => assert.fail("restored disposed terminal"), () => assert.fail("wrote disposed terminal"));
  const loading = disposed.start();
  disposed.dispose();
  reply.resolve(snapshot(5));
  await loading;
});
