import assert from "node:assert/strict";
import { test } from "vitest";
import { applyMobilePatch, diffMobileView, emptyMobileView, MOBILE_TRANSCRIPT_MESSAGES, projectMobileView } from "../../src/application/mobile-projection.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ActiveRun, ApprovalView } from "../../src/application/task-workspace.ts";
import type { Task, TaskMessage } from "../../src/domain/task.ts";

const NOW = 1_800_000_000_000;

function message(text: string, at: number, kind: TaskMessage["kind"] = "user"): TaskMessage {
  return { id: `${text}-${at}`, kind, text, at };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: NOW },
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspace(tasks: Task[], overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    ...emptyWorkspaceState(),
    tasks,
    projects: [{ id: "project-app", root: "/code/app", name: "App" }, { id: "project-site", root: "/code/site" }],
    ...overrides,
  };
}

function activeRun(taskId: string, runId: string, status: ActiveRun["status"]): ActiveRun {
  return {
    origin: "composer",
    quiet: false,
    taskId,
    runId,
    sequence: 1,
    status,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 0,
    before: { updatedAt: NOW },
  };
}

const approval: ApprovalView = {
  approvalId: "approval-1",
  taskId: "in-app",
  runId: "run-1",
  title: "Run a command",
  description: "rm -rf build",
  toolName: "Bash",
  input: { command: "rm -rf build" },
};

test("the list is grouped by project, and projectless threads come last", () => {
  const state = workspace([
    task("in-app", { projectId: "project-app", updatedAt: NOW }),
    task("in-site", { projectId: "project-site", updatedAt: NOW - 1_000 }),
    task("loose", { updatedAt: NOW - 2_000 }),
    task("gone", { projectId: "project-app", archivedAt: NOW }),
  ]);

  const view = projectMobileView(state, NOW);
  assert.deepEqual(view.groups.map((group) => [group.projectId, group.name]), [
    ["project-app", "App"],
    ["project-site", "site"],
    [null, "Recents"],
  ]);
  assert.deepEqual(view.groups[0]!.threads.map((thread) => thread.id), ["in-app"], "archived threads are not listed");
  assert.equal(view.thread, null, "nothing is open");
});

test("a project with nothing in it is still a group, because a group is how a phone starts a thread", () => {
  const empty = projectMobileView(workspace([]), NOW);
  assert.deepEqual(empty.groups.map((group) => [group.projectId, group.threads.length]), [
    ["project-app", 0],
    ["project-site", 0],
    [null, 0],
  ]);

  const settled = projectMobileView(workspace([task("in-app", { projectId: "project-app" })]), NOW);
  assert.deepEqual(settled.groups.map((group) => group.projectId), ["project-app", "project-site", null],
    "a thread outside every project can still be started when every thread has one");
});

test("what went wrong after the phone was acknowledged travels as part of the view", () => {
  const state = workspace([task("thread-1")], { currentId: "thread-1", actionError: "That worktree is busy." });
  const failed = projectMobileView(state, NOW);
  assert.equal(failed.error, "That worktree is busy.");

  const clear = projectMobileView({ ...state, actionError: null }, NOW);
  assert.deepEqual(diffMobileView(failed, clear), { error: null });
  assert.equal(applyMobilePatch(failed, { error: null }).error, null);
  assert.equal(applyMobilePatch(failed, { groups: [] }).error, "That worktree is busy.", "a patch that says nothing about it leaves it alone");
});

test("a running thread and a blocked one are told apart in the list", () => {
  const state = workspace([task("running", { projectId: "project-app" }), task("asking", { projectId: "project-app" })], {
    activeRuns: { running: activeRun("running", "run-1", "running"), asking: activeRun("asking", "run-2", "awaiting-approval") },
    runStatuses: { running: "running", asking: "running" },
  });

  const statuses = projectMobileView(state, NOW).groups[0]!.threads.map((thread) => [thread.id, thread.status]);
  assert.deepEqual(statuses.sort(), [["asking", "awaiting-approval"], ["running", "running"]]);
});

test("the open thread carries its transcript, approval, queue, draft and settings", () => {
  const state = workspace([
    task("in-app", {
      projectId: "project-app",
      model: "sonnet",
      effort: "high",
      engine: "claude",
      executionPolicy: "allow-edits",
      messages: [message("do it", NOW - 2_000), message("on it", NOW - 1_000, "assistant")],
    }),
  ], {
    currentId: "in-app",
    activeRuns: { "in-app": activeRun("in-app", "run-1", "awaiting-approval") },
    runStatuses: { "in-app": "running" },
    approvals: { "run-1": approval },
    queuedMessages: { "in-app": [{ id: "queued-1", text: "then this", prompt: "then this", attachments: [] }] },
    prompts: { "in-app": "half typed" },
    streamingTails: { "in-app": { messageId: "message-9", text: "still writ" } },
  });

  const thread = projectMobileView(state, NOW).thread;
  assert.ok(thread);
  assert.equal(thread.id, "in-app");
  assert.equal(thread.projectName, "App");
  assert.deepEqual(thread.messages.map((entry) => entry.text), ["do it", "on it"]);
  assert.equal(thread.omitted, 0);
  assert.equal(thread.status, "awaiting-approval");
  assert.equal(thread.streamingTail, "still writ");
  assert.equal(thread.approval?.approvalId, "approval-1");
  assert.equal(thread.approval?.toolName, "Bash");
  assert.match(thread.approval!.detail, /rm -rf build/);
  assert.deepEqual(thread.queued, [{ id: "queued-1", text: "then this" }]);
  assert.equal(thread.prompt, "half typed");
  assert.deepEqual(thread.settings, { engine: "claude", model: "sonnet", effort: "high", policy: "allow-edits" });
});

test("a Mac with no thread open describes the one it is about to start", () => {
  const state = workspace([task("in-app", { projectId: "project-app" })], {
    draftProjectId: "project-app",
    draftModel: "sonnet",
    draftEffort: "low",
    draftPolicy: "autonomous",
    prompts: { "draft:project-app": "half typed" },
  });

  const view = projectMobileView(state, NOW);
  assert.equal(view.thread, null);
  assert.deepEqual(view.draft, {
    projectName: "App",
    prompt: "half typed",
    settings: { engine: "claude", model: "sonnet", effort: "low", policy: "autonomous" },
  });

  const open = projectMobileView({ ...state, currentId: "in-app" }, NOW);
  assert.equal(open.draft, null, "a thread and a thread yet to exist are never both open");
});

test("starting and finishing a draft both travel, and a patch puts them back", () => {
  const open = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app" });
  const drafting = workspace([task("in-app", { projectId: "project-app" })], { draftProjectId: "project-app" });

  const started = diffMobileView(projectMobileView(open, NOW), projectMobileView(drafting, NOW));
  assert.equal(started?.thread?.kind, "closed");
  assert.equal(started?.draft?.projectName, "App");
  assert.deepEqual(applyMobilePatch(projectMobileView(open, NOW), started!), projectMobileView(drafting, NOW));

  const sent = diffMobileView(projectMobileView(drafting, NOW), projectMobileView(open, NOW));
  assert.equal(sent?.thread?.kind, "opened");
  assert.equal(sent?.draft, null);
  assert.deepEqual(applyMobilePatch(projectMobileView(drafting, NOW), sent!), projectMobileView(open, NOW));

  const typed = workspace([task("in-app", { projectId: "project-app" })], { draftProjectId: "project-app", prompts: { "draft:project-app": "one word" } });
  const moved = diffMobileView(projectMobileView(drafting, NOW), projectMobileView(typed, NOW));
  assert.deepEqual(moved, { draft: { projectName: "App", prompt: "one word", settings: { engine: "claude", model: "opus", effort: "high", policy: "confirm" } } });
});

test("the transcript is bounded in both directions", () => {
  const messages = Array.from({ length: MOBILE_TRANSCRIPT_MESSAGES + 5 }, (_, index) => message(`m${index}`, NOW - index));
  messages.push(message("x".repeat(10_000), NOW));
  const state = workspace([task("in-app", { projectId: "project-app", messages })], { currentId: "in-app" });

  const thread = projectMobileView(state, NOW).thread;
  assert.ok(thread);
  assert.equal(thread.messages.length, MOBILE_TRANSCRIPT_MESSAGES);
  assert.equal(thread.omitted, 6);
  assert.ok(thread.messages.at(-1)!.text.length < 10_000, "a long message is cut short");
  assert.match(thread.messages.at(-1)!.text, /…$/);
});

test("a view that has not moved is no patch at all", () => {
  const state = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app" });
  const view = projectMobileView(state, NOW);
  assert.equal(diffMobileView(view, projectMobileView(state, NOW)), null);
});

test("a message arriving costs an append, not a transcript", () => {
  const before = workspace([task("in-app", { projectId: "project-app", messages: [message("do it", NOW - 1_000)] })], { currentId: "in-app" });
  const after = workspace([task("in-app", { projectId: "project-app", messages: [message("do it", NOW - 1_000), message("on it", NOW, "assistant")] })], { currentId: "in-app" });

  const patch = diffMobileView(projectMobileView(before, NOW), projectMobileView(after, NOW));
  assert.ok(patch);
  assert.ok(patch.groups, "the thread moved up the list");
  assert.equal(patch.thread?.kind, "changed");
  assert.ok(patch.thread?.kind === "changed");
  assert.deepEqual(patch.thread.delta.appended?.map((entry) => entry.text), ["on it"]);
  assert.equal(patch.thread.delta.messages, undefined);
  assert.deepEqual(applyMobilePatch(projectMobileView(before, NOW), patch), projectMobileView(after, NOW));
});

test("a transcript that did not simply grow is replaced whole", () => {
  const before = workspace([task("in-app", { projectId: "project-app", messages: [message("do it", NOW - 1_000)] })], { currentId: "in-app" });
  const after = workspace([task("in-app", { projectId: "project-app", messages: [message("do that instead", NOW - 1_000)] })], { currentId: "in-app" });

  const patch = diffMobileView(projectMobileView(before, NOW), projectMobileView(after, NOW));
  assert.ok(patch?.thread?.kind === "changed");
  assert.equal(patch.thread.delta.appended, undefined);
  assert.deepEqual(patch.thread.delta.messages?.map((entry) => entry.text), ["do that instead"]);
});

test("opening, changing and closing a thread are three different patches", () => {
  const none = workspace([task("in-app", { projectId: "project-app" })]);
  const open = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app" });
  const other = workspace([task("in-app", { projectId: "project-app" }), task("in-site", { projectId: "project-site" })], { currentId: "in-site" });

  const opened = diffMobileView(projectMobileView(none, NOW), projectMobileView(open, NOW));
  assert.equal(opened?.thread?.kind, "opened");

  const closed = diffMobileView(projectMobileView(open, NOW), projectMobileView(none, NOW));
  assert.equal(closed?.thread?.kind, "closed");
  assert.equal(applyMobilePatch(projectMobileView(open, NOW), closed!).thread, null);

  const moved = diffMobileView(projectMobileView(open, NOW), projectMobileView(other, NOW));
  assert.equal(moved?.thread?.kind, "opened", "another thread is one the phone has never seen");
  assert.ok(moved?.groups, "the list grew a group");
});

test("only what moved travels, and a patch puts it back", () => {
  const before = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app", prompts: { "in-app": "half" } });
  const after = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app", prompts: { "in-app": "half typed" } });

  const patch = diffMobileView(projectMobileView(before, NOW), projectMobileView(after, NOW));
  assert.ok(patch?.thread?.kind === "changed");
  assert.deepEqual(patch.thread.delta, { prompt: "half typed" });
  assert.deepEqual(applyMobilePatch(projectMobileView(before, NOW), patch), projectMobileView(after, NOW));
});

test("a patch for a thread the phone no longer holds leaves it alone", () => {
  const open = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app" });
  const patch = { thread: { kind: "changed" as const, id: "somebody-else", delta: { prompt: "stray" } } };
  assert.deepEqual(applyMobilePatch(projectMobileView(open, NOW), patch), projectMobileView(open, NOW));
  assert.deepEqual(applyMobilePatch(emptyMobileView(), patch), emptyMobileView());
});
