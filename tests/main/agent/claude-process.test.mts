import assert from "node:assert/strict";
import type { Options, Query, query } from "@anthropic-ai/claude-agent-sdk";
import { test, vi } from "vitest";
import { ClaudeAgentProvider, discoverClaudeCommands, discoverClaudeModels } from "../../../src/main/agent/claude-agent-provider.mts";
import { readPlanUsage } from "../../../src/main/agent/plan-usage.mts";
import { suggestTaskTitle } from "../../../src/main/agent/title-writer.mts";
import { input } from "../../support/claude-session.mjs";

test("every Claude process names this app in place of an inherited name and keeps the rest of the environment", async () => {
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "claude-desktop");
  vi.stubEnv("AICODINGTOOL_ENV_PROBE", "kept");
  try {
    const seen: (Options["env"] | undefined)[] = [];
    const factory: typeof query = ({ options }) => {
      seen.push(options?.env);
      return { supportedCommands: async () => [], supportedModels: async () => [], close: () => {}, async *[Symbol.asyncIterator]() {} } as unknown as Query;
    };
    await discoverClaudeCommands("/tmp/project", false, factory);
    await discoverClaudeModels(factory);
    await suggestTaskTitle("name this", [], factory);
    await readPlanUsage(factory);
    await new ClaudeAgentProvider(factory).execute(input({}));

    assert.equal(seen.length, 5);
    for (const env of seen) {
      assert.equal(env?.CLAUDE_CODE_ENTRYPOINT, "aicodingtool");
      assert.equal(env?.AICODINGTOOL_ENV_PROBE, "kept");
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
