import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { reduce } from "../../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../../src/application/workspace-state.ts";
import { viewPreferences } from "../../../src/application/view-preferences.ts";
import type { WorkspaceRecord } from "../../../src/domain/workspace.ts";
import { input, poolQueryFactory, poolTurn, queryFactory, type PoolCapture, type QueryCapture } from "../../support/claude-session.mjs";

const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" } satisfies WorkspaceRecord;

/** Sends the draft and settles its workspace, which is what puts a start-run command together. */
function started(state: WorkspaceState) {
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const pending = sending.effects.find((effect) => effect.type === "resolve-run-workspace");
  assert.ok(pending);
  const start = reduce(sending.state, { type: "run.resolved", pendingId: pending.pendingId, workspace: PROJECTLESS }).effects.find((effect) => effect.type === "start-run");
  assert.ok(start);
  return start.command;
}

function systemAppend(options: QueryCapture["options"]) {
  const prompt = options?.options?.systemPrompt;
  assert.ok(prompt && typeof prompt === "object" && !Array.isArray(prompt) && "append" in prompt);
  return prompt.append ?? "";
}

test("the setting starts off, is remembered, and marks every run it is on for", () => {
  const drafted = reduce(emptyWorkspaceState(), { type: "view.set-prompt", prompt: "Explain this" }).state;
  assert.equal(drafted.conciseReplies, false, "a workspace that has never been told answers at its usual length");
  assert.equal(started(drafted).claude?.conciseReplies, undefined);

  const on = reduce(drafted, { type: "view.set-concise-replies", enabled: true });
  assert.equal(on.state.conciseReplies, true);
  const persisted = on.effects.find((effect) => effect.type === "persist-preferences");
  assert.ok(persisted);
  assert.equal(persisted.preferences.conciseReplies, true);
  assert.deepEqual(reduce(on.state, { type: "view.set-concise-replies", enabled: true }).effects, [], "an unchanged choice writes nothing");

  assert.equal(started(on.state).claude?.conciseReplies, true);
  assert.equal(started(reduce(on.state, { type: "view.set-concise-replies", enabled: false }).state).claude?.conciseReplies, undefined);
});

test("a thread that already exists is marked from its next run on", () => {
  const drafted = reduce(emptyWorkspaceState(), { type: "view.set-prompt", prompt: "Explain this" }).state;
  assert.equal(started(drafted).claude?.conciseReplies, undefined);

  const on = reduce(drafted, { type: "view.set-concise-replies", enabled: true }).state;
  const next = reduce(on, { type: "view.set-prompt", prompt: "And this" }).state;
  assert.equal(started(next).claude?.conciseReplies, true);
});

test("a stored setting survives the store loading", () => {
  const preferences = { ...viewPreferences(emptyWorkspaceState()), conciseReplies: true };
  assert.equal(reduce(emptyWorkspaceState(), { type: "preferences.loaded", preferences }).state.conciseReplies, true);
});

test("both the setting the user keeps and the ruleset behind it reach a run it is on for", async () => {
  const capture: QueryCapture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({ claude: { conciseReplies: true } }));
  assert.deepEqual(capture.options?.options?.settings, { outputStyle: "Concise" });
  assert.match(systemAppend(capture.options), /Five sentences or fewer for prose/);
  assert.match(systemAppend(capture.options), /Never compress/);
});

test("a run the setting is off for is told nothing about its length", async () => {
  const capture: QueryCapture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({}));
  assert.equal(capture.options?.options?.settings, undefined);
  assert.doesNotMatch(systemAppend(capture.options), /Five sentences or fewer for prose/);
});

test("turning the setting on gives the thread a session of its own rather than reusing the warm one", async () => {
  const capture: PoolCapture = { sessions: [] };
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture));

  await poolTurn(provider, capture, {});
  await poolTurn(provider, capture, {});
  assert.equal(capture.sessions.length, 1, "the same settings reuse the warm session");

  await poolTurn(provider, capture, { claude: { conciseReplies: true } });
  assert.equal(capture.sessions.length, 2);
  assert.deepEqual(capture.sessions.at(-1)?.options.options?.settings, { outputStyle: "Concise" });
  provider.closeAll();
});
