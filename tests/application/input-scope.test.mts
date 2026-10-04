import assert from "node:assert/strict";
import { test } from "vitest";
import { inputScope } from "../../src/application/input-scope.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { activeRun, task, workspace } from "./workspace-reducer-fixtures.mts";

const state = workspace({ threads: [task("current"), task("other")], currentId: "current", activeRuns: { current: activeRun("current", "run") } });

test("commands for the thread on screen name it, so a later selection cannot redirect them", () => {
  assert.deepEqual(inputScope(state, { type: "task.send" }).input, { type: "task.send", taskId: "current" });
  assert.deepEqual(inputScope(state, { type: "run.cancel" }).input, { type: "run.cancel", taskId: "current" });
  assert.deepEqual(inputScope(state, { type: "view.set-prompt", prompt: "typed" }).input, { type: "view.set-prompt", taskId: "current", prompt: "typed" });
  assert.deepEqual(inputScope(state, { type: "view.find-open" }).input, { type: "view.find-open", target: { kind: "thread", taskId: "current" } });
  const send = { type: "task.send", text: "starts a new thread" } as const;
  assert.equal(inputScope(state, send).input, send);
  const remote = { ...state, computers: { ...state.computers, active: "elsewhere" } };
  const cancel = { type: "run.cancel" } as const;
  assert.equal(inputScope(remote, cancel).input, cancel);
});

test("a named current thread reduces exactly as the implicit one", () => {
  for (const input of [{ type: "run.cancel" }, { type: "view.set-prompt", prompt: "typed" }] as const) {
    const implicit = reduce(state, input);
    const named = reduce(state, inputScope(state, input).input);
    assert.deepEqual(named.state, implicit.state);
    assert.deepEqual(named.effects, implicit.effects);
  }
});

test("only the threads an input touches order it, and selection follows nothing", () => {
  assert.deepEqual([...inputScope(state, { type: "task.select", taskId: "other" }).keys], []);
  assert.deepEqual([...inputScope(state, { type: "view.set-settings-open", open: true }).keys], []);
  assert.deepEqual([...inputScope(state, { type: "run.cancel", taskId: "other" }).keys], ["other"]);
  assert.deepEqual([...inputScope(state, { type: "agent.events", events: [
    { type: "run.started", taskId: "current", runId: "run", sequence: 1, agentInitiated: true },
    { type: "assistant.delta", taskId: "other", runId: "other-run", sequence: 1, messageId: "m", text: "hi" },
  ] }).keys], ["current", "other"]);
  const query = inputScope({ ...state, find: null }, { type: "view.find-query", query: "needle" });
  assert.ok(query.keys.has("view:find"), "a query follows the bar opened before it");
});

test("a command that cannot name the thread on screen runs only while that thread stays there", () => {
  assert.deepEqual(inputScope(state, { type: "side-chat.open", chatId: "chat" }).screen, "current");
  const escape = inputScope(state, { type: "view.escape" });
  assert.deepEqual([...escape.keys], ["current"]);
  assert.equal(escape.screen, "current");
  const closing = inputScope({ ...state, settingsOpen: true }, { type: "view.escape" });
  assert.deepEqual([...closing.keys], []);
  assert.equal(closing.screen, undefined);
});
