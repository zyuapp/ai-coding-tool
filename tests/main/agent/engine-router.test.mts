import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderResult, ProviderRunInput } from "../../../src/main/agent/agent-provider.mts";
import { EngineRouter, type EngineProvider } from "../../../src/main/agent/engine-router.mts";
import { AGENT_ENGINES } from "../../../src/domain/agent-engine.ts";
import { input } from "../../support/codex-client.mjs";
import { everyEngine } from "../../support/engines.mts";

function engine(name: string, log: string[], holds: string[] = []): EngineProvider {
  return {
    async execute(run: ProviderRunInput): Promise<ProviderResult> {
      log.push(`${name}:${run.engine}:${run.taskId}`);
      return { status: "succeeded", message: name };
    },
    stopProcess(taskId: string) {
      const held = holds.includes(taskId);
      log.push(`${name}:stop:${taskId}:${held}`);
      return held;
    },
    labelThread(taskId: string, title: string) {
      const held = holds.includes(taskId);
      log.push(`${name}:label:${taskId}:${title}:${held}`);
      return held;
    },
    archiveThread(taskId: string, continuation: { provider: string } | undefined, archived: boolean) {
      const held = continuation?.provider === name;
      log.push(`${name}:archive:${taskId}:${archived}:${held}`);
      return held;
    },
    retireOutOfRole(taskId: string, role: string | undefined) {
      log.push(`${name}:role:${taskId}:${role ?? "none"}`);
    },
    closeAll() {
      log.push(`${name}:closeAll`);
    },
  };
}

test("a run goes to the engine it names, a stop asks each engine for the thread, and closing closes them all", async () => {
  const log: string[] = [];
  const router = new EngineRouter(everyEngine((name) => engine(name, log), { codex: engine("codex", log, ["task-c"]) }));

  assert.deepEqual(await router.execute(input({ engine: "claude", model: "opus", taskId: "task-a" })), { status: "succeeded", message: "claude" });
  assert.deepEqual(await router.execute(input({ engine: "codex", model: "gpt-6.1-sol", taskId: "task-c" })), { status: "succeeded", message: "codex" });
  assert.equal(router.stopProcess("task-c", "process-1"), true);
  assert.equal(router.stopProcess("task-z", "process-1"), false);
  router.closeAll();

  assert.deepEqual(log, [
    "claude:claude:task-a",
    "codex:codex:task-c",
    "claude:stop:task-c:false",
    "codex:stop:task-c:true",
    ...AGENT_ENGINES.map((name) => `${name}:stop:task-z:false`),
    ...AGENT_ENGINES.map((name) => `${name}:closeAll`),
  ]);
});

test("a role change asks every engine, since any may hold the thread's session", () => {
  const log: string[] = [];
  new EngineRouter(everyEngine((name) => engine(name, log))).retireOutOfRole("task-a", "coordinator");
  assert.deepEqual(log, AGENT_ENGINES.map((name) => `${name}:role:task-a:coordinator`));
});

test("an archive goes to the engine that made the thread's continuation, and one with none yet asks each", () => {
  const log: string[] = [];
  const router = new EngineRouter(everyEngine((name) => engine(name, log)));
  assert.equal(router.archiveThread("task-o", { provider: "opencode", value: "ses_1" }, true), true);
  assert.equal(router.archiveThread("task-g", { provider: "gemini", value: "g-1" }, true), false, "an engine this build does not run files nothing");
  assert.equal(router.archiveThread("task-n", undefined, true), false);
  assert.deepEqual(log, [
    "opencode:archive:task-o:true:true",
    ...AGENT_ENGINES.map((name) => `${name}:archive:task-n:true:false`),
  ]);
});
