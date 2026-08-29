import assert from "node:assert/strict";
import { test } from "vitest";
import { findThread, resolveScope, threadBusy, threadHandleOptions, threadSummaries, threadTranscript, threadWaitResult } from "../../src/application/thread-projection.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ThreadFilter } from "../../src/contracts/threads.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";

const HOUR = 60 * 60 * 1000;
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
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspace(threads: Thread[], overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    ...emptyWorkspaceState(),
    threads,
    projects: [{ id: "project-app", root: "/code/app" }, { id: "project-site", root: "/code/site" }],
    ...overrides,
  };
}

test("threads are scoped to a project, and the caller's own project is what \"current\" means", () => {
  const state = workspace([task("in-app", { projectId: "project-app" }), task("loose")]);

  assert.deepEqual(resolveScope(state, "in-app"), { kind: "project", projectId: "project-app" });
  assert.deepEqual(resolveScope(state, "loose"), { kind: "projectless" });
  assert.deepEqual(resolveScope(state, "in-app", "all"), { kind: "all" });
  assert.deepEqual(resolveScope(state, "loose", "/code/site"), { kind: "project", projectId: "project-site" });
  const missing = resolveScope(state, "loose", "/code/missing");
  assert.ok("error" in missing);
  assert.match(missing.error, /No project matches/);

  assert.deepEqual(threadSummaries(state, { scope: { kind: "projectless" } }, NOW).map((thread) => thread.id), ["loose"]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" } }, NOW).map((thread) => thread.id).sort(), ["in-app", "loose"]);
});

test("a project answers to its folder name, and a reference that matches nothing says what is open", () => {
  const state = workspace([task("loose")]);

  assert.deepEqual(resolveScope(state, "loose", "site"), { kind: "project", projectId: "project-site" });
  assert.deepEqual(resolveScope(state, "loose", "SITE"), { kind: "project", projectId: "project-site" }, "the folder name is not case sensitive");
  assert.deepEqual(resolveScope(state, "loose", "/code/site/"), { kind: "project", projectId: "project-site" }, "a trailing separator is still the same folder");
  assert.deepEqual(resolveScope(state, "loose", "project-site"), { kind: "project", projectId: "project-site" }, "the id still resolves");

  const missing = resolveScope(state, "loose", "nowhere");
  assert.ok("error" in missing);
  assert.match(missing.error, /No project matches "nowhere"/);
  assert.match(missing.error, /app \(\/code\/app\), site \(\/code\/site\)/, "the error is what discovery there is");

  const twins = workspace([task("loose")], { projects: [{ id: "a", root: "/one/app" }, { id: "b", root: "/two/app" }] });
  const ambiguous = resolveScope(twins, "loose", "app");
  assert.ok("error" in ambiguous);
  assert.match(ambiguous.error, /More than one open project is named "app"/);
  assert.deepEqual(resolveScope(twins, "loose", "/two/app"), { kind: "project", projectId: "b" }, "the path settles it");
});

test("idleness counts real activity, not the last write to the thread", () => {
  const state = workspace([
    task("chatting", { messages: [message("hello", NOW - HOUR)], updatedAt: NOW }),
    task("stale", { messages: [message("hello", NOW - 6 * HOUR)], updatedAt: NOW, runEndedAt: NOW - 5 * HOUR }),
    task("untouched", { createdAt: NOW - 9 * HOUR, updatedAt: NOW }),
  ]);

  const idle = threadSummaries(state, { scope: { kind: "all" }, idleForMs: 3 * HOUR }, NOW);
  assert.deepEqual(idle.map((thread) => thread.id), ["stale", "untouched"], "newest activity first");
  assert.equal(idle[0].lastActivityAt, NOW - 5 * HOUR, "the run's end is activity even after the last message");
});

test("archived threads stay out until they are asked for, and search reads the transcript", () => {
  const state = workspace([
    task("live", { messages: [message("fix the header", NOW - HOUR)] }),
    task("filed", { archivedAt: NOW - HOUR, messages: [message("fix the header", NOW - 2 * HOUR)] }),
  ]);

  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" } }, NOW).map((thread) => thread.id), ["live"]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" }, archived: true }, NOW).map((thread) => thread.id), ["filed"]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" }, search: "HEADER" }, NOW).map((thread) => thread.id), ["live"]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" }, search: "footer" }, NOW), []);
  assert.equal(threadSummaries(state, { scope: { kind: "all" }, limit: 0 }, NOW).length, 0);
});

test("threads with images can be picked out, and a listing counts the messages carrying them", () => {
  const shot = { ...message("look at this", NOW - HOUR), attachments: ["/tmp/shot-1.png", "/tmp/shot-2.png"] };
  const state = workspace([
    task("illustrated", { messages: [shot, message("and this", NOW - HOUR / 2), { ...message("one more", NOW), attachments: ["/tmp/shot-3.png"] }] }),
    task("wordy", { messages: [message("no pictures here", NOW - 2 * HOUR)] }),
  ]);

  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" }, attachments: true }, NOW).map((thread) => thread.id), ["illustrated"]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" } }, NOW).map((thread) => thread.id), ["illustrated", "wordy"], "the filter only applies when asked for");

  const [illustrated, wordy] = threadSummaries(state, { scope: { kind: "all" } }, NOW);
  assert.equal(illustrated.attachmentCount, 2, "messages carrying images, not images");
  assert.equal(wordy.attachmentCount, 0);
});

test("a limited listing filters first and keeps stable activity ties", () => {
  const illustrated = (id: string, at: number, text = "keep") => task(id, {
    messages: [{ ...message(text, at), attachments: [`/tmp/${id}.png`] }],
  });
  const state = workspace([
    illustrated("newest", NOW),
    illustrated("tie-first", NOW - HOUR),
    illustrated("tie-second", NOW - HOUR),
    illustrated("wrong-search", NOW + HOUR, "discard"),
    task("no-image", { messages: [message("keep", NOW + HOUR)] }),
  ]);
  const filter: ThreadFilter = { scope: { kind: "all" }, search: "keep", attachments: true };

  const unlimited = threadSummaries(state, filter, NOW);
  const limited = threadSummaries(state, { ...filter, limit: 2 }, NOW);

  assert.deepEqual(unlimited.map((thread) => thread.id), ["newest", "tie-first", "tie-second"]);
  assert.deepEqual(limited, unlimited.slice(0, 2));
});

test("a transcript keeps the newest messages and says how many it left behind", () => {
  const messages = Array.from({ length: 5 }, (_item, index) => message(`turn ${index}`, NOW - (5 - index) * HOUR));
  const state = workspace([task("long", { projectId: "project-app", messages })]);

  const transcript = threadTranscript(state, "long", 2);
  assert.ok(transcript);
  assert.deepEqual(transcript.messages.map((item) => item.text), ["turn 3", "turn 4"]);
  assert.equal(transcript.omitted, 3);
  assert.equal(transcript.thread.projectRoot, "/code/app");
  assert.equal(transcript.thread.messageCount, 5);
  assert.equal(threadTranscript(state, "missing"), null);
});

test("a long message is cut short rather than shipped whole", () => {
  const state = workspace([task("noisy", { messages: [message("x".repeat(5_000), NOW)] })]);

  const transcript = threadTranscript(state, "noisy");
  assert.ok(transcript);
  const [only] = transcript.messages;
  assert.ok(only);
  assert.equal(only.text.length, 2_001);
  assert.ok(only.text.endsWith("…"));
});

test("a thread counts as working while a run is going, resolving, or still queued", () => {
  const threads = [task("running"), task("resolving"), task("queued"), task("done")];
  const state = workspace(threads, {
    activeRuns: { running: {
      taskId: "running",
      runId: "run-1",
      sequence: 0,
      status: "running",
      origin: "composer",
      quiet: false,
      notified: false,
      acknowledged: false,
      reportedIssues: [],
      messagesBefore: 0,
      before: { updatedAt: NOW },
    } },
    pendingRuns: { "pending-1": { id: "pending-1", runId: "run-2", origin: "composer", taskId: "resolving", text: "go", prompt: "go", attachments: [] } },
    queuedMessages: { queued: [{ id: "message-1", text: "next", prompt: "next", attachments: [] }] },
  });

  assert.deepEqual(threads.map((item) => threadBusy(state, item.id)), [true, true, true, false]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" } }, NOW).filter((thread) => thread.status === "running").map((thread) => thread.id).sort(), ["queued", "resolving", "running"]);
});

test("a wait reports the thread and the last thing it said", () => {
  const state = workspace([task("answered", {
    messages: [
      message("do it", NOW - HOUR),
      message("still working", NOW - 3 * HOUR / 4, "assistant"),
      message("done", NOW - HOUR / 2, "assistant"),
      message("Bash", NOW, "tool"),
    ],
  })]);

  const waited = threadWaitResult(state, "answered", false);
  assert.ok(waited);
  assert.equal(waited.reply, "done", "a tool message after the reply does not stand in for it");
  assert.equal(waited.timedOut, false);
  assert.equal(waited.thread.status, "idle");
  assert.equal(threadWaitResult(state, "missing", false), null);
  assert.equal(threadWaitResult(workspace([task("silent")]), "silent", true)!.reply, null);
});

test("a thread in a worktree reports the checkout it actually works in", () => {
  const worktree = { id: "wt1", projectId: "project-app", root: "/worktrees/app-wt1", workspaceId: "worktree-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  const state = { ...workspace([task("task-a", { projectId: "project-app", worktreeId: worktree.id }), task("task-b", { projectId: "project-app" })]), worktrees: [worktree] };

  const [inWorktree, local] = threadSummaries(state, { scope: { kind: "all" } }, NOW).sort((left, right) => left.id.localeCompare(right.id));

  assert.equal(inWorktree.worktreeRoot, "/worktrees/app-wt1");
  assert.equal(inWorktree.projectRoot, "/code/app", "it still belongs to its project");
  assert.equal(local.worktreeRoot, undefined);
});

test("a draft is offered every project's threads, with its own project marked as the ones in scope", () => {
  const state = workspace([
    task("in-app", { projectId: "project-app", title: "Raise the dock" }),
    task("in-site", { projectId: "project-site", title: "Raise the panel" }),
    task("caller", { projectId: "project-app" }),
    task("gone", { projectId: "project-app", archivedAt: NOW }),
  ]);

  const options = threadHandleOptions(state, "caller");
  assert.deepEqual(options.map((option) => [option.id, option.handle, option.inScope]), [
    ["in-app", "raise-the-dock", true],
    ["in-site", "site/raise-the-panel", false],
  ]);
});

test("a draft with no thread of its own is scoped to wherever the sidebar is pointed", () => {
  const state = workspace(
    [task("in-app", { projectId: "project-app" }), task("in-site", { projectId: "project-site" })],
    { draftProjectId: "project-site" },
  );

  assert.deepEqual(
    threadHandleOptions(state, "draft:project-site").map((option) => [option.id, option.inScope]),
    [["in-app", false], ["in-site", true]],
  );
});

test("thread options keep first-match project and busy semantics while sharing their lookups", () => {
  const state = workspace([
    task("first", { projectId: "duplicate", title: "Same title", createdAt: NOW }),
    task("second", { projectId: "duplicate", title: "Same title", createdAt: NOW }),
    task("empty-queue", { projectId: "duplicate" }),
    task("resolving", { projectId: "duplicate" }),
  ], {
    projects: [
      { id: "duplicate", root: "/first", name: "First" },
      { id: "duplicate", root: "/second", name: "Second" },
      { id: "draft", root: "/draft" },
    ],
    draftProjectId: "draft",
    queuedMessages: { "empty-queue": [] },
    creatingWorktrees: ["empty-queue"],
    pendingRuns: {
      pending: { id: "pending", runId: "run", origin: "composer", taskId: "resolving", text: "go", prompt: "go", attachments: [] },
    },
  });

  const options = threadHandleOptions(state, "draft:draft");
  assert.deepEqual(options.slice(0, 2).map(({ id, handle }) => [id, handle]), [
    ["first", "first/same-title"],
    ["second", "first/same-title-cond"],
  ]);
  assert.equal(options.find((option) => option.id === "empty-queue")!.running, false, "an empty queue and a checkout alone are not a run");
  assert.equal(options.find((option) => option.id === "resolving")!.running, true);
});

test("a thread answers to its id, an id prefix, or its title, and the newest wins a tie", () => {
  const state = workspace([
    task("t-9f2c00", { title: "Sink the mode choices", runEndedAt: NOW - HOUR }),
    task("t-3a1100", { title: "Sink the mode choices", runEndedAt: NOW }),
  ]);

  assert.equal(findThread(state, "t-9f2c00")?.id, "t-9f2c00");
  assert.equal(findThread(state, "t-9f2c")?.id, "t-9f2c00");
  assert.equal(findThread(state, "Sink the mode choices")?.id, "t-3a1100");
  assert.equal(findThread(state, "sink the mode choices")?.id, "t-3a1100");
  assert.equal(findThread(state, "nothing at all"), null);
  assert.equal(findThread(state, "  "), null);
  assert.equal(threadTranscript(state, "Sink the mode choices")?.thread.id, "t-3a1100");
});

test("a title outranks a newer id prefix, and activity ties keep task order", () => {
  const state = workspace([
    task("topic-newest-prefix", { title: "Something else", runEndedAt: NOW + HOUR }),
    task("title-first", { title: "Topic", runEndedAt: NOW }),
    task("title-second", { title: " topic ", runEndedAt: NOW }),
    task("prefix-first", { runEndedAt: NOW }),
    task("prefix-second", { runEndedAt: NOW }),
  ]);

  assert.equal(findThread(state, "topic")?.id, "title-first");
  assert.equal(findThread(state, "prefix-")?.id, "prefix-first");
});
