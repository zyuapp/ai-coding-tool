import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { test } from "vitest";
import { suggestTaskTitle } from "../src/main/agent/title-writer.mts";

type QueryCapture = { prompt?: string | AsyncIterable<SDKUserMessage>; options?: Options; closed?: boolean };

function queryFactory(messages: readonly unknown[], capture: QueryCapture = {}): typeof query {
  return ({ prompt, options }): Query => {
    capture.prompt = prompt;
    capture.options = options;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message as SDKMessage;
      },
      close() {
        capture.closed = true;
      },
    } as unknown as Query;
  };
}

function result(text: string) {
  return [{ type: "result", subtype: "success", is_error: false, result: text }];
}

test("naming a thread reaches nothing on the machine and returns a clean title", async () => {
  const capture: QueryCapture = {};
  const title = await suggestTaskTitle("Inspect the app and tell me what breaks", [], queryFactory(result('"App breakage review."'), capture));

  assert.equal(title, "App breakage review");
  assert.ok(capture.options);
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
  const capture: QueryCapture = {};
  const title = await suggestTaskTitle("x".repeat(5_000), [], queryFactory(result("A".repeat(80)), capture));

  assert.equal(title, `${"A".repeat(49)}…`);
  assert.ok(typeof capture.prompt === "string");
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
  } as unknown as Query)), null);
});

test("a screenshot reaches the namer as bytes, and an unreadable one is left out", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-writer-"));
  const shot = path.join(directory, "shot.png");
  await writeFile(shot, Buffer.from("screenshot bytes"));

  const capture: QueryCapture = {};
  const title = await suggestTaskTitle("", [shot, path.join(directory, "missing.png")], queryFactory(result("Sidebar overlap"), capture));

  assert.equal(title, "Sidebar overlap");
  assert.ok(capture.prompt && typeof capture.prompt !== "string");
  const { value: message } = await capture.prompt[Symbol.asyncIterator]().next();
  assert.ok(message && Array.isArray(message.message.content));
  const [image, text] = message.message.content;
  assert.deepEqual([image?.type, text?.type], ["image", "text"]);
  assert.ok(image?.type === "image" && image.source.type === "base64");
  assert.equal(image.source.data, Buffer.from("screenshot bytes").toString("base64"));
  assert.ok(text?.type === "text");
  assert.match(text.text, /screenshots/);
});

test("a message with no screenshot that can be read stays a plain string prompt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-writer-large-"));
  const oversized = path.join(directory, "large.png");
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
  const capture: QueryCapture = {};
  await suggestTaskTitle("Inspect the app", ["/nowhere/shot.png", oversized], queryFactory(result("App review"), capture));

  assert.equal(typeof capture.prompt, "string");
});
