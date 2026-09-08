import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, harness, input, opened, sentBy, tick, turn } from "../../support/codex-client.mjs";

const at = { threadId: "thread-1", turnId: "turn-1" };
const image: ThreadItem = { type: "imageGeneration", id: "image-1", status: "completed", revisedPrompt: "Cat", result: "image bytes", failure: null };

test("image generation reports progress and waits for a durable artifact before the run completes", async () => {
  const events: ProviderEvent[] = [];
  let saved!: (text: string) => void;
  let saves = 0;
  const codex = harness({}, { imageOutput: (item, root) => {
    assert.equal(item.id, image.id);
    assert.equal(root, "/tmp/project");
    saves += 1;
    return new Promise((resolve) => { saved = resolve; });
  } });
  let finished = false;
  const running = turn(codex, { emit: (event) => events.push(event) }, (client) => {
    client.notify("item/started", { ...at, item: { ...image, status: "in_progress" }, startedAtMs: 1 });
    client.notify("item/completed", { ...at, item: image, completedAtMs: 2 });
    client.notify("item/completed", { ...at, item: image, completedAtMs: 2 });
  }).then((result) => { finished = true; return result; });
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  await tick();
  assert.equal(finished, false);
  assert.equal(saves, 1);
  assert.deepEqual(events.filter((event) => event.type === "tool"), [{ type: "tool", intent: { toolId: image.id, name: "image_generation", input: { description: "Generating image" } } }]);
  saved("[Generated image](/tmp/cat.png)");
  assert.deepEqual((await running).result, { status: "succeeded" });
  assert.deepEqual(events.filter((event) => event.type === "assistant"), [{ type: "assistant", messageId: image.id, text: "[Generated image](/tmp/cat.png)", artifact: true }]);
  codex.provider.closeAll();
});

test("a failure to save an image stays visible as an artifact failure", async () => {
  const events: ProviderEvent[] = [];
  const codex = harness({}, { imageOutput: async () => { throw new Error("Disk full"); } });
  await turn(codex, { emit: (event) => events.push(event) }, (client) => {
    client.notify("item/completed", { ...at, item: image, completedAtMs: 2 });
  });
  assert.deepEqual(events.filter((event) => event.type === "assistant"), [{ type: "assistant", messageId: image.id, text: "The generated image could not be saved or displayed.", artifact: true }]);
  codex.provider.closeAll();
});

test("an image finishing after cancellation does not enter a later run", async () => {
  const events: ProviderEvent[] = [];
  let saved!: (text: string) => void;
  const codex = harness({}, { imageOutput: () => new Promise((resolve) => { saved = resolve; }) });
  const abortController = new AbortController();
  const running = codex.provider.execute(input({ abortController, emit: (event) => events.push(event) }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  client.notify("item/completed", { ...at, item: image, completedAtMs: 2 });
  abortController.abort();
  saved("[Generated image](/tmp/cat.png)");
  completeTurn(client);
  assert.deepEqual(await running, { status: "cancelled" });
  assert.equal(events.some((event) => event.type === "assistant"), false);
  codex.provider.closeAll();
});
