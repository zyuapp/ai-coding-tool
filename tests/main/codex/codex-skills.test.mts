import assert from "node:assert/strict";
import { test } from "vitest";
import { CodexSkills, discoverCodexCommands, type SkillsConnect } from "../../../src/main/codex/codex-skills.mts";
import type { SkillMetadata } from "../../../src/main/codex/protocol/v2/SkillMetadata.ts";
import { FakeCodexClient, harness, sentBy, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";

test("the Codex menu offers enabled system and plugin skills that slash invocation can resolve", async () => {
  const skills: SkillMetadata[] = [
    { name: "imagegen", description: "Generate images.", path: "/Users/me/.codex/skills/.system/imagegen/SKILL.md", scope: "system", enabled: true, pluginId: null },
    { name: "slides", description: "Create slides.", path: "/Users/me/.codex/plugins/cache/slides/SKILL.md", scope: "user", enabled: true, pluginId: "slides@marketplace" },
    { name: "disabled", description: "Disabled skill.", path: "/Users/me/.agents/skills/disabled/SKILL.md", scope: "user", enabled: false, pluginId: null },
  ];
  const clients: FakeCodexClient[] = [];
  const connect: SkillsConnect = (command) => {
    const client = new FakeCodexClient(command, { "skills/list": () => ({ data: [{ cwd: "/tmp/project", skills, errors: [] }] }) });
    clients.push(client);
    return client;
  };
  const first = discoverCodexCommands("/tmp/project", connect);
  const concurrent = discoverCodexCommands("/tmp/project", connect);
  assert.equal(first, concurrent);
  assert.deepEqual(await first, [
    { name: "imagegen", description: "Generate images.", argumentHint: "" },
    { name: "slides", description: "Create slides.", argumentHint: "" },
  ]);
  assert.equal(clients.length, 1);
  const client = clients[0]!;
  assert.equal(client.closed, true);
  assert.equal(client.command.cwd, "/tmp/project");
  assert.ok(client.command.args.some((arg) => arg.startsWith("plugins=") && arg.includes("browser@openai-bundled")));
  assert.deepEqual(client.sent.map((call) => call.method), ["initialize", "skills/list"]);
  assert.deepEqual(client.calls("skills/list"), [{ cwds: ["/tmp/project"], forceReload: true }]);

  const session = new CodexSkills(client, "/tmp/project");
  await session.refresh(true);
  const prompt = "/imagegen /slides /disabled";
  assert.deepEqual(await session.input(prompt), [
    { type: "skill", name: "imagegen", path: skills[0]!.path },
    { type: "skill", name: "slides", path: skills[1]!.path },
    { type: "text", text: prompt, text_elements: [] },
  ]);

  skills[0]!.enabled = false;
  assert.deepEqual(await discoverCodexCommands("/tmp/project", connect), [
    { name: "slides", description: "Create slides.", argumentHint: "" },
  ]);
  assert.equal(clients.length, 2);
});

test("skill discovery closes failed or stalled servers and permits a later retry", async () => {
  const clients: FakeCodexClient[] = [];
  const failed: SkillsConnect = (command) => {
    const client = new FakeCodexClient(command, { "skills/list": () => { throw new Error("Skill discovery failed."); } });
    clients.push(client);
    return client;
  };
  await assert.rejects(discoverCodexCommands("/tmp/project", failed), /Skill discovery failed/);
  assert.equal(clients[0]!.closed, true);

  const stalled: SkillsConnect = (command) => {
    const client = new FakeCodexClient(command, {}, () => new Promise(() => {}));
    clients.push(client);
    return client;
  };
  await assert.rejects(discoverCodexCommands("/tmp/project", stalled, 5), /did not return its skills in time/);
  assert.equal(clients[1]!.closed, true);
  await assert.rejects(discoverCodexCommands("/tmp/project", failed), /Skill discovery failed/);
  assert.equal(clients.length, 3);
});

test("a slash skill anywhere in the prompt is sent as a native Codex skill", async () => {
  const skill = {
    name: "suggest-qa-plan",
    description: "Suggest a QA plan.",
    path: "/Users/me/.agents/skills/suggest-qa-plan/SKILL.md",
    scope: "user" as const,
    enabled: true,
    pluginId: null,
  };
  const codex = harness({ "skills/list": () => ({ data: [{ cwd: "/tmp/project", skills: [skill], errors: [] }] }) });
  const { client } = await turn(codex, { prompt: "read the changes and /suggest-qa-plan" });

  assert.deepEqual(client.calls("skills/list"), [{ cwds: ["/tmp/project"], forceReload: true }]);
  assert.deepEqual(client.calls("turn/start")[0], {
    threadId,
    input: [
      { type: "skill", name: "suggest-qa-plan", path: skill.path },
      { type: "text", text: "read the changes and /suggest-qa-plan", text_elements: [] },
    ],
    model: "gpt-5.6-sol",
    effort: "high",
    serviceTier: "default",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  codex.provider.closeAll();
});

test("a live session refreshes native skills after Codex reports a change", async () => {
  let skills: Array<{ name: string; description: string; path: string; scope: "user"; enabled: boolean; pluginId: null }> = [];
  const codex = harness({ "skills/list": () => ({ data: [{ cwd: "/tmp/project", skills, errors: [] }] }) });
  const first = await turn(codex);

  skills = [{ name: "later", description: "Added later.", path: "/Users/me/.agents/skills/later/SKILL.md", scope: "user", enabled: true, pluginId: null }];
  first.client.notify("skills/changed", {});
  await sentBy(first.client, "skills/list", 2);
  const second = await turn(codex, { prompt: "use /later", continuation: { provider: "codex", value: threadId } });

  assert.deepEqual((second.client.calls("turn/start")[1] as { input: unknown[] }).input, [
    { type: "skill", name: "later", path: skills[0]!.path },
    { type: "text", text: "use /later", text_elements: [] },
  ]);
  codex.provider.closeAll();
});
