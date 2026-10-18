import assert from "node:assert/strict";
import { test } from "vitest";
import { executeWorkspaceInput, type WorkspaceExecutionHost } from "../../src/application/workspace-execution.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { answerThreadRequest, releaseThreadWaiters, type ThreadRequestHost } from "../../src/host/thread-requests.ts";
import { computerEffects } from "../../src/host/computer-effects.ts";
import type { EffectHost } from "../../src/host/effect-host.ts";
import { COMPUTER_CAPABILITIES, REMOTE_UNSUPPORTED } from "../../src/contracts/computer-capabilities.ts";
import type { ExternalCommand, ThreadCommandResult, ThreadRequest, ThreadWaitResult } from "../../src/contracts/threads.ts";
import type { StartRunCommand } from "../../src/contracts/ipc.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { ComputerThreadQuery } from "../../src/contracts/computers.ts";
import { queryLocalThreads } from "../../src/host/thread-reads.ts";
import { PROJECT, activeRun, task, workspace } from "./workspace-reducer-fixtures.mts";

const REMOTE_PROJECT = { id: "remote-project", root: PROJECT.root, workspaceId: "remote-workspace" };

/** A computer's own workspace, which resolves the checkout a send asks for the way the desktop would. */
function computer(initial: WorkspaceState) {
  let state = initial;
  const inputs: WorkspaceInput[] = [];
  const runs: StartRunCommand[] = [];
  const execution: WorkspaceExecutionHost = {
    state: () => state,
    commit: (next) => { state = next; },
    perform: async (effect, dispatch) => {
      if (effect.type === "resolve-run-workspace") await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: { id: "scratch", kind: "projectless", root: "/scratch" } });
      if (effect.type === "start-run") runs.push(effect.command);
    },
  };
  return { state: () => state, set: (next: WorkspaceState) => { state = next; }, inputs, runs, execute: (input: WorkspaceInput) => { inputs.push(input); return executeWorkspaceInput(input, execution); } };
}

/**
 * This computer, paired with "Linux". A command carried there runs in Linux's own workspace, and
 * Linux's state is mirrored back here the way the link publishes it.
 */
function pair(overrides: Partial<PairedComputer> = {}) {
  const linux = computer(workspace({
    projects: [REMOTE_PROJECT],
    threads: [task("remote-id", { projectId: REMOTE_PROJECT.id, title: "Remote work", messages: [{ id: "reply", kind: "assistant", text: "Tests pass", at: 5 }] })],
  }));
  const initial = workspace({ projects: [PROJECT], threads: [task("caller", { projectId: PROJECT.id, title: "Planner", model: "opus" })] });
  initial.computers = { ...initial.computers, name: "Mac", paired: [{ id: "linux", name: "Linux", host: "linux.test", pairedAt: 1, status: "connected", error: null, state: linux.state(), capabilities: COMPUTER_CAPABILITIES, ...overrides }] };
  let state = initial;
  /** A line that drops once that computer has taken the inputs loses what it would have answered. */
  const line = { answers: true };
  const waiters: ThreadRequestHost["waiters"] = { current: [] };
  const execution: WorkspaceExecutionHost = {
    state: () => state,
    commit: (next) => { state = next; releaseThreadWaiters(waiters, next); },
    perform: async (effect, dispatch) => {
      if (effect.type === "resolve-run-workspace") await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: { id: "local", kind: "projectless", root: "/local" } });
      if (effect.type !== "computer.forward") return;
      const host = { dispatch, desktop: { sendToComputer: async (_id: string, inputs: WorkspaceInput[]) => {
        let result = { ok: true as const } as Awaited<ReturnType<typeof linux.execute>["completed"]>;
        for (const input of inputs) {
          result = await linux.execute(input).completed;
          if (!result.ok) break;
        }
        if (!line.answers) return { ok: false, message: "That computer cannot be reached right now." };
        await dispatch({ type: "computer.state", id: "linux", state: linux.state() });
        return result;
      } } } as unknown as EffectHost;
      await computerEffects["computer.forward"](effect, host);
    },
  };
  const host: ThreadRequestHost = {
    state: () => state,
    desktop: { queryComputerThreads: async (_id: string, query: ComputerThreadQuery) => queryLocalThreads(linux.state, async () => {}, query) } as unknown as ThreadRequestHost["desktop"],
    dispatch: async (input) => { await executeWorkspaceInput(input, execution).completed; },
    execute: (input) => executeWorkspaceInput(input, execution),
    waiters,
  };
  const mirror = () => host.dispatch({ type: "computer.state", id: "linux", state: linux.state() });
  return { host, linux, mirror, line };
}

function command(command: ExternalCommand, computer?: string): ThreadRequest {
  return { type: "thread.request", requestId: "r1", taskId: "caller", op: "command", command, ...(computer ? { computer } : {}) };
}

async function answer<Result>(host: ThreadRequestHost, request: ThreadRequest): Promise<Result> {
  const response = await answerThreadRequest(host, request);
  if (!response.ok) assert.fail(response.message);
  return response.result as Result;
}

async function refusal(host: ThreadRequestHost, request: ThreadRequest): Promise<string> {
  const response = await answerThreadRequest(host, request);
  if (response.ok) assert.fail("expected the request to be refused");
  return response.message;
}

test("a message reaches a thread on a paired computer, named by prefix, signed by the thread and computer it came from", async () => {
  const { host, linux } = pair();
  const { thread } = await answer<ThreadCommandResult>(host, command({ type: "task.send", taskId: "remote", text: "Rebase onto main" }));
  assert.equal(thread?.id, "remote-id");
  assert.equal(thread?.computer?.name, "Linux");
  const received = linux.state().threads.find((item) => item.id === "remote-id")!.messages.at(-1)!;
  assert.equal(received.text, "Rebase onto main");
  assert.deepEqual(received.origin, { kind: "thread", threadId: "caller", title: "Planner", computer: "Mac" });
  assert.equal(received.detail, "From Planner on Mac · caller");
  assert.equal(host.state().threads.find((item) => item.id === "caller")!.messages.length, 0, "nothing lands on this computer");
});

test("stop, role and archive are carried to the computer holding the thread", async () => {
  const { host, linux } = pair();
  await answer(host, command({ type: "task.set-role", taskId: "remote-id", role: "reviewer" }));
  await answer(host, command({ type: "run.cancel", taskId: "remote-id" }));
  await answer(host, command({ type: "task.archive", taskId: "remote-id" }));
  assert.deepEqual(linux.inputs.map((input) => input.type), ["task.set-role", "run.cancel", "task.archive"]);
  assert.equal(linux.state().threads[0].role, "reviewer");
});

test("a thread here moves one on a paired computer signed as itself, and never moves a coordinator there into a worktree, even one the mirror has yet to show", async () => {
  const lead = (state: WorkspaceState) => ({ ...state, threads: state.threads.map((item) => ({ ...item, role: "coordinator" as const })) });
  const shown = pair();
  shown.linux.set(lead(shown.linux.state()));
  await shown.mirror();
  assert.match(await refusal(shown.host, command({ type: "task.move-worktree", taskId: "remote-id", destination: { kind: "new" } })), /^A coordinator stays in its project's checkout/);
  assert.equal(shown.linux.inputs.length, 0, "refused here, where the mirror shows it leads");

  const unseen = pair();
  unseen.linux.set(lead(unseen.linux.state()));
  assert.match(await refusal(unseen.host, command({ type: "task.move-worktree", taskId: "remote-id", destination: { kind: "new" } })), /^A coordinator stays in its project's checkout/);
  assert.deepEqual(unseen.linux.inputs, [{ type: "task.move-worktree", taskId: "remote-id", destination: { kind: "new" }, sender: { threadId: "caller", title: "Planner", computer: "Mac" } }]);
  assert.deepEqual(unseen.linux.state().creatingWorktrees, [], "that computer refuses a move a thread asked for");

  const { host, linux } = pair();
  await answer(host, command({ type: "task.move-worktree", taskId: "remote-id", destination: { kind: "new" } }));
  assert.deepEqual(linux.state().creatingWorktrees, ["remote-id"], "any other thread there still moves");
  const older = pair({ capabilities: COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.move-worktree:sender") });
  await answer(older.host, command({ type: "task.move-worktree", taskId: "remote-id", destination: { kind: "new" } }));
  assert.deepEqual(older.linux.inputs.map((input) => "sender" in input), [false], "a build that cannot hear who asked is sent the move unsigned");
});

test("a thread here never makes one in a worktree on a paired computer a coordinator, even one the mirror has yet to show there", async () => {
  const inWorktree = (state: WorkspaceState) => ({ ...state, threads: state.threads.map((item) => ({ ...item, worktreeId: "wt-there" })) });
  const shown = pair();
  shown.linux.set(inWorktree(shown.linux.state()));
  await shown.mirror();
  assert.match(await refusal(shown.host, command({ type: "task.set-role", taskId: "remote-id", role: "coordinator" })), /^A coordinator stays in its project's checkout/);
  assert.equal(shown.linux.inputs.length, 0);

  const unseen = pair();
  unseen.linux.set(inWorktree(unseen.linux.state()));
  assert.match(await refusal(unseen.host, command({ type: "task.set-role", taskId: "remote-id", role: "coordinator" })), /^A coordinator stays in its project's checkout/);
  assert.deepEqual(unseen.linux.inputs, [{ type: "task.set-role", taskId: "remote-id", role: "coordinator", sender: { threadId: "caller", title: "Planner", computer: "Mac" } }]);
  assert.equal(unseen.linux.state().threads[0].role, undefined, "that computer refuses a role a thread asked for");
  await answer(unseen.host, command({ type: "task.set-role", taskId: "remote-id", role: "reviewer" }));
  assert.equal(unseen.linux.state().threads[0].role, "reviewer", "any other role still goes");

  const older = pair({ capabilities: COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.set-role:sender") });
  await answer(older.host, command({ type: "task.set-role", taskId: "remote-id", role: "reviewer" }));
  assert.deepEqual(older.linux.inputs.map((input) => "sender" in input), [false], "a build that cannot hear who asked is sent the role unsigned");
});

test("a thread here never takes the role off a coordinator on a paired computer, even one the mirror has yet to show leads", async () => {
  const lead = (state: WorkspaceState) => ({ ...state, threads: state.threads.map((item) => ({ ...item, role: "coordinator" as const })) });
  const shown = pair();
  shown.linux.set(lead(shown.linux.state()));
  await shown.mirror();
  assert.equal(await refusal(shown.host, command({ type: "task.set-role", taskId: "remote-id", role: null })), "A coordinator keeps its role until the user changes it from the thread menu.");
  assert.equal(shown.linux.inputs.length, 0);

  const unseen = pair();
  unseen.linux.set(lead(unseen.linux.state()));
  assert.equal(await refusal(unseen.host, command({ type: "task.set-role", taskId: "remote-id", role: "reviewer" })), "A coordinator keeps its role until the user changes it from the thread menu.");
  assert.deepEqual(unseen.linux.inputs, [{ type: "task.set-role", taskId: "remote-id", role: "reviewer", sender: { threadId: "caller", title: "Planner", computer: "Mac" } }]);
  assert.equal(unseen.linux.state().threads[0].role, "coordinator", "that computer refuses it too");
});

test("a thread starts on a paired computer in the project at the same path, inheriting the caller's model", async () => {
  const { host, linux } = pair();
  const { thread } = await answer<ThreadCommandResult>(host, command({ type: "task.send", text: "Run the GPU tests" }, "Linux"));
  const started = linux.state().threads.find((item) => item.id !== "remote-id");
  assert.ok(started);
  assert.equal(thread?.id, started.id);
  assert.equal(thread?.computer?.id, "linux");
  assert.equal(started.projectId, REMOTE_PROJECT.id);
  assert.equal(started.model, "opus");
  assert.equal(started.messages[0].detail, "From Planner on Mac · caller");
  assert.equal(host.state().threads.length, 1);
});

test("a remote start names its project there", async () => {
  const { host, linux, mirror } = pair();
  assert.match(await refusal(host, command({ type: "task.send", text: "Go", project: "elsewhere" }, "linux")), /^On Linux: No project matches "elsewhere"/);
  linux.set({ ...linux.state(), projects: [{ ...REMOTE_PROJECT, root: "/other/place" }] });
  await mirror();
  assert.match(await refusal(host, command({ type: "task.send", text: "Go" }, "linux")), /No project on Linux matches repo/);
  assert.equal(linux.inputs.length, 0);
});

const BRIEF = { intent: "run the GPU tests", doneWhen: "they pass", delivers: "report" as const };

/** Makes the caller a coordinator here, keeping what its threads run on and its memory. */
function lead(host: ThreadRequestHost, overrides: Partial<Thread> = {}) {
  host.state().threads[0] = {
    ...host.state().threads[0]!,
    role: "coordinator",
    threadModel: { model: "opus", effort: "high" },
    memory: { purpose: "Ship v2", notes: [{ id: "n1", text: "Prefer small PRs", at: 1 }], revision: 1, heard: 1 },
    ...overrides,
  };
}

function proposals(host: ThreadRequestHost) {
  return host.state().threads.find((thread) => thread.id === "caller")?.proposals ?? [];
}

test("a coordinator's start on another computer waits for the user to allow it", async () => {
  const { host, linux } = pair();
  lead(host);
  const asked = await answer<ThreadCommandResult>(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF, worktree: true }, "Linux"));
  assert.deepEqual(asked, { thread: null, notice: "Waiting for the user to allow it on Linux in /repo. You hear once it starts and when it ends a turn." });
  const [waiting] = proposals(host);
  assert.equal(waiting?.title, "Run the GPU tests");
  assert.deepEqual(waiting?.brief, BRIEF);
  assert.deepEqual(waiting?.place, { computer: { id: "linux", name: "Linux" }, project: REMOTE_PROJECT.id, worktree: true });
  assert.equal(waiting?.model, undefined, "it runs on what the coordinator's threads run on when it starts");

  const suggested = await answer<{ note: string }>(host, { type: "thread.request", requestId: "p", taskId: "caller", op: "propose", proposals: [{ title: "Bench", prompt: "Time it", brief: BRIEF, computer: "linux" }] });
  assert.match(suggested.note, /^Suggested 1 thread\./);
  assert.equal(proposals(host)[1]?.place.computer?.id, "linux");
  assert.match(await refusal(host, command({ type: "task.send", text: "Go", brief: BRIEF, worktreeId: "wt-there" }, "Linux")), /cannot be named/);
  assert.equal(linux.inputs.length, 0, "nothing starts there until the user allows it");
});

test("allowing it forwards a send carrying the name, brief, memory, model and the coordinator it works under", async () => {
  const { host, linux } = pair();
  lead(host);
  await answer(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF, title: "GPU tests" }, "Linux"));
  const [waiting] = proposals(host);
  const allowed = await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id, place: { project: REMOTE_PROJECT.id, worktree: false } }).completed;
  assert.equal(allowed.ok, true);
  const sent = linux.inputs.find((input) => input.type === "task.send");
  assert.ok(sent?.type === "task.send");
  assert.deepEqual(sent.lead, { threadId: "caller", title: "Planner", computer: "Mac", proposalId: waiting!.id });
  assert.deepEqual(sent.sender, { threadId: "caller", title: "Planner", computer: "Mac" });
  assert.equal(sent.memory, "The coordinator's purpose: Ship v2\nWhat the coordinator keeps in memory:\n- [n1] Prefer small PRs");
  assert.deepEqual([sent.model, sent.effort, sent.project, sent.worktree], ["opus", "high", REMOTE_PROJECT.id, false]);
  assert.deepEqual(sent.brief, BRIEF);
  assert.equal(sent.title, "GPU tests");

  const started = linux.state().threads.find((thread) => thread.remoteLead);
  assert.ok(started, "the thread starts there, under the coordinator here");
  assert.equal(started.title, "GPU tests", "it is named there what its card said here");
  assert.deepEqual(started.remoteLead, { threadId: "caller", title: "Planner", computer: "Mac", proposalId: waiting!.id });
  assert.deepEqual(started.brief, BRIEF);
  assert.equal(started.model, "opus");
  const run = linux.runs.find((item) => item.taskId === started.id);
  assert.equal(run?.coordinationRole, "member", "it runs with a member's instructions and tools there");
  assert.match(run?.prompt ?? "", /Brief from the coordinator that started this thread:[\s\S]*The coordinator's purpose: Ship v2[\s\S]*- \[n1\] Prefer small PRs/);

  assert.deepEqual(proposals(host), [], "an allowed request is done with once the thread exists");
  assert.deepEqual(host.state().startingProposals, []);
  const notes = host.state().threads[0]!.coordinationNotes ?? [];
  assert.deepEqual(notes.map((note) => [note.text, note.quiet]), [["\"GPU tests\" started on Linux.", true]], "it shows up quietly");
});

test("allowing it again after its answer was lost starts nothing new there, and its card settles on the thread that did start", async () => {
  const { host, linux, mirror, line } = pair();
  lead(host);
  await answer(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF, title: "GPU tests" }, "Linux"));
  const [waiting] = proposals(host);
  line.answers = false;
  await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
  assert.equal(proposals(host)[0]?.error, "That computer cannot be reached right now.", "the start went through there, but nothing here heard so");

  line.answers = true;
  const again = await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
  assert.equal(again.ok, true);
  const started = linux.state().threads.filter((thread) => thread.remoteLead);
  assert.equal(started.length, 1, "that computer names the thread it already started");
  assert.deepEqual(proposals(host), []);
  assert.deepEqual(host.state().startingProposals, []);
  await mirror();
  assert.deepEqual(proposals(host), []);
});

test("a thread under the coordinator asks for one elsewhere as itself, and it works under the coordinator", async () => {
  const { host, linux } = pair();
  lead(host);
  host.state().threads.push({ ...host.state().threads[0]!, id: "member", title: "Builder", role: undefined, parentId: "caller", memory: undefined, threadModel: undefined });
  const asked = await answer<ThreadCommandResult>(host, { type: "thread.request", requestId: "m", taskId: "member", op: "command", command: { type: "task.send", text: "Profile it" }, computer: "Linux" });
  assert.deepEqual(asked, { thread: null, notice: "Waiting for the user to allow it on Linux in /repo. Your coordinator hears once it starts." }, "what a thread there says is told to the coordinator");
  const [waiting] = proposals(host);
  assert.equal(waiting?.from, "member");
  assert.equal(waiting?.brief, undefined);
  await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
  const sent = linux.inputs.find((input) => input.type === "task.send");
  assert.ok(sent?.type === "task.send");
  assert.equal(sent.sender?.threadId, "member");
  assert.equal(sent.lead?.threadId, "caller");
  assert.equal(waiting?.title, "Profile it", "its card is labelled by its prompt");
  assert.equal("title" in sent, false, "and it starts there unnamed, so its name is written there");
});

test("one asked for by a thread that has since left the coordinator says so on the Allow page", async () => {
  const { host, linux } = pair();
  lead(host);
  host.state().threads.push({ ...host.state().threads[0]!, id: "member", title: "Builder", role: undefined, parentId: "caller", memory: undefined, threadModel: undefined });
  await answerThreadRequest(host, { type: "thread.request", requestId: "m", taskId: "member", op: "command", command: { type: "task.send", text: "Profile it" }, computer: "Linux" });
  await host.dispatch({ type: "task.set-coordinator", taskId: "member", coordinatorId: null });
  const [waiting] = proposals(host);
  const refused = await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
  assert.deepEqual(refused, { ok: false, message: "The thread that asked for this no longer works under this coordinator." });
  assert.equal(proposals(host)[0]?.error, "The thread that asked for this no longer works under this coordinator.");
  assert.equal(linux.inputs.length, 0);
});

test("denying it is heard quietly", async () => {
  const { host, linux } = pair();
  lead(host);
  await answer(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF }, "Linux"));
  await host.dispatch({ type: "proposal.dismiss", taskId: "caller", proposalId: proposals(host)[0]!.id });
  assert.deepEqual(proposals(host), []);
  const [note] = host.state().threads[0]!.coordinationNotes ?? [];
  assert.equal(note?.text, "The user did not allow \"Run the GPU tests\" to run on Linux.");
  assert.equal(note?.quiet, true);
  assert.deepEqual(Object.keys(host.state().pendingRuns), [], "nothing wakes the coordinator");
  assert.equal(linux.inputs.length, 0);
});

test("dismissing one allowed whose answer was lost gives it up rather than denying it", async () => {
  const { host, line } = pair();
  lead(host);
  await answer(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF }, "Linux"));
  const [waiting] = proposals(host);
  line.answers = false;
  await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
  await host.dispatch({ type: "proposal.dismiss", taskId: "caller", proposalId: waiting!.id });
  assert.deepEqual(proposals(host), []);
  const [note] = host.state().threads[0]!.coordinationNotes ?? [];
  assert.equal(note?.text, "The user gave up on starting \"Run the GPU tests\" on Linux. If it started there after all, you will hear from it.");
  assert.equal(note?.quiet, true);
});

test("dismissing one refused here before it ever went denies it, but not one an earlier allow carried there", async () => {
  for (const lostFirst of [false, true]) {
    const { host, linux, line } = pair();
    lead(host);
    await answer(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF }, "Linux"));
    const [waiting] = proposals(host);
    if (lostFirst) {
      line.answers = false;
      await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
    }
    const sent = linux.inputs.length;
    host.state().computers.paired[0]!.status = "offline";
    const refused = await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
    assert.equal(refused.ok, false);
    assert.equal(linux.inputs.length, sent, "a computer whose line is down is sent nothing");
    await host.dispatch({ type: "proposal.dismiss", taskId: "caller", proposalId: waiting!.id });
    const [note] = host.state().threads[0]!.coordinationNotes ?? [];
    assert.equal(note?.text, lostFirst
      ? "The user gave up on starting \"Run the GPU tests\" on Linux. If it started there after all, you will hear from it."
      : "The user did not allow \"Run the GPU tests\" to run on Linux.");
  }
});

test("an older computer, or one that advertises no capabilities, cannot take one", async () => {
  for (const capabilities of [COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.send:lead"), undefined]) {
    const { host, linux } = pair({ capabilities });
    lead(host);
    await answer(host, command({ type: "task.send", text: "Run the GPU tests", brief: BRIEF }, "Linux"));
    const [waiting] = proposals(host);
    const refused = await host.execute({ type: "proposal.start", taskId: "caller", proposalId: waiting!.id }).completed;
    assert.deepEqual(refused, { ok: false, message: "Update AI Coding Tool on Linux to run threads there." });
    assert.equal(proposals(host)[0]?.error, "Update AI Coding Tool on Linux to run threads there.");
    assert.deepEqual(host.state().startingProposals, []);
    assert.equal(linux.inputs.length, 0);
  }
});

test("a thread named into a paired computer's project by id starts there, signed and under the same rules", async () => {
  const { host, linux } = pair();
  const { thread } = await answer<ThreadCommandResult>(host, command({ type: "task.send", text: "Go", project: REMOTE_PROJECT.id }));
  assert.equal(thread?.computer?.id, "linux");
  assert.equal(linux.state().threads.find((item) => item.id === thread?.id)?.messages[0].detail, "From Planner on Mac · caller");
  assert.match(await refusal(host, command({ type: "task.send", text: "Go", project: REMOTE_PROJECT.id }, "this")), /That project or worktree is on Linux/);
  host.state().threads[0] = { ...host.state().threads[0], role: "coordinator" };
  const brief = { intent: "go", doneWhen: "done", delivers: "report" as const };
  const { notice } = await answer<ThreadCommandResult>(host, command({ type: "task.send", text: "Go", brief, project: REMOTE_PROJECT.id }));
  assert.match(notice ?? "", /^Waiting for the user to allow it on Linux/);
  assert.equal(linux.state().threads.length, 2);
});

test("a thread named at its start keeps that name on a paired computer, and one whose build cannot take a name names it itself", async () => {
  const { host, linux } = pair();
  const { thread } = await answer<ThreadCommandResult>(host, command({ type: "task.send", text: "Run the GPU tests", title: "GPU tests" }, "Linux"));
  assert.equal(linux.state().threads.find((item) => item.id === thread?.id)?.title, "GPU tests");

  const older = pair({ capabilities: COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.send:title") });
  const { thread: started } = await answer<ThreadCommandResult>(older.host, command({ type: "task.send", text: "Run the GPU tests", title: "GPU tests" }, "Linux"));
  const sent = older.linux.inputs.find((input) => input.type === "task.send");
  assert.ok(sent?.type === "task.send");
  assert.equal("title" in sent, false, "the start goes without the name rather than being refused");
  assert.equal(older.linux.state().threads.find((item) => item.id === started?.id)?.title, "Run the GPU tests");
});

test("a computer whose build predates signed messages refuses them rather than passing them off as the user's", async () => {
  for (const capabilities of [COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.send:sender"), undefined]) {
    const { host, linux } = pair({ capabilities });
    assert.equal(await refusal(host, command({ type: "task.send", taskId: "remote-id", text: "Hi" })), REMOTE_UNSUPPORTED);
    assert.equal(await refusal(host, command({ type: "task.send", text: "Hi" }, "linux")), REMOTE_UNSUPPORTED);
    assert.equal(linux.inputs.length, 0);
  }
});

test("a start or suggestion for every computer is refused rather than going to one of them", async () => {
  const ONE = 'A thread runs on one computer. Use "this", or a paired computer\'s name or ID.';
  const { host, linux } = pair();
  assert.equal(await refusal(host, command({ type: "task.send", text: "Go" }, "all")), ONE);
  lead(host);
  assert.equal(await refusal(host, command({ type: "task.send", text: "Go", brief: BRIEF }, "all")), ONE);
  const propose: ThreadRequest = { type: "thread.request", requestId: "p", taskId: "caller", op: "propose", proposals: [{ title: "Bench", prompt: "Time it", brief: BRIEF, computer: "all" }] };
  assert.equal(await refusal(host, propose), `Not suggested "Bench": ${ONE}`);
  assert.deepEqual(proposals(host), []);
  assert.equal(linux.inputs.length, 0);

  host.state().computers.paired = [];
  assert.equal(await refusal(host, command({ type: "task.send", text: "Go" }, "all")), ONE, "with nothing paired it does not start here instead");
  assert.equal(host.state().threads.length, 1);
});

test("a new thread asked for here starts here even with a paired computer's thread on screen", async () => {
  const { host, linux } = pair();
  host.state().computers.active = "linux";
  const { thread } = await answer<ThreadCommandResult>(host, command({ type: "task.send", text: "Local work" }));
  assert.equal(thread?.computer, undefined);
  await answer(host, command({ type: "task.send", text: "By path", project: PROJECT.root }, "this"));
  host.state().threads[0] = { ...host.state().threads[0], projectId: undefined };
  await answer(host, command({ type: "task.send", text: "No project" }));
  assert.equal(host.state().threads.length, 4);
  assert.equal(linux.inputs.length, 0);
});

test("waiting on a paired computer's thread settles when its mirrored state stops working", async () => {
  const { host, linux, mirror } = pair();
  linux.set({ ...linux.state(), activeRuns: { "remote-id": activeRun("remote-id", "run-1") } });
  await mirror();
  const waiting = answer<ThreadWaitResult>(host, { type: "thread.request", requestId: "w", taskId: "caller", op: "wait", threadId: "remote-id", timeoutMs: 60_000 });
  await Promise.resolve();
  assert.equal(host.waiters.current.length, 1);
  linux.set({ ...linux.state(), activeRuns: {} });
  await mirror();
  const waited = await waiting;
  assert.equal(waited.timedOut, false);
  assert.equal(waited.reply, "Tests pass");
  assert.equal(waited.thread.computer?.name, "Linux");
});

test("a wait on a paired computer's thread whose history is not loaded there reads its reply from that computer", async () => {
  const { host, linux } = pair();
  const loaded = linux.state();
  host.state().computers.paired[0] = { ...host.state().computers.paired[0], state: { ...loaded, threads: loaded.threads.map((thread) => ({ ...thread, messages: [], historySummary: { messageCount: 1, attachmentCount: 0 } })) } };
  const waited = await answer<ThreadWaitResult>(host, { type: "thread.request", requestId: "w", taskId: "caller", op: "wait", threadId: "remote-id", timeoutMs: 1_000 });
  assert.equal(waited.reply, "Tests pass");
});

test("a wait ends with an error when the paired computer drops", async () => {
  const { host, linux, mirror } = pair();
  linux.set({ ...linux.state(), activeRuns: { "remote-id": activeRun("remote-id", "run-1") } });
  await mirror();
  const waiting = answerThreadRequest(host, { type: "thread.request", requestId: "w", taskId: "caller", op: "wait", threadId: "remote-id", timeoutMs: 60_000 });
  await Promise.resolve();
  await host.dispatch({ type: "computers.changed", name: "Mac", links: [{ id: "linux", name: "Linux", host: "linux.test", pairedAt: 1, status: "offline", error: null }] });
  const response = await waiting;
  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.message, /Linux is offline/);
});
