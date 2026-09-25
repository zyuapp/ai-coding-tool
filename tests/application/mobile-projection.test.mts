import assert from "node:assert/strict";
import { test } from "vitest";
import { applyMobilePatch, diffMobileView, emptyMobileView, MOBILE_TRANSCRIPT_MESSAGES, projectMobileView } from "../../src/application/mobile-projection.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ActiveRun, ApprovalView } from "../../src/application/thread-run-state.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";

const NOW = 1_800_000_000_000;

function message(text: string, at: number, kind: ConversationMessage["kind"] = "user"): ConversationMessage {
  return { id: `${text}-${at}`, kind, text, at };
}

function task(id: string, overrides: Partial<Thread> = {}): Thread {
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

function workspace(threads: Thread[], overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    ...emptyWorkspaceState(),
    threads,
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

test("a thread with no title yet is named by the view, so the list and the bar agree", () => {
  const state = workspace([task("blank", { title: "", projectId: "project-app" })], { currentId: "blank" });
  const view = projectMobileView(state, NOW);
  assert.equal(view.groups[0]?.threads[0]?.title, "Untitled thread");
  assert.equal(view.thread?.title, "Untitled thread");
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

test("a settled run's unread mark reaches the phone list", () => {
  const read = projectMobileView(workspace([task("settled", { projectId: "project-app", outcome: "finished" })]), NOW);
  const unread = projectMobileView(workspace([task("settled", { projectId: "project-app", outcome: "finished", outcomeUnread: true })]), NOW);

  assert.equal(read.groups[0]!.threads[0]!.unread, false);
  assert.equal(unread.groups[0]!.threads[0]!.unread, true);
  assert.deepEqual(applyMobilePatch(read, diffMobileView(read, unread)!), unread);
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
  assert.equal("prompt" in thread, false, "the draft stays on the desktop");
  assert.deepEqual(thread.settings, { fastMode: false, engine: "claude", model: "sonnet", effort: "high", policy: "allow-edits" });
});

test("a Mac with no thread open describes the one it is about to start", () => {
  const state = workspace([task("in-app", { projectId: "project-app" })], {
    draftProjectId: "project-app",
    draftModel: "sonnet",
    draftEffort: "low",
    draftPolicy: "autonomous",
  });

  const view = projectMobileView(state, NOW);
  assert.equal(view.thread, null);
  assert.deepEqual(view.draft, {
    projectId: "project-app",
    projectName: "App",
    settings: { fastMode: false, engine: "claude", model: "sonnet", effort: "low", policy: "autonomous" },
    worktree: false,
    worktreeName: null,
    worktrees: [],
    canWorktree: false,
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
  assert.equal(diffMobileView(projectMobileView(drafting, NOW), projectMobileView(typed, NOW)), null, "typing on the desktop never travels to the phone");
  const retargeted = workspace([task("in-app", { projectId: "project-app" })], { draftProjectId: "project-app", draftModel: "sonnet" });
  const moved = diffMobileView(projectMobileView(drafting, NOW), projectMobileView(retargeted, NOW));
  assert.deepEqual(moved, { draft: { projectId: "project-app", projectName: "App", settings: { fastMode: false, engine: "claude", model: "sonnet", effort: "high", policy: "confirm" }, worktree: false, worktreeName: null, worktrees: [], canWorktree: false } });
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
  const before = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app" });
  const after = workspace([task("in-app", { projectId: "project-app", model: "sonnet" })], { currentId: "in-app" });

  const patch = diffMobileView(projectMobileView(before, NOW), projectMobileView(after, NOW));
  assert.ok(patch?.thread?.kind === "changed");
  assert.deepEqual(patch.thread.delta, { settings: { fastMode: false, engine: "claude", model: "sonnet", effort: "high", policy: "confirm" } });
  assert.deepEqual(applyMobilePatch(projectMobileView(before, NOW), patch), projectMobileView(after, NOW));
});

test("a patch for a thread the phone no longer holds leaves it alone", () => {
  const open = workspace([task("in-app", { projectId: "project-app" })], { currentId: "in-app" });
  const patch = { thread: { kind: "changed" as const, id: "somebody-else", delta: { title: "stray" } } };
  assert.deepEqual(applyMobilePatch(projectMobileView(open, NOW), patch), projectMobileView(open, NOW));
  assert.deepEqual(applyMobilePatch(emptyMobileView(), patch), emptyMobileView());
});

test("running threads hold the sidebar's order however often they speak, and a blocked one leads", () => {
  const running = (updatedAt: number, lastAt: number) => ({
    activeRuns: { a: activeRun("a", "run-a", "running"), b: activeRun("b", "run-b", "running") },
    runStatuses: { a: "running" as const, b: "running" as const },
    threads: [
      task("a", { projectId: "project-app", sortIndex: 0, updatedAt: NOW - 5_000, messages: [message("first", NOW - 5_000)] }),
      task("b", { projectId: "project-app", sortIndex: 1, updatedAt, messages: [message("later", lastAt)] }),
    ],
  });
  const quiet = projectMobileView(workspace([], running(NOW - 10_000, NOW - 10_000)), NOW);
  assert.deepEqual(quiet.groups[0]!.threads.map((thread) => thread.id), ["a", "b"]);

  const spoke = projectMobileView(workspace([], running(NOW, NOW)), NOW);
  assert.deepEqual(spoke.groups[0]!.threads.map((thread) => thread.id), ["a", "b"], "b's newer activity does not move it above a");

  const blocked = projectMobileView(workspace([
    task("a", { projectId: "project-app", sortIndex: 0, updatedAt: NOW }),
    task("b", { projectId: "project-app", sortIndex: 1, updatedAt: NOW - 1_000 }),
    task("idle", { projectId: "project-app", updatedAt: NOW - 500 }),
  ], {
    activeRuns: { a: activeRun("a", "run-a", "running"), b: activeRun("b", "run-b", "awaiting-approval") },
    runStatuses: { a: "running", b: "running" },
  }), NOW);
  assert.deepEqual(blocked.groups[0]!.threads.map((thread) => thread.id), ["b", "a", "idle"], "waiting on the user, then the sidebar's order");
});

test("a thread that starts or finishes holds its row", () => {
  const threads = [
    task("a", { projectId: "project-app", sortIndex: 0, updatedAt: NOW - 3_000 }),
    task("b", { projectId: "project-app", sortIndex: 1, updatedAt: NOW - 2_000 }),
    task("c", { projectId: "project-app", sortIndex: 2, updatedAt: NOW - 1_000 }),
  ];
  const asleep = projectMobileView(workspace(threads), NOW);
  assert.deepEqual(asleep.groups[0]!.threads.map((thread) => thread.id), ["a", "b", "c"]);

  const awake = projectMobileView(workspace(
    threads.map((each) => each.id === "c" ? { ...each, updatedAt: NOW, messages: [message("go", NOW)] } : each),
    { activeRuns: { c: activeRun("c", "run-c", "running") }, runStatuses: { c: "running" } },
  ), NOW);
  assert.deepEqual(awake.groups[0]!.threads.map((thread) => thread.id), ["a", "b", "c"], "waking does not lift c");
  assert.equal(awake.groups[0]!.threads[2]!.status, "running");
});

test("the activity list ranks what wants the user, the desktop's way, over the threads the list carries", () => {
  const state = workspace([
    task("waiting", { projectId: "project-app", outcome: "finished", outcomeUnread: true, updatedAt: NOW - 5_000 }),
    task("found", { projectId: "project-site", findings: [{ id: "f1", headline: "Tests are red", at: NOW }], updatedAt: NOW - 9_000 }),
    task("working", { projectId: "project-app" }),
    task("asking", { updatedAt: NOW - 1_000 }),
    task("quiet", { projectId: "project-app", updatedAt: NOW - 20_000 }),
  ], {
    activeRuns: { working: activeRun("working", "run-1", "running"), asking: activeRun("asking", "run-2", "awaiting-approval") },
    runStatuses: { working: "running", asking: "running" },
  });
  const { activity } = projectMobileView(state, NOW);
  assert.deepEqual(activity.priority.map((thread) => thread.id).sort(), ["asking", "found", "waiting"], "blocked, verdicts and findings all rank");
  assert.deepEqual(activity.running.map((thread) => thread.id), ["working"]);
  assert.deepEqual(activity.threads.map((thread) => thread.id), ["quiet"]);
  const found = activity.priority.find((thread) => thread.id === "found")!;
  assert.equal(found.headline, "Tests are red");
  assert.equal(found.projectName, "site");
  assert.equal(found.attention, true);
  assert.equal(found.unread, true, "an unread finding marks the row as a verdict would");
  assert.equal(activity.priority.find((thread) => thread.id === "asking")!.attention, false, "a blocked thread has nothing to file away yet");
  assert.equal(activity.priority.find((thread) => thread.id === "waiting")!.outcome, "finished");
});

test("the phone wears the desktop's theme family in both faces, and follows the desktop's mode", () => {
  const nord = projectMobileView(workspace([], { theme: "nord-snow", themeMode: "light" }), NOW).theme;
  assert.deepEqual(nord, { dark: "nord", light: "nord-snow", mode: "light" });
  const auto = projectMobileView(workspace([], { theme: "dracula", themeMode: "auto" }), NOW).theme;
  assert.deepEqual(auto, { dark: "dracula", light: "alucard", mode: "auto" });
  const before = projectMobileView(workspace([], { theme: "nord", themeMode: "dark" }), NOW);
  const after = projectMobileView(workspace([], { theme: "nord-snow", themeMode: "light" }), NOW);
  assert.deepEqual(diffMobileView(before, after), { theme: { dark: "nord", light: "nord-snow", mode: "light" } });
  assert.deepEqual(applyMobilePatch(before, diffMobileView(before, after)!), after);
});

test("the open thread says where it works, where it could move, and what its checkout holds", () => {
  const worktrees = [
    { id: "wt-1", projectId: "project-app", root: "/code/app-wt-1", workspaceId: "ws-wt-1", baseCommit: "abc", createdAt: NOW - 10, lastUsedAt: NOW - 10, name: "Feature" },
    { id: "wt-2", projectId: "project-app", root: "/code/app-wt-2", workspaceId: "ws-wt-2", baseCommit: "abc", createdAt: NOW - 5, lastUsedAt: NOW - 5 },
    { id: "wt-other", projectId: "project-site", root: "/code/site-wt", workspaceId: "ws-site", baseCommit: "abc", createdAt: NOW, lastUsedAt: NOW },
  ];
  const state = workspace([task("in-app", { projectId: "project-app", worktreeId: "wt-1" }), task("sibling", { projectId: "project-app", worktreeId: "wt-1" })], {
    currentId: "in-app",
    projects: [{ id: "project-app", root: "/code/app", name: "App", workspaceId: "ws-app" }, { id: "project-site", root: "/code/site" }],
    worktrees,
    environments: {
      "ws-wt-1": { status: "available", files: ["a.ts", "b.ts"], branch: "feature", baseline: "main", additions: 12, deletions: 3 },
      "ws-wt-2": { status: "available", files: [], branch: "spike", baseline: null, additions: 0, deletions: 0 },
    },
  });
  const thread = projectMobileView(state, NOW).thread!;
  assert.deepEqual(thread.location, { kind: "worktree", name: "Feature", threads: 2 });
  assert.equal(thread.worktreeId, "wt-1");
  assert.equal(thread.projectId, "project-app");
  assert.deepEqual(thread.worktrees, [{ id: "wt-2", name: "app-wt-2", branch: "spike" }], "only the project's other checkouts, newest first");
  assert.equal(thread.canMove, true);
  assert.equal(thread.reviewable, true);
  assert.deepEqual(thread.changes, { branch: "feature", files: 2, additions: 12, deletions: 3 });
  assert.deepEqual(thread.branchRange, { kind: "branches", base: "HEAD", compare: null });

  const busy = { ...state, activeRuns: { "in-app": activeRun("in-app", "run-1", "running") }, runStatuses: { "in-app": "running" as const } };
  assert.equal(projectMobileView(busy, NOW).thread!.canMove, false, "a running thread cannot be moved");

  const loose = projectMobileView(workspace([task("loose")], { currentId: "loose" }), NOW).thread!;
  assert.deepEqual(loose.location, { kind: "local" });
  assert.equal(loose.reviewable, false, "a thread in no project has no checkout to review");
  assert.equal(loose.canMove, false);
});

test("a draft says how it will start: in a checkout of its own, or in one the project already has", () => {
  const base = workspace([], {
    draftProjectId: "project-app",
    projects: [{ id: "project-app", root: "/code/app", name: "App", workspaceId: "ws-app" }],
    worktrees: [{ id: "wt-1", projectId: "project-app", root: "/code/app-wt-1", workspaceId: "ws-wt-1", baseCommit: "abc", createdAt: NOW, lastUsedAt: NOW, name: "Feature" }],
  });
  const fresh = projectMobileView({ ...base, draftWorktree: true }, NOW).draft!;
  assert.equal(fresh.projectId, "project-app");
  assert.equal(fresh.worktree, true);
  assert.equal(fresh.worktreeName, null);
  assert.equal(fresh.canWorktree, true);
  assert.deepEqual(fresh.worktrees, [{ id: "wt-1", name: "Feature", branch: null }]);

  const existing = projectMobileView({ ...base, draftWorktreeId: "wt-1" }, NOW).draft!;
  assert.equal(existing.worktreeName, "Feature");
  assert.deepEqual(existing.worktrees, [], "the checkout it starts in is not also offered");
  assert.deepEqual(diffMobileView(projectMobileView(base, NOW), projectMobileView({ ...base, draftWorktree: true }, NOW))?.draft?.worktree, true);
});
