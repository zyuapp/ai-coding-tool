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
  assert.ok(prompt && typeof prompt === "object" && !Array.isArray(prompt));
  return prompt.append ?? "";
}

test("the setting starts off, is remembered, and marks every run it is on for", () => {
  const drafted = reduce(emptyWorkspaceState(), { type: "view.set-prompt", prompt: "Open my bank" }).state;
  assert.equal(drafted.chromeBrowser, false, "a workspace that has never been told reaches nobody's Chrome");
  assert.equal(started(drafted).chromeBrowser, undefined);

  const on = reduce(drafted, { type: "view.set-chrome-browser", enabled: true });
  assert.equal(on.state.chromeBrowser, true);
  const persisted = on.effects.find((effect) => effect.type === "persist-preferences");
  assert.ok(persisted);
  assert.equal(persisted.preferences.chromeBrowser, true);
  assert.deepEqual(reduce(on.state, { type: "view.set-chrome-browser", enabled: true }).effects, [], "an unchanged choice writes nothing");

  assert.equal(started(on.state).chromeBrowser, true);
  assert.equal(started(reduce(on.state, { type: "view.set-chrome-browser", enabled: false }).state).chromeBrowser, undefined);
});

test("a stored setting survives the store loading", () => {
  const preferences = { ...viewPreferences(emptyWorkspaceState()), chromeBrowser: true };
  assert.equal(reduce(emptyWorkspaceState(), { type: "preferences.loaded", preferences }).state.chromeBrowser, true);
});

test("a run the setting is on for enables the integration and says which browser the user means", async () => {
  const capture: QueryCapture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({ chromeBrowser: true }));
  assert.deepEqual(capture.options?.options?.extraArgs, { chrome: null });
  assert.match(systemAppend(capture.options), /mcp__claude-in-chrome__/);
});

test("a run the setting is off for leaves the user's own Chrome alone", async () => {
  const capture: QueryCapture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({}));
  assert.equal(capture.options?.options?.extraArgs, undefined);
  assert.doesNotMatch(systemAppend(capture.options), /mcp__claude-in-chrome__/);
});

test("turning the setting on gives the thread a session of its own rather than reusing the warm one", async () => {
  const capture: PoolCapture = { sessions: [] };
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture));

  await poolTurn(provider, capture, {});
  await poolTurn(provider, capture, {});
  assert.equal(capture.sessions.length, 1, "the same settings reuse the warm session");

  await poolTurn(provider, capture, { chromeBrowser: true });
  assert.equal(capture.sessions.length, 2);
  assert.deepEqual(capture.sessions.at(-1)?.options.options?.extraArgs, { chrome: null });
  provider.closeAll();
});
