import assert from "node:assert/strict";
import { test } from "vitest";
import { endMarkdown, streamMarkdown, type MarkdownBuffer } from "../../../src/main/agent/markdown-buffer.mts";
import { OpenFailure, reasonOf, serveTools } from "../../../src/main/agent/session-common.mts";
import { needsSideChatBoundary } from "../../../src/main/agent/side-chat-instructions.mts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import type { ServedTools, ToolHost } from "../../../src/main/tools/mcp-http-host.mts";
import type { ServedToolSet } from "../../../src/main/agent/run-tools.mts";
import { input } from "../../support/claude-session.mjs";

function host(log: string[]): ToolHost {
  return {
    async serve(tools): Promise<ServedTools> {
      log.push(`serve ${tools.length}`);
      return { url: "http://127.0.0.1:1/mcp", token: "t", release: () => { log.push("release"); } } as ServedTools;
    },
  } as ToolHost;
}

test("a reason is the error's first line", () => {
  assert.equal(reasonOf(new Error("refused\nat stack")), "refused");
  assert.equal(reasonOf("plain"), "plain");
});

test("tools are served only to a run offered some, and given back by a session that ended meanwhile", async () => {
  const log: string[] = [];
  const sets = [{ server: "aicodingtool-threads", tools: [{}, {}] }] as unknown as ServedToolSet[];
  assert.equal(await serveTools(host(log), [], () => false, "ended"), null);
  assert.deepEqual(log, []);

  assert.ok(await serveTools(host(log), sets, () => false, "ended"));
  assert.deepEqual(log, ["serve 2"]);

  await assert.rejects(serveTools(host(log), sets, () => true, "The session ended."), (error) => error instanceof OpenFailure && error.message === "The session ended." && !error.lost);
  assert.deepEqual(log, ["serve 2", "serve 2", "release"]);
});

test("a streamed message ships whole blocks and its tail, then only what was left", () => {
  const events: ProviderEvent[] = [];
  const run = { emit: (event: ProviderEvent) => events.push(event) };
  const buffers = new Map<string, MarkdownBuffer>();
  streamMarkdown(buffers, run, "m", "One.\n\nTw");
  endMarkdown(buffers, run, "m", "One.\n\nTwo.");
  endMarkdown(buffers, run, "whole", "Arrived whole.");
  endMarkdown(buffers, run, "blank", "  ");
  assert.deepEqual(events, [
    { type: "assistant", messageId: "m", text: "One.\n\n", append: true },
    { type: "assistant-tail", messageId: "m", text: "Tw" },
    { type: "assistant", messageId: "m", text: "Tw", append: true },
    { type: "assistant", messageId: "whole", text: "Arrived whole." },
  ]);
  assert.equal(buffers.size, 0);
});

test("a side chat takes the boundary as it opens on a conversation of its own", () => {
  assert.equal(needsSideChatBoundary(input({ channel: "side" })), true);
  assert.equal(needsSideChatBoundary(input({ channel: "side", continuation: { provider: "claude", value: "s" }, forkContinuation: true })), true);
  assert.equal(needsSideChatBoundary(input({ channel: "side", continuation: { provider: "claude", value: "s" } })), false, "a side chat it already opened has it");
  assert.equal(needsSideChatBoundary(input({ channel: "side", continuation: { provider: "codex", value: "t" } })), true, "another engine's continuation is no conversation of this one's");
  assert.equal(needsSideChatBoundary(input()), false);
});
