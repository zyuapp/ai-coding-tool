import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { completeTurn, harness, input, opened, sentBy } from "../../support/codex-client.mjs";

const at = { threadId: "thread-1", turnId: "turn-1" };

test("an error the server will retry shows as a retry and does not fail the turn", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  const running = codex.provider.execute(input({ emit: (event) => emitted.push(event) }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  client.notify("error", { ...at, error: { message: "server overloaded", codexErrorInfo: "serverOverloaded", additionalDetails: null, misalignment: null }, willRetry: true });
  client.notify("error", { ...at, error: { message: "stream disconnected\ndetails", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null, misalignment: null }, willRetry: true });
  client.notify("error", { ...at, error: { message: "something odd\nmore", codexErrorInfo: "other", additionalDetails: null, misalignment: null }, willRetry: true });
  completeTurn(client);
  assert.deepEqual(await running, { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type === "retry"), [
    { type: "retry", message: "Codex is overloaded." },
    { type: "retry", message: "Cannot reach Codex." },
    { type: "retry", message: "something odd" },
  ]);
  codex.provider.closeAll();
});
