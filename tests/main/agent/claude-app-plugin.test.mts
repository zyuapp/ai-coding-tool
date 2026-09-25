import assert from "node:assert/strict";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { test } from "vitest";
import { ClaudeAgentProvider, discoverClaudeCommands } from "../../../src/main/agent/claude-agent-provider.mts";
import { setAppPluginRoot } from "../../../src/main/app-plugin.mts";
import { input, queryFactory, type QueryCapture } from "../../support/claude-session.mjs";

function optionsOf(capture: QueryCapture): Options {
  assert.ok(capture.options);
  return capture.options.options ?? {};
}

test("the app's plugin rides every Claude session, and its skills are offered by their short names", async () => {
  setAppPluginRoot("/app/resources/app-plugin");
  try {
    const capture: QueryCapture = {};
    const commands = await discoverClaudeCommands("/tmp/project", false, (options) => {
      capture.options = options;
      return {
        supportedCommands: async () => [
          { name: "aicodingtool:review-thread", description: "(aicodingtool) Review this thread's work.", argumentHint: "[focus]", aliases: ["review-thread"] },
          { name: "pdf", description: "Work with PDFs", argumentHint: "<file>" },
        ],
        close: () => { capture.closed = true; },
      } as unknown as Query;
    });
    assert.deepEqual(commands, [
      { name: "review-thread", description: "Review this thread's work.", argumentHint: "[focus]" },
      { name: "pdf", description: "Work with PDFs", argumentHint: "<file>" },
    ]);
    assert.deepEqual(optionsOf(capture).plugins, [{ type: "local", path: "/app/resources/app-plugin" }]);

    const run: QueryCapture = {};
    await new ClaudeAgentProvider(queryFactory([], run)).execute(input());
    assert.deepEqual(optionsOf(run).plugins, [{ type: "local", path: "/app/resources/app-plugin" }]);
  } finally {
    setAppPluginRoot(undefined);
  }

  const capture: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(input());
  assert.equal(optionsOf(capture).plugins, undefined, "without a plugin root, Claude is offered no plugin at all");
});

