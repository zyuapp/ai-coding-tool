import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { RemoteTerminalOutput } from "../../src/renderer/task-workspace/remote-terminal-output.ts";
import type { TerminalOutputRead } from "../../src/contracts/terminal.ts";

const frame = (sequence: number, kind: "snapshot" | "output" = "snapshot"): TerminalOutputRead => ({ kind, sequence, data: `${sequence}`, cols: 80, rows: 24 });

test("a remote view waits for painting, resumes at the watermark, and ignores replies after hiding", async () => {
  const requests: Array<{ after?: number; reply: ReturnType<typeof Promise.withResolvers<TerminalOutputRead | null>> }> = [];
  const drawn: number[] = [];
  const painted = Promise.withResolvers<void>();
  const output = new RemoteTerminalOutput((after) => {
    const reply = Promise.withResolvers<TerminalOutputRead | null>();
    requests.push({ after, reply });
    return reply.promise;
  }, async (read) => { drawn.push(read.sequence); await painted.promise; });
  output.start(() => {});
  requests[0].reply.resolve(frame(4));
  await Promise.resolve();
  assert.equal(requests.length, 1, "rendering applies backpressure");
  painted.resolve();
  await vi.waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[1].after, 4);
  assert.equal(output.live, true);
  output.stop();
  requests[1].reply.resolve(frame(5, "output"));
  await Promise.resolve();
  assert.deepEqual(drawn, [4]);
  assert.equal(output.live, false);
  output.start(() => {});
  assert.equal(requests[2].after, undefined, "reopening restores the host screen");
  output.stop();
  requests[2].reply.resolve(null);
});

test("a dropped read disables input and retries from a fresh screen", async () => {
  vi.useFakeTimers();
  try {
    const afters: Array<number | undefined> = [];
    const errors: Array<string | null> = [];
    const pending = Promise.withResolvers<TerminalOutputRead | null>();
    const output = new RemoteTerminalOutput(async (after) => {
      afters.push(after);
      if (afters.length === 1) return frame(9);
      if (afters.length === 2) throw new Error("Disconnected");
      return pending.promise;
    }, async () => {});
    output.start((error) => errors.push(error));
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(output.live, false);
    assert.deepEqual(errors, ["Connecting…", null, "Disconnected"]);
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(afters, [undefined, 9, undefined]);
    output.stop();
    pending.resolve(null);
  } finally { vi.useRealTimers(); }
});
