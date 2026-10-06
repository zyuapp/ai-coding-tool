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
import type { ComputerThreadQuery } from "../../src/contracts/computers.ts";
import { queryLocalThreads } from "../../src/host/thread-reads.ts";
import { PROJECT, activeRun, task, workspace } from "./workspace-reducer-fixtures.mts";

const REMOTE_PROJECT = { id: "remote-project", root: PROJECT.root, workspaceId: "remote-workspace" };

/** A computer's own workspace, which resolves the checkout a send asks for the way the desktop would. */
function computer(initial: WorkspaceState) {
  let state = initial;
  const inputs: WorkspaceInput[] = [];
  const execution: WorkspaceExecutionHost = {
    state: () => state,
    commit: (next) => { state = next; },
    perform: async (effect, dispatch) => {
      if (effect.type === "resolve-run-workspace") await dispatch({ type: "run.resolved", pendingId: effect.pendingId, workspace: { id: "scratch", kind: "projectless", root: "/scratch" } });
    },
  };
  return { state: () => state, set: (next: WorkspaceState) => { state = next; }, inputs, execute: (input: WorkspaceInput) => { inputs.push(input); return executeWorkspaceInput(input, execution); } };
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
  return { host, linux, mirror };
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

test("a remote start names its project there, and a coordinator keeps its threads on its own computer", async () => {
  const { host, linux, mirror } = pair();
  assert.match(await refusal(host, command({ type: "task.send", text: "Go", project: "elsewhere" }, "linux")), /^On Linux: No project matches "elsewhere"/);
  linux.set({ ...linux.state(), projects: [{ ...REMOTE_PROJECT, root: "/other/place" }] });
  await mirror();
  assert.match(await refusal(host, command({ type: "task.send", text: "Go" }, "linux")), /No project on Linux matches repo/);
  host.state().threads[0] = { ...host.state().threads[0], role: "coordinator" };
  const brief = { intent: "go", doneWhen: "done", delivers: "report" as const };
  assert.match(await refusal(host, command({ type: "task.send", text: "Go", brief, project: "place" }, "linux")), /own computer/);
  assert.equal(linux.inputs.length, 0);
});

test("a computer whose build predates signed messages refuses them rather than passing them off as the user's", async () => {
  for (const capabilities of [COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.send:sender"), undefined]) {
    const { host, linux } = pair({ capabilities });
    assert.equal(await refusal(host, command({ type: "task.send", taskId: "remote-id", text: "Hi" })), REMOTE_UNSUPPORTED);
    assert.equal(await refusal(host, command({ type: "task.send", text: "Hi" }, "linux")), REMOTE_UNSUPPORTED);
    assert.equal(linux.inputs.length, 0);
  }
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
