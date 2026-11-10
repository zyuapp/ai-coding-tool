import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { AGENT_ENGINES, BUILT_IN_MODELS, capabilitiesFor, defaultEffortFor, defaultModelFor, engineHasModel, engineLabel, isAgentEffort, modelsFor, policyFor, type AgentEngine } from "../../../src/domain/agent-engine.ts";
import { POLICY_CHOICES, type ExecutionPolicy } from "../../../src/domain/run.ts";
import { describeToolCall, toolFamily } from "../../../src/domain/tool-call.ts";
import type { ProviderResult } from "../../../src/main/agent/agent-provider.mts";
import { SessionPool, type PooledSession, type SessionHooks } from "../../../src/main/agent/session-pool.mts";
import { claudePermissionMode } from "../../../src/main/claude/claude-session.mts";
import { codexPolicy } from "../../../src/main/codex/codex-policy.mts";
import { ENGINE_MODULES, engineProviders } from "../../../src/main/engines.mts";
import { agentFor, permissionRules } from "../../../src/main/opencode/opencode-policy.mts";
import { FakeToolHost, input } from "../../support/codex-client.mjs";

/** What each engine runs a mode as. */
const POLICY_MAPPINGS: Record<AgentEngine, (policy: ExecutionPolicy) => unknown> = {
  claude: claudePermissionMode,
  codex: (policy) => codexPolicy(policy),
  opencode: (policy) => ({ agent: agentFor(policy), rules: permissionRules({ policy, channel: "main" }, [], false) }),
};

const EVERY_POLICY: readonly ExecutionPolicy[] = [...POLICY_CHOICES, "plan"];

/** A session no engine here opens, standing in for another engine's in the shared pool. */
class ForeignSession implements PooledSession {
  live = true;
  busy = false;
  answering = false;
  constructor(readonly key: string, private readonly hooks: SessionHooks) {}
  continues() {
    return true;
  }
  async run(): Promise<ProviderResult> {
    return { status: "succeeded" };
  }
  close() {
    this.live = false;
    this.hooks.ended();
  }
}

async function providers() {
  const pool = new SessionPool();
  return { pool, providers: await engineProviders({ host: new FakeToolHost(), pool }) };
}

describe.each(AGENT_ENGINES)("the %s engine", (engine) => {
  test("describes its command, its services and how its provider is built", () => {
    const { binary, services, createProvider } = ENGINE_MODULES[engine];
    for (const field of [binary.command, binary.packageName, binary.install]) assert.ok(typeof field === "string" && field.trim().length > 0);
    assert.equal(binary.isNative("/nowhere/bin/unrelated"), false);
    for (const service of [services.commands, services.suggestTitle, services.planUsage, services.readiness]) assert.equal(typeof service, "function");
    assert.equal(typeof createProvider, "function");
    const others = AGENT_ENGINES.filter((other) => other !== engine);
    assert.ok(others.every((other) => ENGINE_MODULES[other].binary.command !== binary.command), "each engine runs a command of its own");
  });

  test("builds a provider that leaves alone what it does not own, and closes safely while idle", async () => {
    const { pool, providers: built } = await providers();
    const provider = built[engine];
    for (const method of ["execute", "stopProcess", "labelThread", "archiveThread", "retireOutOfRole", "closeAll"] as const) assert.equal(typeof provider[method], "function", method);

    await pool.execute(input({ taskId: "theirs" }), "foreign", { open: (hooks) => new ForeignSession("foreign", hooks) });
    for (const taskId of ["theirs", "nobody"]) {
      assert.equal(provider.stopProcess(taskId, "process-1"), false, taskId);
      assert.equal(provider.labelThread(taskId, "Title"), false, taskId);
      assert.equal(provider.archiveThread(taskId, undefined, true), false, taskId);
    }
    for (const owner of [...AGENT_ENGINES.filter((other) => other !== engine), "gemini"]) {
      assert.equal(provider.archiveThread("theirs", { provider: owner, value: "handle" }, true), false, `a continuation ${owner} made is not this engine's to file`);
    }
    assert.ok(pool.liveSession("theirs"), "another engine's session is left running");

    provider.retireOutOfRole("nobody", "coordinator");
    provider.closeAll();
    provider.closeAll();
    assert.equal(pool.liveSession("theirs"), undefined, "closing closes the pool the engines share");
  });

  test("runs every mode it offers, and offers the one a run nobody watches gets", () => {
    const { policies, unattendedPolicy } = capabilitiesFor(engine);
    assert.ok(policies.length > 0);
    assert.ok(policies.includes(unattendedPolicy));
    for (const policy of policies) assert.notEqual(POLICY_MAPPINGS[engine](policy), undefined, policy);
    assert.notDeepEqual(POLICY_MAPPINGS[engine]("confirm"), POLICY_MAPPINGS[engine]("bypass"), "asking and never asking differ");
    for (const policy of EVERY_POLICY) assert.ok(policies.includes(policyFor(engine, policy)), `${policy} lands on a mode the engine offers`);
  });

  test("offers only efforts the app knows, and a default that is its own", () => {
    assert.ok(isAgentEffort(defaultEffortFor(engine)));
    for (const model of modelsFor(BUILT_IN_MODELS, engine)) {
      for (const effort of model.efforts) assert.ok(isAgentEffort(effort.id) && effort.label.length > 0, `${model.id} ${effort.id}`);
    }
    const fixed = defaultModelFor(engine);
    if (fixed !== undefined) assert.ok(engineHasModel(BUILT_IN_MODELS, engine, fixed));
  });

  test("is named, and reads its tool calls", () => {
    assert.ok(engineLabel(engine).length > 0 && engineLabel(engine) !== engine);
    assert.equal(describeToolCall(engine, "unknown_tool", JSON.stringify({ command: "ls -la" })).argument, "ls -la");
    assert.equal(toolFamily(engine, "browser_click"), "web", "the app's own tools read alike on every engine");
  });
});
