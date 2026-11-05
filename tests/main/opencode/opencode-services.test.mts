import assert from "node:assert/strict";
import { test } from "vitest";
import { OpenCodeServices } from "../../../src/main/opencode/opencode-services.mts";
import type { ExitStatus, OpenCodeClient, ServerOptions } from "../../../src/main/opencode/opencode-server.mts";

type Answers = Record<string, unknown>;

function services(answers: Answers) {
  const started: ServerOptions[] = [];
  const asked: { path: string; body: unknown }[] = [];
  let closed = 0;
  const service = new OpenCodeServices(async (options) => {
    started.push(options);
    const client: OpenCodeClient = {
      request: async <T,>(_method: string, path: string, body?: unknown) => {
        asked.push({ path, body });
        const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
        const answer = key === undefined ? undefined : answers[key];
        if (answer instanceof Error) throw answer;
        return answer as T;
      },
      subscribe: () => () => {},
      exited: new Promise<ExitStatus>(() => {}),
      close: async () => { closed += 1; },
    };
    return client;
  });
  return { service, started, asked, closed: () => closed };
}

test("one server answers every question until it has been idle a while, and closing stops it", async () => {
  const { service, started, closed } = services({
    "/api/model/default": { id: "glm-5.3", providerID: "opencode-go" },
    "/api/model": [{ id: "z-ai/glm-5.3-flash", providerID: "openrouter" }, { id: "glm-5.3", providerID: "opencode-go" }],
    "/api/provider": [{ id: "openrouter", name: "OpenRouter" }, { id: "opencode-go", name: "OpenCode Go" }],
  });
  const catalog = await service.catalog();
  assert.deepEqual(catalog.map((spec) => [spec.id, spec.provider]), [["opencode-go/glm-5.3", "OpenCode Go"], ["openrouter/z-ai/glm-5.3-flash", "OpenRouter"]]);
  await service.catalog();
  assert.equal(started.length, 1);
  await service.close();
  assert.equal(closed(), 1);
});

test("commands are OpenCode's own and the skills it can load, each named once by its short name", async () => {
  const { service, asked } = services({
    "/api/command": [{ name: "init", description: "guided AGENTS.md setup" }, { name: "review" }],
    "/api/skill": [{ id: "aicodingtool:review-thread", description: "Review loop" }, { id: "review", description: "dup" }],
  });
  const commands = await service.commands("/repo with space");
  assert.deepEqual(commands, [
    { name: "init", description: "guided AGENTS.md setup", argumentHint: "" },
    { name: "review", description: "dup", argumentHint: "" },
    { name: "review-thread", description: "Review loop", argumentHint: "" },
  ]);
  assert.ok(asked.every((call) => call.path.endsWith(`location[directory]=${encodeURIComponent("/repo with space")}`)), "every list is read in the workspace");
  await service.close();
});

test("a title is written on the thread's own model, and nothing is written for a model OpenCode cannot name", async () => {
  const { service, asked } = services({ "/api/experimental/generate/text": { text: "\"Fix flaky login test.\"" } });
  assert.equal(await service.title("The login test fails half the time", "openrouter/z-ai/glm-5.3-flash"), "Fix flaky login test");
  assert.deepEqual((asked[0]!.body as { model: unknown }).model, { providerID: "openrouter", id: "z-ai/glm-5.3-flash" });
  assert.equal(await service.title("hello", "opus"), null);
  assert.equal(await service.title("hello"), null);
  assert.equal(asked.length, 1);
  const failing = services({ "/api/experimental/generate/text": new Error("timeout") });
  assert.equal(await failing.service.title("hello", "openrouter/z-ai/glm-5.3-flash"), null, "a title that cannot be written leaves the typed one");
  await service.close();
  await failing.service.close();
});

test("OpenCode Go's allowance is drawn as plan windows, and an account without Go has no plan limits", async () => {
  const at = Date.UTC(2026, 10, 5, 18);
  const go = services({ "/api/experimental/usage/limits": { go: { rolling: { percent: 12, limited: false, resetsAt: at }, weekly: { percent: 40, limited: false, resetsAt: at }, monthly: { percent: 9, limited: false, resetsAt: at } }, budgets: [] } });
  assert.deepEqual(await go.service.planUsage(), {
    status: "available",
    subscription: "Go",
    windows: [
      { id: "rolling", label: "Rolling", utilization: 12, resetsAt: new Date(at).toISOString(), period: "session" },
      { id: "weekly", label: "Weekly", utilization: 40, resetsAt: new Date(at).toISOString(), period: "week" },
      { id: "monthly", label: "Monthly", utilization: 9, resetsAt: new Date(at).toISOString() },
    ],
  });
  const none = services({ "/api/experimental/usage/limits": null });
  assert.deepEqual(await none.service.planUsage(), { status: "not-applicable" });
  await go.service.close();
  await none.service.close();
});

test("a server that fails to answer is let go, so the next question starts a fresh one", async () => {
  const { service, started } = services({ "/api/model": new Error("server gone") });
  await assert.rejects(service.catalog(), /server gone/);
  await assert.rejects(service.catalog(), /server gone/);
  assert.equal(started.length, 2);
  await service.close();
});
