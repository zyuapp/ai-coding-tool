import assert from "node:assert/strict";
import { test } from "vitest";
import { TerminalOutputBuffer } from "../../src/main/terminal-output-buffer.ts";

test("a slow viewer restores a snapshot when output exceeds the shared buffer", () => {
  const buffer = new TerminalOutputBuffer();
  for (let sequence = 1; sequence <= 5; sequence++) buffer.push({ terminalId: "t", sequence, data: "x".repeat(512 * 1024) });
  assert.equal(buffer.read(1, 5), null);
  assert.equal(buffer.read(4, 5)?.length, 512 * 1024);
  assert.equal(buffer.read(5, 5), "");
  buffer.reset();
  assert.equal(buffer.read(5, 6), null, "resize invalidates deltas from the old grid");
  for (let sequence = 7; sequence <= 200; sequence++) buffer.push({ terminalId: "t", sequence, data: "x" });
  assert.equal(buffer.read(6, 200), null, "small writes also have a bounded entry count");
});
