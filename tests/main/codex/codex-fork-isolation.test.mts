import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, harness, input, opened, sentBy, tick } from "../../support/codex-client.mjs";

test("a side chat ignores foreign conversation events while its fork is opening", async () => {
  let finishFork!: (value: unknown) => void;
  const codex = harness({ "thread/fork": () => new Promise((resolve) => { finishFork = resolve; }) });
  const events: ProviderEvent[] = [];
  let settled = false;
  const running = codex.provider.execute(input({
    channel: "side",
    continuation: { provider: "codex", value: "main-thread" },
    forkContinuation: true,
    emit: (event) => events.push(event),
  })).then((result) => { settled = true; return result; });
  const client = await opened(codex);
  await sentBy(client, "thread/fork");
  const item: ThreadItem = { type: "mcpToolCall", id: "main-tool", server: "aicodingtool", tool: "read_thread", arguments: {}, status: "inProgress", appContext: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null };
  client.notify("item/started", { threadId: "main-thread", turnId: "main-turn", item, startedAtMs: 1 });
  client.notify("item/completed", { threadId: "main-thread", turnId: "main-turn", item: { ...item, status: "completed" }, completedAtMs: 2 });
  client.notify("turn/completed", { threadId: "main-thread", turn: { id: "main-turn", status: "completed", items: [], itemsView: "summary", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });
  await tick();
  const beforeOpened = [...events];
  const settledBeforeOpened = settled;
  finishFork({ thread: { id: "side-thread" } });
  await tick();
  if (!settled) {
    await sentBy(client, "turn/start");
    completeTurn(client);
  }
  await running;
  codex.provider.closeAll();
  assert.deepEqual(beforeOpened, []);
  assert.equal(settledBeforeOpened, false);
});
