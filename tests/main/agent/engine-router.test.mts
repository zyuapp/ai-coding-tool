import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderResult, ProviderRunInput } from "../../../src/main/agent/agent-provider.mts";
import { EngineRouter, type EngineProvider } from "../../../src/main/agent/engine-router.mts";
import { input } from "../../support/codex-client.mjs";

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
    closeAll() {
      log.push(`${name}:closeAll`);
    },
  };
}

test("a run goes to the engine it names, a stop asks each engine for the thread, and closing closes them all", async () => {
  const log: string[] = [];
  const router = new EngineRouter({ claude: engine("claude", log), codex: engine("codex", log, ["task-c"]) });

  assert.deepEqual(await router.execute(input({ engine: "claude", model: "opus", taskId: "task-a" })), { status: "succeeded", message: "claude" });
  assert.deepEqual(await router.execute(input({ engine: "codex", model: "gpt-5.6-sol", taskId: "task-c" })), { status: "succeeded", message: "codex" });
  assert.equal(router.stopProcess("task-c", "process-1"), true);
  assert.equal(router.stopProcess("task-z", "process-1"), false);
  router.closeAll();

  assert.deepEqual(log, [
    "claude:claude:task-a",
    "codex:codex:task-c",
    "claude:stop:task-c:false",
    "codex:stop:task-c:true",
    "claude:stop:task-z:false",
    "codex:stop:task-z:false",
    "claude:closeAll",
    "codex:closeAll",
  ]);
});
