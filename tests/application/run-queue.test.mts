import assert from "node:assert/strict";
import { test } from "vitest";
import { settleTurn } from "../../src/application/run-settlement.ts";
import { drainQueue, editableQueued } from "../../src/application/workspace-reducer/run-queue.ts";
import { QUEUED_NOT_YOURS, QUEUED_SENT } from "../../src/application/computers.ts";
import type { QueuedMessage } from "../../src/application/workspace-state.ts";
import { required, task, workspace } from "./workspace-reducer-fixtures.mts";

const own = (id: string, text: string): QueuedMessage => ({ id, text, prompt: text, attachments: [], usersOwn: true });
const queuedState = () => workspace({ threads: [task("one")], queuedMessages: { one: [own("a", "first"), own("b", "second")] } });
const pendingOf = (state: ReturnType<typeof queuedState>) => Object.values(state.pendingRuns);

test("delivering a queue starts its next message alone, and the rest wait", () => {
  const drained = drainQueue(queuedState(), "one", "deliver");
  const [pending] = pendingOf(drained.state);
  assert.equal(pendingOf(drained.state).length, 1);
  assert.equal(required(pending).text, "first");
  assert.deepEqual(required(pending).queuedIds, ["a"]);
  assert.equal(required(pending).warming, undefined);
  assert.equal(drained.effects[0]?.type, "resolve-run-workspace");
});

test("resuming a queue starts its next message as a run that warms up its engine's line", () => {
  const [pending] = pendingOf(drainQueue(queuedState(), "one", "resume").state);
  assert.equal(required(pending).text, "first");
  assert.equal(required(pending).warming, true);
});

test("handing a queue back puts the user's own messages in the composer and starts nothing", () => {
  const drained = drainQueue(queuedState(), "one", "hand-back");
  assert.equal(pendingOf(drained.state).length, 0);
  assert.equal(drained.state.queuedMessages.one?.length ?? 0, 0);
  assert.equal(drained.state.prompts.one, "first\n\nsecond");
});

test("a queue is held, whatever is asked, while its thread waits out a usage limit", () => {
  const state = workspace({ threads: [task("one", { limitPause: { resetsAt: 2, window: "session", pausedAt: 1 } })], queuedMessages: { one: [own("a", "first")] } });
  const drained = drainQueue(state, "one", "deliver");
  assert.equal(drained.state, state);
  assert.equal(drained.effects.length, 0);
});

test("a settled turn says what becomes of its queue", () => {
  assert.equal(settleTurn({ status: "succeeded" }).queue, "deliver");
  assert.equal(settleTurn({ status: "failed" }).queue, "deliver");
  assert.equal(settleTurn({ status: "cancelled", stop: "user" }).queue, "hand-back");
  assert.equal(settleTurn({ status: "failed", limit: { resetsAt: 2, window: "session" }, stop: "user" }).queue, "hand-back", "a stop a session limit got to first hands back as the stop asked");
});

test("only the user's own unsteered queued message may be taken back to rewrite", () => {
  const theirs: QueuedMessage = { id: "c", text: "from a lead", prompt: "from a lead", attachments: [], origin: { kind: "thread", threadId: "lead", title: "Lead" } };
  const queued = [own("a", "first"), { ...own("s", "steered"), steering: true as const }, theirs];
  assert.deepEqual(editableQueued(queued, "a"), { message: queued[0] });
  assert.deepEqual(editableQueued(queued, "s"), { refusal: QUEUED_SENT });
  assert.deepEqual(editableQueued(queued, "gone"), { refusal: QUEUED_SENT });
  assert.deepEqual(editableQueued(queued, "c"), { refusal: QUEUED_NOT_YOURS });
});
