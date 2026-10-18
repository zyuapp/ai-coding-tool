import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { coordinationContext } from "../../src/application/coordination.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { COORDINATOR_CONTEXT_TOKENS, type ThreadBrief } from "../../src/domain/coordination.ts";
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

/** A coordinator's session that has read as much as its budget allows. */
const GROWN = { ...SESSION, contextUsage: { tokens: COORDINATOR_CONTEXT_TOKENS, limit: 1_000_000, model: "claude-opus-4-7" } };

test("a coordinator past its context budget starts fresh, carrying its threads, memory, decisions and recent messages", () => {
  const coordinator = lead("lead", {
    ...GROWN,
    inheritedContinuation: true as const,
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

  assert.equal(run.command.continuation, undefined, "the grown session is never resumed");
  assert.equal(run.command.forkContinuation, undefined);
  assert.equal(run.command.freshSession, true, "not even the warm session is reused");
  const fresh = required(run.state.threads.find((thread) => thread.id === "lead"));
  assert.equal(fresh.continuation, undefined);
  assert.equal(fresh.inheritedContinuation, undefined);
  assert.equal(fresh.continuationStatus, "none");
  assert.equal(fresh.contextUsage, undefined, "the context meter starts over");
  assert.deepEqual(fresh.messages.slice(-2).map(({ kind, text }) => [kind, text]), [
    ["system", "Continued in a fresh session to keep this coordinator's context small."],
    ["user", "What next?"],
  ], "the transcript stays whole and says where the session started over");
  assert.equal(fresh.messages.length, coordinator.messages.length + 2);

  const [seed, message] = run.prompt.split("\n\n---\n");
  assert.equal(message, "What next?", "the message that started the run comes after the seed");
  assert.equal(seed, [
    "This coordinator continues in a fresh session to keep its context small; read_thread with its ID [lead] reaches its full history.",
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
  assert.equal(fresh.coordinationNotes, undefined, "the notes it was seeded with are delivered");

  const renewed = { provider: "claude" as const, value: "fresh-session" };
  const named = reduce(run.state, correlatedRunEvent("lead", run.command.runId, 1, { type: "continuation.updated", continuation: renewed }));
  const ended = reduce(named.state, correlatedRunEvent("lead", run.command.runId, 2, { type: "run.status", status: "succeeded" }));
  const next = started(ended.state, { type: "task.send", taskId: "lead", text: "And now?" });
  assert.deepEqual(next.command.continuation, renewed, "the next run resumes the new session");
  assert.equal(next.command.freshSession, undefined);
  assert.doesNotMatch(next.prompt, /fresh session|The last messages/);
});

test("a coordinator whose fresh session failed before naming itself is seeded again on its next run", () => {
  const coordinator = lead("lead", { ...GROWN, messages: [createConversationMessage("user", "Plan the reader"), createConversationMessage("assistant", "I started Fix login.")] });
  const run = started(workspace({ threads: [coordinator], currentId: "lead" }), { type: "task.send", taskId: "lead", text: "What next?" });
  const failed = reduce(run.state, correlatedRunEvent("lead", run.command.runId, 1, { type: "run.status", status: "failed" }));
  const next = started(failed.state, { type: "task.send", taskId: "lead", text: "Try again" });
  assert.equal(next.command.continuation, undefined);
  assert.equal(next.command.freshSession, undefined, "there is no warm session left to avoid");
  const [seed, message] = next.prompt.split("\n\n---\n");
  assert.equal(message, "Try again");
  assert.match(seed!, /^This coordinator continues in a fresh session[^]*The user: Plan the reader\nYou: I started Fix login\.\nThe user: What next\?$/);
  assert.equal(required(next.state.threads.find((thread) => thread.id === "lead")).messages.filter(({ kind }) => kind === "system").length, 1, "the notice is said once");

  const opened = started(workspace({ threads: [lead()], currentId: "lead" }), { type: "task.send", taskId: "lead", text: "Plan the reader" });
  assert.equal(opened.prompt, "Plan the reader", "a coordinator with no history yet has nothing to be seeded with");
});

test("a coordinator woken past its context budget starts fresh with the news after its seed", () => {
  const worker = task("worker", { parentId: "lead", title: "Fix login" });
  const state = workspace({ threads: [lead("lead", GROWN), worker], activeRuns: { worker: activeRun("worker", "run-w") }, runStatuses: { worker: "running" } });
  const ended = reduce(state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const run = reduce(ended.state, { type: "run.resolved", pendingId: effectOf(ended, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const command = effectAt(run, "start-run").command;
  assert.equal(command.freshSession, true);
  assert.match(command.prompt, /^This coordinator continues in a fresh session[^]*\n\n---\n"Fix login" ended its turn\./);
  assert.doesNotMatch(command.prompt, /Updates from your threads/, "the news the wake carries is told once");
});

test("under budget it resumes as before", () => {
  const under = { ...GROWN, contextUsage: { ...GROWN.contextUsage, tokens: COORDINATOR_CONTEXT_TOKENS - 1 } };
  const run = started(workspace({ threads: [lead("lead", under)], currentId: "lead" }), { type: "task.send", taskId: "lead", text: "What next?" });
  assert.deepEqual(run.command.continuation, SESSION.continuation);
  assert.equal(run.command.freshSession, undefined);
  assert.deepEqual(run.state.threads[0]?.contextUsage, under.contextUsage);
  assert.doesNotMatch(run.prompt, /fresh session/);
  assert.equal(run.state.threads[0]?.messages.some(({ kind }) => kind === "system"), false);

  const member = started(workspace({ threads: [lead(), task("worker", { ...GROWN, parentId: "lead" })] }), { type: "task.send", taskId: "worker", text: "Carry on" });
  assert.deepEqual(member.command.continuation, SESSION.continuation, "only a coordinator's context is kept small");
  const solo = started(workspace({ threads: [task("solo", GROWN)] }), { type: "task.send", taskId: "solo", text: "Carry on" });
  assert.equal(solo.command.freshSession, undefined);
});

test("a steer, a limit resume or a compaction never starts a fresh session", () => {
  const running = workspace({ threads: [lead("lead", GROWN)], activeRuns: { lead: activeRun("lead", "run-l") }, runStatuses: { lead: "running" } });
  const steered = reduce(running, { type: "task.send", taskId: "lead", text: "Also check the docs", steer: true });
  assert.equal(effectOf(steered, "send-run-command").command.type, "steer");
  assert.deepEqual(steered.state.threads[0]?.continuation, SESSION.continuation, "steering joins the turn already running");

  const pause = { resetsAt: Date.now() + 3_600_000, window: "session" as const, pausedAt: 1 };
  for (const queued of [false, true]) {
    const paused = workspace({ threads: [lead("lead", { ...GROWN, limitPause: pause })] });
    const waiting = queued ? reduce(paused, { type: "task.send", taskId: "lead", text: "When you are back, check the docs" }).state : paused;
    const resuming = reduce(waiting, { type: "limit.resume", taskId: "lead" });
    const resumed = reduce(resuming.state, { type: "run.resolved", pendingId: effectOf(resuming, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
    const command = effectAt(resumed, "start-run").command;
    assert.deepEqual(command.continuation, SESSION.continuation, queued ? "a message written while it waited carries on in its session" : "a limit resume carries on in its session");
    assert.equal(command.freshSession, undefined);
  }

  const codex = { provider: "codex" as const, value: "codex-thread" };
  const compacting = reduce(workspace({ threads: [lead("lead", { ...GROWN, engine: "codex", model: "gpt-6.1-sol", continuation: codex })] }), { type: "run.compact", taskId: "lead" });
  const compacted = reduce(compacting.state, { type: "run.resolved", pendingId: effectOf(compacting, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.deepEqual(effectAt(compacted, "start-run").command.continuation, codex, "compacting is what keeps the session it compacts");
  assert.equal(effectAt(compacted, "start-run").command.freshSession, undefined);
});

test("a coordinator with a native goal running keeps its session", () => {
  const state = workspace({ threads: [lead("lead", GROWN)], goals: { lead: { objective: "Ship the reader", status: "active" } } });
  const run = started(state, { type: "task.send", taskId: "lead", text: "How is it going?" });
  assert.deepEqual(run.command.continuation, SESSION.continuation);
  assert.equal(run.command.freshSession, undefined);

  const ended = started({ ...state, goals: {} }, { type: "task.send", taskId: "lead", text: "How is it going?" });
  assert.equal(ended.command.freshSession, true, "once the goal ends, the next run starts fresh");
});

test("a coordinator with a workflow or background work running keeps its session", () => {
  const workflow = (status: "running" | "completed") => ({ id: "wf", name: "audit", description: "Audit the reader", status, phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 });
  const subagent = (status: "working" | "completed") => ({ id: "child", description: "Inspect", status, sessionScoped: true as const, startedAt: 1, activity: [] });
  const monitor = { id: "watch", kind: "monitor" as const, description: "Watch the build" };
  const claude = lead("lead", GROWN);
  const codex = lead("lead", { ...GROWN, engine: "codex", model: "gpt-6.1-sol", continuation: { provider: "codex", value: "codex-thread" } });
  const cases: Array<[string, WorkspaceState, WorkspaceState]> = [
    ["a Claude workflow", workspace({ threads: [claude], workflows: { lead: [workflow("running")] } }), workspace({ threads: [claude], workflows: { lead: [workflow("completed")] } })],
    ["a Claude monitor", workspace({ threads: [claude], backgroundProcesses: { lead: [monitor] } }), workspace({ threads: [claude], backgroundProcesses: { lead: [] } })],
    ["a Claude subagent", workspace({ threads: [claude], subagents: { lead: [subagent("working")] } }), workspace({ threads: [claude], subagents: { lead: [subagent("completed")] } })],
    ["a Codex subagent", workspace({ threads: [codex], subagents: { lead: [subagent("working")] } }), workspace({ threads: [codex], subagents: { lead: [subagent("completed")] } })],
    ["a Codex background terminal", workspace({ threads: [codex], backgroundProcesses: { lead: [{ ...monitor, kind: "shell" as const }] } }), workspace({ threads: [codex], backgroundProcesses: { lead: [] } })],
  ];
  for (const [what, holding, done] of cases) {
    const run = started(holding, { type: "task.send", taskId: "lead", text: "How is it going?" });
    assert.deepEqual(run.command.continuation, holding.threads[0]!.continuation, `${what} still running keeps the session it runs in`);
    assert.equal(run.command.freshSession, undefined, what);
    assert.equal(started(done, { type: "task.send", taskId: "lead", text: "How is it going?" }).command.freshSession, true, `once ${what} ends, the next run starts fresh`);
  }
});

test("the seed stays bounded however long the conversation", () => {
  const messages = Array.from({ length: 200 }, (_, index) => createConversationMessage(index % 2 ? "assistant" : "user", `${index} ${"x".repeat(2_000)}`));
  const state = workspace({ threads: [lead("lead", { ...GROWN, messages })] });
  const seed = coordinationContext(state, state.threads[0]!, { fresh: true });
  const recent = seed.split("The last messages of your conversation, oldest first:\n")[1]!.split("\n");
  assert.equal(recent.length, 12, "only the last 12 messages are read");
  assert.match(recent.at(-1)!, /^You: 199 x+…$/, "newest last");
  assert.ok(recent.every((line) => line.length <= "The user: ".length + 800), "each message is clipped");
  assert.ok(recent.join("\n").length <= 10_000);

  const titled = workspace({ threads: [lead("lead", { ...GROWN, messages: messages.map((message) => ({ ...message, kind: "user" as const, origin: { kind: "thread" as const, threadId: "worker", title: "t".repeat(64) } })) })] });
  const long = coordinationContext(titled, titled.threads[0]!, { fresh: true }).split("oldest first:\n")[1]!.split("\n");
  assert.ok(long.length < 12 && long.join("\n").length <= 10_000, "the oldest go first once the block runs long");
  assert.match(long.at(-1)!, /^From t+ · worker: 199 /);

  const cold = workspace({ threads: [lead("lead", { ...GROWN, messages: [], historySummary: { messageCount: 200, attachmentCount: 0 } })] });
  const unread = coordinationContext(cold, cold.threads[0]!, { fresh: true });
  assert.match(unread, /^This coordinator continues in a fresh session/);
  assert.doesNotMatch(unread, /The last messages/, "a conversation not loaded yet is left to read_thread");
});

test("a coordinator compacted by hand on Codex keeps its session, measured at the size Codex recounts for the compacted context", () => {
  const codexSession = { continuation: { provider: "codex", value: "thread-1" }, continuationStatus: "available" as const, contextUsage: { tokens: 125_000, limit: 258_400, model: "gpt-6.1-sol" } };
  const state = workspace({ threads: [lead("lead", { engine: "codex", model: "gpt-6.1-sol", ...codexSession })], currentId: "lead" });
  const compacting = reduce(state, { type: "run.compact" });
  const resolved = reduce(compacting.state, { type: "run.resolved", pendingId: effectAt(compacting, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const command = effectAt(resolved, "start-run").command;
  let compacted = resolved.state;
  for (const [sequence, event] of [
    { type: "context.compaction-status", compacting: true },
    { type: "context.usage", tokens: 13_779, limit: 258_400, model: "gpt-6.1-sol" },
    { type: "context.compacted", trigger: "manual", preTokens: 125_000 },
    { type: "context.compaction-status", compacting: false },
    { type: "run.status", status: "succeeded" },
  ].entries()) compacted = reduce(compacted, correlatedRunEvent("lead", command.runId, sequence + 1, event as never)).state;

  assert.equal(compacted.threads[0]?.contextUsage?.tokens, 13_779);
  const run = started(compacted, { type: "task.send", taskId: "lead", text: "What next?" });
  assert.deepEqual(run.command.continuation, codexSession.continuation, "the compacted session is resumed, not replaced");
  assert.equal(run.command.freshSession, undefined);
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
