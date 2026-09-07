import assert from "node:assert/strict";
import { test } from "vitest";
import { harness, sentBy, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";

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
