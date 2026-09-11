import { mountWorkspace } from "../support/workspace-renderer.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";
import type { ThreadResponse } from "../../src/contracts/threads.ts";
import type { Thread } from "../../src/domain/thread.ts";

import { item } from "../support/renderer-dom.mts";
import { settleFrame } from "../support/settle.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

type ThreadSummary = import("../../src/contracts/threads.ts").ThreadSummary;
type ThreadTranscript = import("../../src/contracts/threads.ts").ThreadTranscript;
type ThreadCommandResult = import("../../src/contracts/threads.ts").ThreadCommandResult;
type ThreadWaitResult = import("../../src/contracts/threads.ts").ThreadWaitResult;

function responseResult(response: ThreadResponse | undefined): unknown {
  const actual = item(response);
  if (!actual.ok) assert.fail(actual.message);
  return actual.result;
}

function responseRecord(response: ThreadResponse | undefined): Record<string, unknown> {
  const result = responseResult(response);
  assert.ok(result !== null && typeof result === "object" && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function threadListResult(response: ThreadResponse | undefined): ThreadSummary[] {
  const result = responseResult(response);
  assert.ok(Array.isArray(result));
  for (const thread of result) assert.equal(typeof (thread as Record<string, unknown>).id, "string");
  return result as ThreadSummary[];
}

function threadTranscriptResult(response: ThreadResponse | undefined): ThreadTranscript {
  const result = responseRecord(response);
  assert.ok(Array.isArray(result.messages));
  assert.ok(result.thread !== null && typeof result.thread === "object");
  return result as ThreadTranscript;
}

function threadCommandResult(response: ThreadResponse | undefined): ThreadCommandResult {
  const result = responseRecord(response);
  assert.ok(result.thread === null || typeof result.thread === "object");
  return result as ThreadCommandResult;
}

function threadWaitResult(response: ThreadResponse | undefined): ThreadWaitResult {
  const result = responseRecord(response);
  assert.equal(typeof result.timedOut, "boolean");
  assert.ok(result.thread !== null && typeof result.thread === "object");
  return result as ThreadWaitResult;
}

function failedThreadResponse(response: ThreadResponse | undefined): Extract<ThreadResponse, { ok: false }> {
  const actual = item(response);
  assert.equal(actual.ok, false);
  if (actual.ok) assert.fail("Expected the thread request to fail");
  return actual;
}

test("the window answers thread requests from the reducer's own state", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const started = workspace.get().currentThread;
  assert.ok(started, "a thread exists to ask about");

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: started.id, op: "list" }); });
  const listed = threadListResult(desktop.threadAnswers.at(-1));
  assert.deepEqual(listed.map((thread) => thread.id), [started.id]);

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: started.id, op: "read", threadId: started.id }); });
  assert.deepEqual(threadTranscriptResult(desktop.threadAnswers.at(-1)).messages.map((message) => message.text), ["Fix the header"]);

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r3", taskId: started.id, op: "read", threadId: "ghost" }); });
  assert.match(failedThreadResponse(desktop.threadAnswers.at(-1)).message, /No thread has the ID ghost/);

  await workspace.view.unmount();
});

test("a thread command reaches the reducer and reports the thread it acted on", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const caller = item(workspace.get().currentThread);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: caller.id, op: "command", command: { type: "task.send", text: "Implement item 2" } });
  });
  const answer = threadCommandResult(desktop.threadAnswers.at(-1));
  const answeredThread = item(answer.thread);
  assert.notEqual(answeredThread.id, caller.id, "the send started its own thread");
  assert.equal(item(workspace.get().currentThread).id, caller.id, "the user stays where they were");
  assert.equal(desktop.sent.filter((command) => command.type === "start").length, 2);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: caller.id, op: "command", command: { type: "task.archive", taskId: answeredThread.id } });
  });
  assert.equal(item(threadCommandResult(desktop.threadAnswers.at(-1)).thread).archived, true);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r3", taskId: caller.id, op: "command", command: { type: "task.archive", taskId: "ghost" } });
  });
  failedThreadResponse(desktop.threadAnswers.at(-1));

  await workspace.view.unmount();
});

test("a send answers before the title it asked for, and takes the title once it arrives", async () => {
  let name: ((title: string | null) => void) | undefined;
  const desktop = fakeDesktop({ suggestTaskTitle: () => new Promise((resolve) => { name = resolve; }) });
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const caller = item(workspace.get().currentThread);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: caller.id, op: "command", command: { type: "task.send", text: "Implement item 2" } });
  });
  const answered = item(threadCommandResult(desktop.threadAnswers.at(-1)).thread);
  assert.equal(desktop.sent.filter((command) => command.type === "start").length, 2, "both runs started while the titles were still pending");

  await act(async () => { item(name)("Header repair"); });
  assert.equal(workspace.get().threads.find((thread) => thread.id === answered.id)?.title, "Header repair");

  await workspace.view.unmount();
});

test("a new thread inherits agent settings and can select any registered model", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => {
    workspace.get().actions.setModel("claude", "sonnet");
    workspace.get().actions.setEffort("claude", "max");
    workspace.get().actions.setPrompt("Coordinate the work");
  });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const caller = item(workspace.get().currentThread);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "inherit", taskId: caller.id, op: "command", command: { type: "task.send", text: "Inherit my settings" } });
  });
  const inherited = startCommand(desktop.sent.at(-1));
  assert.equal(inherited.engine, "claude");
  assert.equal(inherited.model, "sonnet");
  assert.equal(inherited.effort, "max");

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "switch", taskId: caller.id, op: "command", command: { type: "task.send", text: "Use Luna", model: "gpt-5.6-luna" } });
  });
  const switched = startCommand(desktop.sent.at(-1));
  assert.equal(switched.engine, "codex");
  assert.equal(switched.model, "gpt-5.6-luna");
  assert.equal(switched.effort, "max", "an inherited effort the new model takes comes across");

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "override", taskId: caller.id, op: "command", command: { type: "task.send", text: "Use Luna lightly", model: "gpt-5.6-luna", effort: "low" } });
  });
  assert.equal(startCommand(desktop.sent.at(-1)).effort, "low");

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "invalid", taskId: caller.id, op: "command", command: { type: "task.send", text: "Use Luna", model: "gpt-5.6-luna", effort: "ultra" } });
  });
  assert.match(failedThreadResponse(desktop.threadAnswers.at(-1)).message, /does not support ultra effort/);

  await workspace.view.unmount();
});

test("a new thread starts in the caller's worktree unless the command places it elsewhere", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const worktree = { id: "wt-caller", projectId: project.id, root: "/worktrees/repo-caller", workspaceId: "worktree-caller", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  const caller: Thread = {
    id: "task-1", title: "Add the header", projectId: project.id, worktreeId: worktree.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  const desktop = fakeDesktop({ loadTaskStore: async () => ({ version: 2, hiddenTasks: 0, projects: [project], worktrees: [worktree], tasks: [caller], lastFolder: project.root }) });
  const workspace = await mountWorkspace(desktop);
  await settleFrame();

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "shared", taskId: caller.id, op: "command", command: { type: "task.send", text: "Review the header" } });
  });
  const shared = item(threadCommandResult(desktop.threadAnswers.at(-1)).thread);
  assert.equal(shared.worktreeId, worktree.id, "the reviewer reads the same checkout as the thread that asked for it");
  assert.equal(startCommand(desktop.sent.at(-1)).workspaceId, worktree.workspaceId);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "own", taskId: caller.id, op: "command", command: { type: "task.send", text: "Try another approach", worktree: true } });
  });
  const own = item(threadCommandResult(desktop.threadAnswers.at(-1)).thread);
  assert.notEqual(own.worktreeId, worktree.id, "asking for a worktree of its own is honoured");

  await workspace.view.unmount();
});

test("a wait is held open until the thread it names stops working", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const running = item(workspace.get().currentThread);
  const runId = startCommand(desktop.sent.at(-1)).runId;

  await act(async () => {
    for (const [index, threadId] of [running.id, running.title, running.id.slice(0, 8)].entries()) {
      desktop.askThreads({ type: "thread.request", requestId: `wait-${index}`, taskId: running.id, op: "wait", threadId, timeoutMs: 60_000 });
    }
  });
  assert.equal(desktop.threadAnswers.length, 0, "waits by ID, title, and prefix remain open while the run goes");

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: running.id, runId, sequence: 1, messageId: "reply-1", text: "Header fixed." });
    desktop.listener({ type: "run.status", taskId: running.id, runId, sequence: 2, status: "succeeded" });
  });
  await settleFrame();
  await act(async () => {});

  assert.equal(desktop.threadAnswers.length, 3);
  for (const response of desktop.threadAnswers) {
    const waited = threadWaitResult(response);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.reply, "Header fixed.");
    assert.equal(waited.thread.status, "idle");
  }

  await workspace.view.unmount();
});

test("a wait on a thread that is already idle answers at once, and an unknown thread fails", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const started = item(workspace.get().currentThread);
  const runId = startCommand(desktop.sent.at(-1)).runId;
  await act(async () => { desktop.listener({ type: "run.status", taskId: started.id, runId, sequence: 1, status: "succeeded" }); });
  await settleFrame();

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: started.id, op: "wait", threadId: started.id, timeoutMs: 60_000 }); });
  assert.equal(threadWaitResult(desktop.threadAnswers.at(-1)).timedOut, false);

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: started.id, op: "wait", threadId: "ghost", timeoutMs: 60_000 }); });
  failedThreadResponse(desktop.threadAnswers.at(-1));

  await workspace.view.unmount();
});
