import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunChannel } from "../../../src/contracts/ipc.ts";
import type { ExecutionPolicy } from "../../../src/domain/run.ts";
import { grantsTool, type ApprovalScope, type ToolReach } from "../../../src/main/agent/approval-grant.mts";
import { codexConfig } from "../../../src/main/codex/codex-config.mts";
import { liveTurn } from "../../support/claude-session.mjs";

const policies: readonly ExecutionPolicy[] = ["confirm", "plan", "allow-edits", "autonomous", "bypass"];
const channels: readonly RunChannel[] = ["main", "side"];
const computerUse = { status: "available" as const, mcp: { command: "/app/cua-driver", args: ["mcp", "--embedded"], env: { CUA_DRIVER_EMBEDDED: "1" } } };

type Row = { scope?: ApprovalScope; reach: ToolReach; granted: boolean };

const scope = (policy: ExecutionPolicy, channel: RunChannel): ApprovalScope => ({ policy, channel });

/** Every policy and channel against every reach, written out rather than derived. */
const table: readonly Row[] = [
  { reach: "app", granted: true },
  { reach: "computer-use", granted: false },
  { reach: "workspace", granted: false },

  { scope: scope("confirm", "main"), reach: "app", granted: true },
  { scope: scope("confirm", "main"), reach: "computer-use", granted: false },
  { scope: scope("confirm", "main"), reach: "workspace", granted: false },
  { scope: scope("confirm", "side"), reach: "app", granted: true },
  { scope: scope("confirm", "side"), reach: "computer-use", granted: false },
  { scope: scope("confirm", "side"), reach: "workspace", granted: false },

  { scope: scope("plan", "main"), reach: "app", granted: true },
  { scope: scope("plan", "main"), reach: "computer-use", granted: false },
  { scope: scope("plan", "main"), reach: "workspace", granted: false },
  { scope: scope("plan", "side"), reach: "app", granted: true },
  { scope: scope("plan", "side"), reach: "computer-use", granted: false },
  { scope: scope("plan", "side"), reach: "workspace", granted: false },

  { scope: scope("allow-edits", "main"), reach: "app", granted: true },
  { scope: scope("allow-edits", "main"), reach: "computer-use", granted: false },
  { scope: scope("allow-edits", "main"), reach: "workspace", granted: false },
  { scope: scope("allow-edits", "side"), reach: "app", granted: true },
  { scope: scope("allow-edits", "side"), reach: "computer-use", granted: false },
  { scope: scope("allow-edits", "side"), reach: "workspace", granted: false },

  { scope: scope("autonomous", "main"), reach: "app", granted: true },
  { scope: scope("autonomous", "main"), reach: "computer-use", granted: true },
  { scope: scope("autonomous", "main"), reach: "workspace", granted: false },
  { scope: scope("autonomous", "side"), reach: "app", granted: true },
  { scope: scope("autonomous", "side"), reach: "computer-use", granted: false },
  { scope: scope("autonomous", "side"), reach: "workspace", granted: false },

  { scope: scope("bypass", "main"), reach: "app", granted: true },
  { scope: scope("bypass", "main"), reach: "computer-use", granted: true },
  { scope: scope("bypass", "main"), reach: "workspace", granted: true },
  { scope: scope("bypass", "side"), reach: "app", granted: true },
  { scope: scope("bypass", "side"), reach: "computer-use", granted: true },
  { scope: scope("bypass", "side"), reach: "workspace", granted: true },
];

test("a policy and a channel decide what runs without approval", () => {
  for (const row of table) {
    const where = `${row.scope ? `${row.scope.policy} on ${row.scope.channel}` : "no run"} · ${row.reach}`;
    assert.equal(grantsTool(row.reach, row.scope), row.granted, where);
  }
});

/** What Codex spawns its server with: computer use is pre-approved only where the grant says so. */
function codexGrantsComputerUse(policy: ExecutionPolicy, channel: RunChannel) {
  const args = codexConfig({ channel, policy, computerUse }, undefined);
  return args.includes("mcp_servers.cua-driver.default_tools_approval_mode=\"approve\"");
}

/** What Claude's tool gate answers, and whether it asked the run's approval to answer it. */
async function claudeGrants(policy: ExecutionPolicy, channel: RunChannel, toolName: string) {
  const asked: string[] = [];
  const live = await liveTurn({ policy, channel, computerUse, authorize: async (intent) => { asked.push(intent.name); return "deny"; } });
  try {
    const decision = await live.canUseTool(toolName, {}, { toolUseID: toolName, signal: new AbortController().signal, requestId: toolName });
    assert.ok(decision);
    return decision.behavior === "allow" && asked.length === 0;
  } finally {
    await live.end();
  }
}

test("both engines grant the same tools for the same policy and channel", async () => {
  for (const policy of policies) {
    for (const channel of channels) {
      const where = `${policy} on ${channel}`;
      const computer = grantsTool("computer-use", scope(policy, channel));
      assert.equal(await claudeGrants(policy, channel, "mcp__cua-driver__click"), computer, `claude computer use · ${where}`);
      assert.equal(codexGrantsComputerUse(policy, channel), computer, `codex computer use · ${where}`);

      const workspace = grantsTool("workspace", scope(policy, channel));
      assert.equal(await claudeGrants(policy, channel, "Bash"), workspace, `claude workspace · ${where}`);
    }
  }
});
