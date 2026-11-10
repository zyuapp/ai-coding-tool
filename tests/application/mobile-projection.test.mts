import assert from "node:assert/strict";
import { rankedThread } from "../../src/domain/thread-storage.ts";
import { test } from "vitest";
import { applyMobilePatch, diffMobileView, emptyMobileView, mobileArchivedThreads, mobileEngineView, mobileThreadHistory, MOBILE_BACKGROUND_DETAIL_LIMIT, MOBILE_HISTORY_PAGE, MOBILE_MESSAGE_TEXT_LIMIT, MOBILE_SUGGESTION_PROMPT_LIMIT, MOBILE_TRANSCRIPT_MESSAGES,
  projectMobileView } from "../../src/application/mobile-projection.ts";
import { BUILT_IN_MODELS, efforts, effortsFor, modelLabel, modelsFor, type EngineStatus } from "../../src/domain/agent-engine.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { deriveView } from "../../src/application/workspace-view.ts";
import { workspaceViewCollections } from "../../src/application/workspace-view-collections.ts";
import type { ActiveRun, ApprovalView } from "../../src/application/thread-run-state.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";

const NOW = 1_800_000_000_000;

function message(text: string, at: number, kind: ConversationMessage["kind"] = "user"): ConversationMessage {
  return { id: `${text}-${at}`, kind, text, at };
}

function task(id: string, overrides: Partial<Thread> = {}): Thread {
  return rankedThread({
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
  });
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
  } as ActiveRun;
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
  assert.equal(applyMobilePatch(failed, { error: null })?.error, null);
  assert.equal(applyMobilePatch(failed, { groups: [] })?.error, "That worktree is busy.", "a patch that says nothing about it leaves it alone");
});

test("the computer's own app and engines travel with a step the phone may send back, and only when they move", () => {
  const status: EngineStatus = { claude: { access: "ready", version: "2.1.0", latest: "2.2.0", fix: "claude update" }, codex: { access: "ready", version: "0.162.1" } } as EngineStatus;
  const idle = workspace([], { appBuild: { version: "0.7.10", selfUpdating: true }, engineStatus: status });
  const offered = projectMobileView({ ...idle, appUpdate: { status: "available", version: "0.7.11" } }, NOW);
  assert.deepEqual(offered.upkeep.map((item) => [item.key, item.version, item.state.text, item.action?.command]), [
    ["app", "0.7.10", "0.7.11 available", { type: "app.update" }],
    ["claude", "2.1.0", "2.2.0 available", { type: "engine.update", engine: "claude" }],
    ["codex", "0.162.1", "Up to date", undefined],
  ], "commands name no computer, so the one the phone is on carries them out");

  const waiting = projectMobileView({ ...idle, appUpdate: { status: "ready", version: "0.7.11" }, appUpdateRequest: { status: "waiting" }, threads: [task("a")], activeRuns: { a: activeRun("a", "r", "running") } }, NOW);
  assert.deepEqual([waiting.upkeep[0]!.state.text, waiting.upkeep[0]!.action?.command], ["Waiting for 1 thread", { type: "app.cancel-update" }]);

  assert.equal(waiting.upkeep.some((item) => item.installing), false);
  const installing = projectMobileView({ ...idle, appUpdate: { status: "ready", version: "0.7.11" }, appUpdateRequest: { status: "installing", version: "0.7.11" } }, NOW);
  assert.deepEqual(installing.upkeep.filter((item) => item.installing).map((item) => item.key), ["app"], "the phone reads a restart from this, not the row's words");

  assert.deepEqual(diffMobileView(offered, waiting)?.upkeep, waiting.upkeep);
  assert.equal(diffMobileView(offered, projectMobileView({ ...idle, appUpdate: { status: "available", version: "0.7.11" } }, NOW)), null);
  assert.deepEqual(applyMobilePatch(offered, { upkeep: waiting.upkeep })?.upkeep, waiting.upkeep);
  assert.deepEqual(applyMobilePatch(offered, { groups: [] })?.upkeep, offered.upkeep, "a patch that says nothing about it leaves it alone");
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
    queuedMessages: { "in-app": [{ id: "queued-1", text: "then this", prompt: "then this", attachments: [] }, { id: "queued-2", text: "stop the stack", prompt: "stop the stack", attachments: [], detail: "From Monday · lead" }] },
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
  assert.deepEqual(thread.queued, [{ id: "queued-1", text: "then this", editable: true }, { id: "queued-2", text: "stop the stack", origin: "From Monday · lead" }]);
  assert.equal("prompt" in thread, false, "the draft stays on the desktop");
  assert.deepEqual(thread.settings, { fastMode: false, engine: "claude", model: "sonnet", effort: "high", policy: "allow-edits" });
});

test("a coordinator's settings say so, so the phone offers it only the efforts a coordinator takes", () => {
  const state = workspace([task("lead", { role: "coordinator", engine: "codex", model: "gpt-6.1-sol", effort: "ultra" })], { currentId: "lead" });
  assert.deepEqual(projectMobileView(state, NOW).thread?.settings, { fastMode: false, engine: "codex", model: "gpt-6.1-sol", effort: "max", policy: "confirm", coordinating: true });
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
  messages.push(message("x".repeat(10_000), NOW - 1));
  messages.push(message("y".repeat(MOBILE_MESSAGE_TEXT_LIMIT + 10), NOW));
  const state = workspace([task("in-app", { projectId: "project-app", messages })], { currentId: "in-app" });

  const thread = projectMobileView(state, NOW).thread;
  assert.ok(thread);
  assert.equal(thread.messages.length, MOBILE_TRANSCRIPT_MESSAGES);
  assert.equal(thread.omitted, 7);
  assert.equal(thread.messages.at(-2)!.text.length, 10_000, "a long reply travels whole");
  assert.equal(thread.messages.at(-1)!.text.length, MOBILE_MESSAGE_TEXT_LIMIT + 1, "a message past the limit is cut short");
  assert.match(thread.messages.at(-1)!.text, /…$/);
});

test("older pages reach back from the live window to the first message, each tool call read beside its own message", () => {
  const messages = Array.from({ length: MOBILE_TRANSCRIPT_MESSAGES + MOBILE_HISTORY_PAGE + 3 }, (_, index) => message(`m${index}`, NOW + index));
  messages[1] = { id: "c1", kind: "tool", text: "Bash", detail: JSON.stringify({ command: "npm test" }), at: NOW + 1 };
  const state = workspace([task("t1", { messages })], { currentId: "t1" });
  const live = projectMobileView(state, NOW).thread!;

  const first = mobileThreadHistory(state, "t1", live.omitted)!;
  assert.equal(first.start, 3);
  assert.equal(first.messages.length, MOBILE_HISTORY_PAGE);
  assert.equal(first.messages.at(-1)!.text, messages[live.omitted - 1]!.text, "a page ends where the live window starts");
  const last = mobileThreadHistory(state, "t1", first.start)!;
  assert.equal(last.start, 0);
  assert.deepEqual(last.messages.map((entry) => entry.text), ["m0", "Bash", "m2"]);
  assert.equal(last.messages[1]!.call?.argument, "npm test");
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
  assert.equal(patch.groups, undefined, "a row that only moved in time, by less than the list draws, is not sent again");
  assert.equal(patch.thread?.kind, "changed");
  assert.ok(patch.thread?.kind === "changed");
  assert.deepEqual(patch.thread.delta.spliced?.messages.map((entry) => entry.text), ["on it"]);
  assert.equal(patch.thread.delta.messages, undefined);
  assert.deepEqual(applyMobilePatch(projectMobileView(before, NOW), patch)?.thread, projectMobileView(after, NOW).thread);
});

test("a transcript that did not simply grow is replaced whole", () => {
  const before = workspace([task("in-app", { projectId: "project-app", messages: [message("do it", NOW - 1_000)] })], { currentId: "in-app" });
  const after = workspace([task("in-app", { projectId: "project-app", messages: [message("do that instead", NOW - 1_000)] })], { currentId: "in-app" });

  const patch = diffMobileView(projectMobileView(before, NOW), projectMobileView(after, NOW));
  assert.ok(patch?.thread?.kind === "changed");
  assert.equal(patch.thread.delta.spliced, undefined);
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
  assert.equal(applyMobilePatch(projectMobileView(open, NOW), closed!)?.thread, null);

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

test("a coordinator stands for its threads in the phone's activity lists, as it does on the desktop", () => {
  const lead = task("lead", { role: "coordinator", projectId: "project-app" });
  for (const [what, member] of [
    ["a thread under it waiting on a decision", task("member", { parentId: "lead", projectId: "project-app", decisions: [{ id: "d1", question: "Which?", options: [], raisedAt: NOW }] })],
    ["a resolved thread under it that finished", task("member", { parentId: "lead", projectId: "project-app", outcome: "finished", outcomeUnread: true, resolvedAt: NOW })],
  ] as const) {
    const state = workspace([lead, member]);
    const desktop = workspaceViewCollections(state).lists.activityThreads;
    const { activity } = projectMobileView(state, NOW);
    for (const list of ["priority", "running", "threads", "snoozed"] as const) {
      assert.deepEqual(activity[list].map((thread) => thread.id), desktop[list].map((thread) => thread.id), `${what}: ${list}`);
    }
  }
});

test("a coordinator's phone row speaks for the threads under it, and opening it answers their approvals", () => {
  const approval: ApprovalView = { approvalId: "a1", taskId: "member", runId: "run-1", title: "Run a command", description: "rm", toolName: "Bash", input: { command: "rm" } };
  const decision = { id: "d1", question: "Which?", options: [], raisedAt: NOW };
  const state = workspace([
    task("lead", { role: "coordinator", projectId: "project-app", proposals: [{ id: "p1", title: "GPU tests", prompt: "Run them", place: { computer: { id: "studio", name: "Studio" }, worktree: false }, proposedAt: NOW }] }),
    task("member", { parentId: "lead", projectId: "project-app", title: "Dark mode", decisions: [decision] }),
  ], { activeRuns: { member: activeRun("member", "run-1", "awaiting-approval") }, runStatuses: { member: "running" }, approvals: { "run-1": approval } });
  const { activity } = projectMobileView(state, NOW);
  const lead = activity.priority.find((entry) => entry.id === "lead");
  assert.deepEqual([lead?.status, lead?.headline], ["awaiting-approval", "A decision and a request to run a thread on Studio are waiting on you"], "it waits on the user as its threads do, and says what for");
  assert.equal([...activity.priority, ...activity.running, ...activity.threads].some((entry) => entry.id === "member"), false, "the thread under it is reached through it, as on the desktop");
  const opened = projectMobileView({ ...state, currentId: "lead" }, NOW).thread;
  assert.deepEqual(opened?.approval && [opened.approval.taskId, opened.approval.from, opened.approval.approvalId], ["member", "Dark mode", "a1"], "and opening it answers that thread's approval");
  const started = projectMobileView({ ...state, startingProposals: ["p1"], activeRuns: {}, runStatuses: {}, approvals: {} }, NOW).activity;
  assert.equal(started.priority.find((entry) => entry.id === "lead")?.headline, "A decision is waiting on you", "a request already starting waits on no one");
});

test("a coordinator's phone row works while its threads do, says what waits first, and is dismissed only with something to file away", () => {
  const decision = { id: "d1", question: "Which?", options: [], raisedAt: NOW };
  const finding = { id: "f1", headline: "Found a bug", at: NOW };
  const row = (threads: Thread[], overrides: Partial<WorkspaceState> = {}) => {
    const { activity } = projectMobileView(workspace(threads, overrides), NOW);
    const entry = [...activity.priority, ...activity.running, ...activity.threads].find((item) => item.id === "lead");
    return { status: entry?.status, waiting: entry?.waiting ?? false, headline: entry?.headline ?? null, attention: entry?.attention };
  };
  const lead = (overrides: Partial<Thread> = {}) => task("lead", { role: "coordinator", projectId: "project-app", ...overrides });
  const member = (overrides: Partial<Thread> = {}) => task("member", { parentId: "lead", projectId: "project-app", ...overrides });
  assert.deepEqual(row([lead(), member()], { activeRuns: { member: activeRun("member", "run-1", "running") }, runStatuses: { member: "running" } }),
    { status: "running", waiting: false, headline: null, attention: false }, "a thread under it at work is its work, as the desktop's spinner says");
  assert.deepEqual(row([lead({ findings: [finding] }), member({ decisions: [decision] })]),
    { status: "idle", waiting: true, headline: "A decision is waiting on you", attention: true }, "what waits leads its line, as on the desktop, and the finding is still there to file away");
  assert.deepEqual(row([lead(), member({ decisions: [decision] })]).attention, false, "what waits on the user is answered, not dismissed");
  assert.deepEqual(row([lead(), member({ outcome: "finished" })]).attention, true, "a thread under it with a verdict is dismissed with it");
});

test("a coordinator's phone row speaks for its threads on paired computers too, as the desktop's does", () => {
  const approval: ApprovalView = { approvalId: "a1", taskId: "far", runId: "run-far", title: "Run a command", description: "rm", toolName: "Bash", input: { command: "rm" } };
  const holder = { ...emptyWorkspaceState(), threads: [task("far", { title: "Far work", remoteLead: { threadId: "lead", title: "Lead", computer: "This Mac" } })], activeRuns: { far: activeRun("far", "run-far", "awaiting-approval") }, approvals: { "run-far": approval } };
  const state = workspace([task("lead", { role: "coordinator", projectId: "project-app" })], {
    computers: { ...emptyWorkspaceState().computers, paired: [{ id: "studio", name: "Studio", host: "studio.ts.net", status: "connected", error: null, pairedAt: 1, state: holder }] },
  });
  const desktop = workspaceViewCollections(state).lists.activityThreads.priority.map((thread) => thread.id);
  const { activity } = projectMobileView(state, NOW);
  assert.deepEqual(activity.priority.map((entry) => [entry.id, entry.status]), [["lead", "awaiting-approval"]]);
  assert.deepEqual(activity.priority.map((entry) => entry.id), desktop);
  const filtered = projectMobileView({ ...state, computers: { ...state.computers, filter: "this" } }, NOW).activity;
  assert.deepEqual(filtered.priority.map((entry) => [entry.id, entry.status]), [["lead", "awaiting-approval"]], "whichever computers the desktop's sidebar shows");
});

test("a message says how many images it carried", () => {
  const sent: ConversationMessage = { id: "m1", kind: "user", text: "Look", attachments: ["/a.jpg", "/b.jpg"], at: NOW };
  const state = workspace([task("t1", { messages: [sent, message("plain", NOW + 1)] })], { currentId: "t1" });
  assert.deepEqual(projectMobileView(state, NOW).thread?.messages.map((entry) => entry.images), [2, undefined]);
});

test("an open coordinator lists the threads under it, here and on paired computers, and a plain thread lists none", () => {
  const holder = { ...emptyWorkspaceState(), threads: [task("far", { title: "Far work", remoteLead: { threadId: "lead", title: "Lead", computer: "This Mac" } })], activeRuns: { far: activeRun("far", "run-far", "running") } };
  const state = workspace([task("lead", { role: "coordinator", projectId: "project-app" }), task("near", { title: "Near work", parentId: "lead", projectId: "project-app" })], {
    currentId: "lead",
    computers: { ...emptyWorkspaceState().computers, paired: [{ id: "studio", name: "Studio", host: "studio.ts.net", status: "connected", error: null, pairedAt: 1, state: holder }] },
  });
  assert.deepEqual(projectMobileView(state, NOW).thread?.members, [
    { id: "near", title: "Near work", status: "idle" },
    { id: "far", title: "Far work", status: "running", computer: "Studio", online: true },
  ]);
  assert.deepEqual(projectMobileView({ ...state, currentId: "near" }, NOW).thread?.members, []);
});

test("a tool call travels with what it did, read from its input once", () => {
  const call: ConversationMessage = { id: "c1", kind: "tool", text: "Bash", detail: JSON.stringify({ command: "npm test" }), at: NOW };
  const page: ConversationMessage = { id: "c2", kind: "tool", text: "mcp__aicodingtool-browser__browser_open", detail: JSON.stringify({ url: "https://example.com" }), at: NOW };
  const state = workspace([task("t1", { messages: [message("go", NOW - 1), call, page] })], { currentId: "t1" });
  const messages = projectMobileView(state, NOW).thread?.messages ?? [];
  assert.deepEqual(messages.map((entry) => entry.call), [
    undefined,
    { family: "shell", label: "Bash", argument: "npm test", sigil: "$" },
    { family: "web", label: "Open page", argument: "https://example.com", verb: true },
  ]);
  assert.equal(projectMobileView(state, NOW + 1).thread?.messages[1]?.call, messages[1]?.call, "the same stored call is described once");
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

test("the phone is told the models the computer's engines name, leanly, and only again when they move", () => {
  const status: EngineStatus = {
    claude: { access: "ready", version: "2.1.0", fix: "claude update", models: ["opus", "sonnet"] },
    opencode: { access: "ready", version: "2.3.0", catalog: [{ id: "openrouter/qwen-4", label: "Qwen 4", description: "qwen-4", provider: "OpenRouter", contextWindow: 128_000, efforts: efforts("high", "low"), manualCompaction: true }] },
  };
  const before = projectMobileView(workspace([]), NOW);
  const read = projectMobileView(workspace([], { engineStatus: status }), NOW);
  assert.deepEqual(read.engines, {
    claude: { access: "ready", models: ["opus", "sonnet"] },
    opencode: { access: "ready", catalog: [{ id: "openrouter/qwen-4", label: "Qwen 4", description: "qwen-4", provider: "OpenRouter", efforts: ["high", "low"] }] },
  }, "only what a picker reads travels");
  assert.equal(projectMobileView(workspace([], { engineStatus: status, theme: "nord" }), NOW).engines, read.engines, "a view that did not read the engines again carries the same ones");
  assert.deepEqual(diffMobileView(before, read), { engines: read.engines, upkeep: read.upkeep });
  assert.equal(diffMobileView(read, projectMobileView(workspace([], { engineStatus: { ...status } }), NOW)), null, "engines read again the same send nothing");
  const applied = applyMobilePatch(before, diffMobileView(before, read)!)!;
  assert.deepEqual(applied, read);

  const phone = mobileEngineView(JSON.parse(JSON.stringify(applied.engines)));
  assert.deepEqual(modelsFor(phone.catalog, "opencode").map((spec) => spec.id), ["openrouter/qwen-4"]);
  assert.equal(modelLabel(phone.catalog, "opencode", "openrouter/qwen-4"), "Qwen 4");
  assert.deepEqual(effortsFor(phone.catalog, "opencode", "openrouter/qwen-4").map((spec) => spec.label), ["High", "Low"]);
  assert.deepEqual(modelsFor(phone.catalog, "codex"), modelsFor(BUILT_IN_MODELS, "codex"), "an engine naming none keeps the models this build ships");
  assert.deepEqual(phone.access.claude, { access: "ready", models: ["opus", "sonnet"] });
  assert.deepEqual(phone.access.codex, { access: "ready" });
  assert.equal(mobileEngineView(undefined).catalog, BUILT_IN_MODELS, "an older computer names no engines");
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

test("the desktop's draft offers the project's checkouts, most recently used first, and an open thread offers none", () => {
  const worktree = (id: string, lastUsedAt: number, projectId = "project-app") => ({ id, projectId, root: `/code/app-${id}`, workspaceId: `ws-${id}`, baseCommit: "abc", createdAt: lastUsedAt, lastUsedAt });
  const base = workspace([task("open", { projectId: "project-app" })], {
    draftProjectId: "project-app",
    projects: [{ id: "project-app", root: "/code/app", name: "App", workspaceId: "ws-app" }, { id: "project-site", root: "/code/site" }],
    worktrees: [worktree("older", NOW - 10), worktree("newer", NOW - 5), worktree("elsewhere", NOW, "project-site")],
    environments: { "ws-newer": { status: "available", files: [], branch: "spike", baseline: null, additions: 0, deletions: 0 } },
  });
  assert.deepEqual(deriveView(base).draftWorktreeChoices, [
    { id: "newer", name: "app-newer", branch: "spike" },
    { id: "older", name: "app-older", branch: null },
  ]);
  assert.deepEqual(deriveView({ ...base, draftWorktreeId: "newer" }).draftWorktreeChoices.map((choice) => choice.id), ["older"], "the checkout it starts in is not also offered");
  assert.deepEqual(deriveView({ ...base, draftProjectId: null }).draftWorktreeChoices, [], "a chat has no checkouts");
  assert.deepEqual(deriveView({ ...base, currentId: "open" }).draftWorktreeChoices, [], "an open thread is no draft");
});

test("an open thread lists its workflows, processes and subagents, live ones first, and only live ones stop", () => {
  const subagents = [
    { id: "a-done", description: "Read the docs", status: "completed" as const, summary: "Found it\nmore", startedAt: NOW, activity: [] },
    { id: "a-work", description: "Fix the tests", status: "working" as const, lastToolName: "Bash", startedAt: NOW, activity: [] },
    { id: "a-idle", description: "Wait for CI", status: "idle" as const, startedAt: NOW, activity: [] },
  ];
  const workflow = { id: "wf", name: "review", description: "", status: "running" as const, phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: NOW };
  const state = workspace([task("t1")], {
    currentId: "t1",
    subagents: { t1: subagents },
    workflows: { t1: [workflow] },
    backgroundProcesses: { t1: [{ id: "p1", kind: "shell", description: "npm run dev", stopping: true }] },
  });
  assert.deepEqual(projectMobileView(state, NOW).thread?.background, [
    { id: "wf", kind: "workflow", title: "review", detail: "Running · 0/0 agents", status: "working", live: true, stoppable: true },
    { id: "p1", kind: "shell", title: "npm run dev", detail: "Stopping", status: "working", live: true, stoppable: true, stopping: true },
    { id: "a-work", kind: "agent", title: "Fix the tests", detail: "Using Bash", status: "working", live: true, stoppable: true },
    { id: "a-idle", kind: "agent", title: "Wait for CI", detail: "Idle", status: "idle", live: true, stoppable: false },
    { id: "a-done", kind: "agent", title: "Read the docs", detail: "Found it", status: "completed", live: false, stoppable: false },
  ]);
  assert.deepEqual(projectMobileView({ ...state, currentId: null }, NOW).thread, null);
  const before = projectMobileView(state, NOW);
  const after = projectMobileView({ ...state, subagents: { t1: subagents.filter((subagent) => subagent.id !== "a-work") } }, NOW);
  const patch = diffMobileView(before, after);
  assert.equal(patch?.thread?.kind, "changed");
  assert.deepEqual(applyMobilePatch(before, patch!)?.thread?.background?.map((item) => item.id), ["wf", "p1", "a-idle", "a-done"]);
});

test("an open thread says its role, and a cleared role travels as null", () => {
  const state = workspace([task("t1", { role: "reviewer" })], { currentId: "t1" });
  const before = projectMobileView(state, NOW);
  assert.equal(before.thread?.role, "reviewer");
  const after = projectMobileView({ ...state, threads: [task("t1")] }, NOW);
  const patch = diffMobileView(before, after);
  assert.equal(patch?.thread?.kind === "changed" && patch.thread.delta.role, null);
  assert.equal(applyMobilePatch(before, patch!)?.thread?.role, null);
});

test("background items are kept while their lists are, and a long line is cut", () => {
  const subagents = [{ id: "a1", description: "Long", status: "completed" as const, summary: "x".repeat(5_000), startedAt: NOW, activity: [] }];
  const state = workspace([task("t1")], { currentId: "t1", subagents: { t1: subagents } });
  const first = projectMobileView(state, NOW).thread?.background;
  assert.equal(projectMobileView({ ...state, streamingTails: {} }, NOW).thread?.background, first, "a thread with no shells or workflows reuses its items");
  assert.equal(first?.[0]?.detail.length, MOBILE_BACKGROUND_DETAIL_LIMIT + 1);
});

const claudePlan = {
  status: "available" as const,
  subscription: "max",
  windows: [
    { id: "five_hour", label: "Current session", utilization: 42.4, resetsAt: "2027-01-15T16:10:00Z", period: "session" as const, minutes: 300 },
    { id: "seven_day", label: "Current week (all models)", utilization: 61, resetsAt: "2027-01-20T09:00:00Z", period: "week" as const, minutes: 10_080 },
    { id: "seven_day_opus", label: "Current week (Opus)", utilization: 90, resetsAt: "2027-01-20T09:00:00Z", model: "Opus", period: "week" as const, minutes: 10_080 },
  ],
};

test("the composer's usage counts only the windows its model spends, as the desktop meter does", () => {
  const state = workspace([task("t", { model: "sonnet" })], {
    currentId: "t",
    planUsage: { read: 1, reading: [], dismissed: [], reports: { claude: claudePlan, codex: { status: "not-applicable" } } },
  });
  const { usage } = projectMobileView(state, NOW);
  assert.deepEqual(usage.engines.map((engine) => [engine.engine, engine.plan, engine.windows.map((window) => window.share)]), [["claude", "Max plan", [42, 61, 90]]]);
  assert.deepEqual(usage.composer, { share: 61, meter: [{ span: "5h", share: 42 }, { span: "Weekly", share: 61 }], spends: ["five_hour", "seven_day"], warning: null });
});

test("a window running low warns until it is dismissed or the thread waits out a limit", () => {
  const planUsage = { read: 1, reading: [], dismissed: [] as string[], reports: { claude: claudePlan } };
  const state = workspace([task("t", { model: "opus" })], { currentId: "t", planUsage });
  const warning = projectMobileView(state, NOW).usage.composer?.warning;
  assert.deepEqual(warning, { key: "claude:seven_day_opus:2027-01-20T09:00:00Z:near", share: 90, window: "Claude · Current week (Opus)", resetsAt: "2027-01-20T09:00:00Z" });

  assert.equal(projectMobileView({ ...state, planUsage: { ...planUsage, dismissed: [warning!.key] } }, NOW).usage.composer?.warning, null);
  const paused = workspace([task("t", { model: "opus", limitPause: { pausedAt: NOW } as Thread["limitPause"] })], { currentId: "t", planUsage });
  assert.equal(projectMobileView(paused, NOW).usage.composer?.warning, null);
});

test("an engine that could not be read says why, and nothing read means no usage", () => {
  assert.deepEqual(projectMobileView(workspace([]), NOW).usage, { engines: [], composer: null });
  const state = workspace([], { planUsage: { read: 1, reading: [], dismissed: [], reports: { codex: { status: "unavailable", message: "Sign in again" } } } });
  assert.deepEqual(projectMobileView(state, NOW).usage, { engines: [{ engine: "codex", label: "Codex", plan: null, windows: [], message: "Sign in again" }], composer: null });
});

test("usage travels only when it moves, and a patch puts it back", () => {
  const before = workspace([task("t", { model: "sonnet" })], { currentId: "t" });
  const after = { ...before, planUsage: { read: 1, reading: [], dismissed: [], reports: { claude: claudePlan } } };
  const previous = projectMobileView(before, NOW);
  const next = projectMobileView(after, NOW);
  const patch = diffMobileView(previous, next);
  assert.deepEqual(Object.keys(patch ?? {}), ["usage"]);
  assert.deepEqual(applyMobilePatch(previous, patch!), next);
  assert.equal(diffMobileView(next, projectMobileView(after, NOW)), null);
});

test("an open coordinator carries the decisions its threads raised, naming each thread but its own", () => {
  const own = { id: "d0", question: "Ship it?", options: [], raisedAt: NOW - 2 };
  const theirs = { id: "d1", question: "Which store?", context: "Both work.", options: [{ label: "SQLite", description: "Local", recommended: true as const }, { label: "Postgres" }], raisedAt: NOW - 1 };
  const answered = { id: "d2", question: "Old?", options: [], raisedAt: NOW - 3, answer: "Yes", answeredAt: NOW };
  const state = workspace([
    task("lead", { role: "coordinator", projectId: "project-app", decisions: [own] }),
    task("member", { parentId: "lead", projectId: "project-app", title: "Storage", decisions: [theirs, answered] }),
  ], { currentId: "lead" });
  assert.deepEqual(projectMobileView(state, NOW).thread?.decisions, [
    { taskId: "lead", id: "d0", question: "Ship it?", options: [] },
    { taskId: "member", from: "Storage", id: "d1", question: "Which store?", context: "Both work.", options: [{ label: "SQLite", description: "Local", recommended: true }, { label: "Postgres" }] },
  ]);
  assert.deepEqual(projectMobileView({ ...state, currentId: "member" }, NOW).thread?.decisions, [], "a thread under a coordinator is answered through it");
});

test("an open coordinator carries the suggestions to start here, their prompts cut to length, and none asked for elsewhere", () => {
  const long = "x".repeat(MOBILE_SUGGESTION_PROMPT_LIMIT + 50);
  const lead = task("lead", { role: "coordinator", projectId: "project-app", proposals: [
    { id: "p1", title: "Tests", prompt: long, brief: { intent: "Cover it", doneWhen: "Green", delivers: "commit" }, place: {}, proposedAt: NOW },
    { id: "p2", title: "Docs", prompt: "Write docs", place: {}, proposedAt: NOW, error: "No folder." },
    { id: "p3", title: "GPU", prompt: "Run them", place: { computer: { id: "studio", name: "Studio" } }, proposedAt: NOW },
  ] });
  const state = workspace([lead], { currentId: "lead" });
  const suggestions = projectMobileView(state, NOW).thread?.suggestions;
  assert.deepEqual(suggestions?.map((item) => [item.id, item.brief?.delivers ?? null, item.error ?? null]), [["p1", "Commits", null], ["p2", null, "No folder."]]);
  assert.ok(suggestions![0]!.prompt.length <= MOBILE_SUGGESTION_PROMPT_LIMIT + 1);
  const starting = projectMobileView({ ...state, startingProposals: ["p2"] }, NOW).thread?.suggestions?.[1];
  assert.deepEqual([starting?.starting, starting?.error], [true, undefined], "one starting says so, and its last failure is past");
});

test("a thread waiting out a usage limit says when it goes and where it stands in line", () => {
  const pause = (pausedAt: number, window: "session" | "weekly" = "session") => ({ resetsAt: NOW + 3_600_000, window, pausedAt });
  const state = workspace([task("first", { limitPause: pause(NOW - 2) }), task("second", { limitPause: pause(NOW - 1) }), task("weekly", { limitPause: pause(NOW, "weekly") }), task("plain")], { currentId: "second" });
  assert.deepEqual(projectMobileView(state, NOW).thread?.limit, { resetsAt: NOW + 3_600_000, window: "session", position: 2 });
  assert.deepEqual(projectMobileView({ ...state, currentId: "weekly" }, NOW).thread?.limit, { resetsAt: NOW + 3_600_000, window: "weekly", position: null });
  assert.equal(projectMobileView({ ...state, currentId: "plain" }, NOW).thread?.limit, null);
});

test("a Priority row may be snoozed, and a snoozed one says when it comes back", () => {
  const finding = { id: "f1", headline: "Found a bug", at: NOW };
  const state = workspace([task("waiting", { findings: [finding] }), task("later", { findings: [finding], snoozedUntil: NOW + 3_600_000 }), task("quiet")]);
  const { activity } = projectMobileView(state, NOW);
  assert.deepEqual(activity.priority.map((entry) => [entry.id, entry.snoozable]), [["waiting", true]]);
  assert.deepEqual(activity.snoozed.map((entry) => [entry.id, entry.snoozedUntil, entry.snoozable]), [["later", NOW + 3_600_000, undefined]]);
  assert.equal(activity.threads.find((entry) => entry.id === "quiet")?.snoozable, undefined);
});

test("the view counts the archive, and a query lists it newest first with when each goes for good", () => {
  const state = workspace([task("old", { archivedAt: NOW - 2, projectId: "project-app" }), task("new", { archivedAt: NOW - 1, title: "" }), task("live")]);
  const view = projectMobileView(state, NOW);
  assert.equal(view.archived, 2);
  assert.deepEqual(mobileArchivedThreads(state), [
    { id: "new", title: "Untitled thread", projectName: null, archivedAt: NOW - 1, deletesAt: NOW - 1 + 5 * 86_400_000 },
    { id: "old", title: "old", projectName: "App", archivedAt: NOW - 2, deletesAt: NOW - 2 + 5 * 86_400_000 },
  ]);
  const many = workspace(Array.from({ length: 150 }, (_, index) => task(`a${index}`, { archivedAt: NOW - index })));
  assert.deepEqual([projectMobileView(many, NOW).archived, mobileArchivedThreads(many).length, mobileArchivedThreads(many).at(-1)?.id], [150, 150, "a149"], "the oldest is as reachable as the newest");
  const restored = projectMobileView(workspace([task("old", { archivedAt: NOW - 2 }), task("new"), task("live")]), NOW);
  const patch = diffMobileView(view, restored);
  assert.equal(patch?.archived, 1);
  assert.equal(applyMobilePatch(view, patch!)?.archived, 1);
});

test("decisions, suggestions and a limit travel in the open thread's delta only when they move", () => {
  const decision = { id: "d1", question: "Which?", options: [], raisedAt: NOW };
  const before = projectMobileView(workspace([task("lead", { role: "coordinator" })], { currentId: "lead" }), NOW);
  const after = projectMobileView(workspace([task("lead", { role: "coordinator", decisions: [decision] })], { currentId: "lead" }), NOW);
  const patch = diffMobileView(before, after);
  assert.equal(patch?.thread?.kind, "changed");
  const delta = patch?.thread?.kind === "changed" ? patch.thread.delta : {};
  assert.deepEqual(Object.keys(delta).filter((key) => ["decisions", "suggestions", "limit"].includes(key)), ["decisions"]);
  assert.deepEqual(applyMobilePatch(before, patch!)?.thread?.decisions, after.thread?.decisions);
});
