import assert from "node:assert/strict";
import type { Options, Query, query } from "@anthropic-ai/claude-agent-sdk";
import { test, vi } from "vitest";
import { ClaudeAgentProvider, discoverClaudeCommands, discoverClaudeModels } from "../../../src/main/claude/claude-agent-provider.mts";
import { readPlanUsage } from "../../../src/main/claude/claude-plan-usage.mts";
import { suggestTaskTitle } from "../../../src/main/claude/claude-title-writer.mts";
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
    await new ClaudeAgentProvider({ queryFactory: factory }).execute(input({}));

    assert.equal(seen.length, 5);
    for (const env of seen) {
      assert.equal(env?.CLAUDE_CODE_ENTRYPOINT, "aicodingtool");
      assert.equal(env?.CLAUDE_CODE_DISABLE_ARTIFACT, "1");
      assert.equal(env?.AICODINGTOOL_ENV_PROBE, "kept");
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the observable Claude spawner drains large stderr and retains its final exit diagnostic", async () => {
  const factory: typeof query = ({ options }) => ({
    async *[Symbol.asyncIterator]() {
      const child = options!.spawnClaudeCodeProcess!({ command: process.execPath, args: ["-e", "process.stderr.write('x'.repeat(512*1024)+'\\nfinal diagnostic');process.exitCode=7"], env: { ...process.env }, signal: new AbortController().signal });
      child.stdout.resume();
      const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      throw new Error(`Claude Code process exited with code ${code}`);
    },
    close() {},
  }) as unknown as Query;
  const provider = new ClaudeAgentProvider({ queryFactory: factory });
  try {
    const result = await provider.execute(input());
    assert.equal(result.status, "failed");
    assert.match(result.message ?? "", /exited with code 7\. stderr:/);
    assert.match(result.message ?? "", /final diagnostic$/);
    assert.ok(result.message!.length < 8500, "diagnostics stay bounded");
  } finally { provider.closeAll(); }
});
