import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  const title = await suggestTaskTitle("Inspect the app and tell me what breaks", [], queryFactory(result('"App breakage review."'), capture));

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
  const title = await suggestTaskTitle("x".repeat(5_000), [], queryFactory(result("A".repeat(80)), capture));

  assert.equal(title, `${"A".repeat(49)}…`);
  assert.equal(capture.prompt.includes("x".repeat(2_000)), true);
  assert.equal(capture.prompt.includes("x".repeat(2_001)), false);
});

test("a thread keeps the title it already has when naming produces nothing", async () => {
  assert.equal(await suggestTaskTitle("hi", [], queryFactory(result("  "))), null);
  assert.equal(await suggestTaskTitle("hi", [], queryFactory([{ type: "result", subtype: "error_during_execution", errors: ["nope"] }])), null);
  assert.equal(await suggestTaskTitle("hi", [], queryFactory([])), null);
  assert.equal(await suggestTaskTitle("hi", [], () => ({
    async *[Symbol.asyncIterator]() { throw new Error("agent is unavailable"); },
    close() {},
  })), null);
});

test("a screenshot reaches the namer as bytes, and an unreadable one is left out", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-writer-"));
  const shot = path.join(directory, "shot.png");
  await writeFile(shot, Buffer.from("screenshot bytes"));

  const capture = {};
  const title = await suggestTaskTitle("", [shot, path.join(directory, "missing.png")], queryFactory(result("Sidebar overlap"), capture));

  assert.equal(title, "Sidebar overlap");
  const [message] = await Array.fromAsync(capture.prompt);
  assert.deepEqual(message.message.content.map((block) => block.type), ["image", "text"]);
  assert.equal(message.message.content[0].source.data, Buffer.from("screenshot bytes").toString("base64"));
  assert.match(message.message.content[1].text, /screenshots/);
});

test("a message with no screenshot that can be read stays a plain string prompt", async () => {
  const capture = {};
  await suggestTaskTitle("Inspect the app", ["/nowhere/shot.png"], queryFactory(result("App review"), capture));

  assert.equal(typeof capture.prompt, "string");
});
