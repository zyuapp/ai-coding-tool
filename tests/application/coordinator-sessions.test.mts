import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { coordinationContext } from "../../src/application/coordination-messages.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ThreadBrief } from "../../src/domain/coordination.ts";
import { createConversationMessage, createSentMessage } from "../../src/domain/conversation.ts";
import { task, workspace, activeRun, effectAt, effectOf, correlatedRunEvent, required } from "./workspace-reducer-fixtures.mts";

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };
const BRIEF: ThreadBrief = { intent: "fix the flaky login test", doneWhen: "the suite passes 50 runs", delivers: "pull-request" };
const SESSION = { continuation: { provider: "claude", value: "session" }, continuationStatus: "available" as const };

function lead(id = "lead", overrides = {}) {
  return task(id, { role: "coordinator", ...overrides });
}

/** Sends a message and starts its run, answering with the run it starts, what it is told, and the state it starts in. */
function started(state: WorkspaceState, input: Extract<WorkspaceInput, { type: "task.send" }>) {
  const sending = reduce(state, input);
  const run = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const command = effectAt(run, "start-run").command;
  return { state: run.state, prompt: command.prompt, command };
}

test("a coordinator starting a new session over its history is seeded with its threads, memory, decisions and recent messages", () => {
  const coordinator = lead("lead", {
    memory: { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Propose threads first", at: 1 }], revision: 1, heard: 1 },
    decisions: [{ id: "d1", question: "Tokens or overrides?", options: [{ label: "Tokens" }, { label: "Overrides" }], raisedAt: 1 }],
    proposals: [{ id: "p1", title: "Write the docs", prompt: "Write them", brief: BRIEF, place: {}, proposedAt: 1 }],
    coordinationNotes: [{ id: "c1", threadId: "worker", text: "\"Fix login\" was stopped.", at: 1, quiet: true as const }],
    messages: [
      createConversationMessage("user", "Plan the reader"),
      createConversationMessage("tool", "start_thread", "{}"),
      createConversationMessage("assistant", "I started Fix login."),
      createSentMessage({ text: "The test is fixed.", origin: { kind: "thread", threadId: "worker", title: "Fix login" } }),
      { ...createConversationMessage("user", "Checking in"), withdrawn: true as const },
      { ...createConversationMessage("assistant", "Report: all green"), artifact: true as const },
      createConversationMessage("system", "Context auto-compacted at 90,000 tokens."),
    ],
  });
  const state = workspace({ threads: [coordinator, task("worker", { parentId: "lead", title: "Fix login", brief: BRIEF })], currentId: "lead" });
  const run = started(state, { type: "task.send", taskId: "lead", text: "What next?" });

  const [seed, message] = run.prompt.split("\n\n---\n");
  assert.equal(message, "What next?", "the message that started the run comes after the seed");
  assert.equal(seed, [
    "This coordinator continues in a new session; read_thread with its ID [lead] reaches its full history.",
    "Your purpose: Ship the v2 reader",
    "Your memory:",
    "- [n1] Propose threads first",
    "Updates from your threads you have not seen yet:",
    "- \"Fix login\" was stopped.",
    "Your threads right now:",
    "- \"Fix login\" [worker] · idle",
    "Suggested threads waiting on the user:",
    "- \"Write the docs\" [p1]",
    "Decisions you raised that the user has yet to answer:",
    "- Tokens or overrides?",
    "The last messages of your conversation, oldest first:",
    "The user: Plan the reader",
    "You: I started Fix login.",
    "From Fix login · worker: The test is fixed.",
  ].join("\n"), "tool rows, withdrawn messages, artifacts and notices are left out");
  assert.equal(required(run.state.threads.find((thread) => thread.id === "lead")).coordinationNotes, undefined, "the notes it was seeded with are delivered");

  const renewed = { provider: "claude" as const, value: "new-session" };
  const named = reduce(run.state, correlatedRunEvent("lead", run.command.runId, 1, { type: "continuation.updated", continuation: renewed }));
  const ended = reduce(named.state, correlatedRunEvent("lead", run.command.runId, 2, { type: "run.status", status: "succeeded" }));
  const next = started(ended.state, { type: "task.send", taskId: "lead", text: "And now?" });
  assert.deepEqual(next.command.continuation, renewed, "the next run resumes the new session");
  assert.doesNotMatch(next.prompt, /new session|The last messages/);

  const opened = started(workspace({ threads: [lead()], currentId: "lead" }), { type: "task.send", taskId: "lead", text: "Plan the reader" });
  assert.equal(opened.prompt, "Plan the reader", "a coordinator with no history yet has nothing to be seeded with");
});

test("a coordinator woken with no session to resume gets the news after its seed", () => {
  const worker = task("worker", { parentId: "lead", title: "Fix login" });
  const state = workspace({ threads: [lead("lead", { messages: [createConversationMessage("user", "Plan the reader")] }), worker], activeRuns: { worker: activeRun("worker", "run-w") }, runStatuses: { worker: "running" } });
  const ended = reduce(state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const run = reduce(ended.state, { type: "run.resolved", pendingId: effectOf(ended, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const command = effectAt(run, "start-run").command;
  assert.match(command.prompt, /^This coordinator continues in a new session[^]*\n\n---\n"Fix login" ended its turn\./);
  assert.doesNotMatch(command.prompt, /Updates from your threads/, "the news the wake carries is told once");
});

test("the seed stays bounded however long the conversation", () => {
  const messages = Array.from({ length: 200 }, (_, index) => createConversationMessage(index % 2 ? "assistant" : "user", `${index} ${"x".repeat(2_000)}`));
  const state = workspace({ threads: [lead("lead", { ...SESSION, messages })] });
  const seed = coordinationContext(state, state.threads[0]!, { fresh: true });
  const recent = seed.split("The last messages of your conversation, oldest first:\n")[1]!.split("\n");
  assert.equal(recent.length, 12, "only the last 12 messages are read");
  assert.match(recent.at(-1)!, /^You: 199 x+…$/, "newest last");
  assert.ok(recent.every((line) => line.length <= "The user: ".length + 800), "each message is clipped");
  assert.ok(recent.join("\n").length <= 10_000);

  const titled = workspace({ threads: [lead("lead", { ...SESSION, messages: messages.map((message) => ({ ...message, kind: "user" as const, origin: { kind: "thread" as const, threadId: "worker", title: "t".repeat(64) } })) })] });
  const long = coordinationContext(titled, titled.threads[0]!, { fresh: true }).split("oldest first:\n")[1]!.split("\n");
  assert.ok(long.length < 12 && long.join("\n").length <= 10_000, "the oldest go first once the block runs long");
  assert.match(long.at(-1)!, /^From t+ · worker: 199 /);

  const cold = workspace({ threads: [lead("lead", { ...SESSION, messages: [], historySummary: { messageCount: 200, attachmentCount: 0 } })] });
  const unread = coordinationContext(cold, cold.threads[0]!, { fresh: true });
  assert.match(unread, /^This coordinator continues in a new session/);
  assert.doesNotMatch(unread, /The last messages/, "a conversation not loaded yet is left to read_thread");
});

test("the agent process is told when a thread's role changes, the threads under a coordinator included", () => {
  const roles = (transition: ReturnType<typeof reduce>) => transition.effects.flatMap((effect) => effect.type === "send-run-command" && effect.command.type === "role" ? [effect.command] : []);
  const state = workspace({ threads: [task("lead"), task("worker", { parentId: "lead" })] });
  const made = reduce(state, { type: "task.set-role", taskId: "lead", role: "coordinator" });
  assert.deepEqual(roles(made), [{ type: "role", taskId: "lead", coordinationRole: "coordinator" }, { type: "role", taskId: "worker", coordinationRole: "member" }]);
  assert.deepEqual(roles(reduce(made.state, { type: "task.set-role", taskId: "lead", role: "reviewer" })), [{ type: "role", taskId: "lead" }, { type: "role", taskId: "worker" }]);
  assert.deepEqual(roles(reduce(made.state, { type: "task.rename", taskId: "lead", title: "Renamed" })), [], "nothing that leaves the role alone says anything");
  assert.deepEqual(roles(reduce(state, { type: "task.set-role", taskId: "worker", role: "reviewer" })), [], "a role that changes no tools says nothing");
});
