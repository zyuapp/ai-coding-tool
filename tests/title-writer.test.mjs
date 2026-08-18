import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { suggestTaskTitle } from "../dist/main/main/agent/title-writer.mjs";

function queryFactory(messages, capture = {}) {
  return ({ prompt, options }) => {
    capture.prompt = prompt;
    capture.options = options;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      close() {
        capture.closed = true;
      },
    };
  };
}

function result(text) {
  return [{ type: "result", subtype: "success", is_error: false, result: text }];
}

test("naming a thread reaches nothing on the machine and returns a clean title", async () => {
  const capture = {};
  const title = await suggestTaskTitle("Inspect the app and tell me what breaks", queryFactory(result('"App breakage review."'), capture));

  assert.equal(title, "App breakage review");
  assert.equal(capture.options.model, "haiku");
  assert.equal(capture.options.cwd, os.tmpdir());
  assert.deepEqual(capture.options.settingSources, []);
  assert.deepEqual(capture.options.tools, []);
  assert.equal(typeof capture.options.systemPrompt, "string", "a string prompt replaces the Claude Code preset");
  assert.equal(capture.options.mcpServers, undefined);
  assert.equal(capture.options.maxTurns, 1);
  assert.equal(capture.closed, true);
});

test("a title longer than a row is clipped, and a message longer than the limit is trimmed", async () => {
  const capture = {};
  const title = await suggestTaskTitle("x".repeat(5_000), queryFactory(result("A".repeat(80)), capture));

  assert.equal(title, `${"A".repeat(49)}…`);
  assert.equal(capture.prompt.includes("x".repeat(2_000)), true);
  assert.equal(capture.prompt.includes("x".repeat(2_001)), false);
});

test("a thread keeps the title it already has when naming produces nothing", async () => {
  assert.equal(await suggestTaskTitle("hi", queryFactory(result("  "))), null);
  assert.equal(await suggestTaskTitle("hi", queryFactory([{ type: "result", subtype: "error_during_execution", errors: ["nope"] }])), null);
  assert.equal(await suggestTaskTitle("hi", queryFactory([])), null);
  assert.equal(await suggestTaskTitle("hi", () => ({
    async *[Symbol.asyncIterator]() { throw new Error("agent is unavailable"); },
    close() {},
  })), null);
});
