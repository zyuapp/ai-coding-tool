import assert from "node:assert/strict";
import test from "node:test";
import { resolveScope, threadBusy, threadSummaries, threadTranscript, threadWaitResult } from "../dist/main/application/thread-projection.js";
import { emptyWorkspaceState } from "../dist/main/application/workspace-state.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function message(text, at, kind = "user") {
  return { id: `${text}-${at}`, kind, text, at };
}

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: NOW },
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspace(tasks, overrides = {}) {
  return {
    ...emptyWorkspaceState(),
    tasks,
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
  assert.match(resolveScope(state, "loose", "/code/missing").error, /No project matches/);

  assert.deepEqual(threadSummaries(state, { scope: { kind: "projectless" } }, NOW).map((thread) => thread.id), ["loose"]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" } }, NOW).map((thread) => thread.id).sort(), ["in-app", "loose"]);
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

test("a transcript keeps the newest messages and says how many it left behind", () => {
  const messages = Array.from({ length: 5 }, (_item, index) => message(`turn ${index}`, NOW - (5 - index) * HOUR));
  const state = workspace([task("long", { projectId: "project-app", messages })]);

  const transcript = threadTranscript(state, "long", 2);
  assert.deepEqual(transcript.messages.map((item) => item.text), ["turn 3", "turn 4"]);
  assert.equal(transcript.omitted, 3);
  assert.equal(transcript.thread.projectRoot, "/code/app");
  assert.equal(transcript.thread.messageCount, 5);
  assert.equal(threadTranscript(state, "missing"), null);
});

test("a long message is cut short rather than shipped whole", () => {
  const state = workspace([task("noisy", { messages: [message("x".repeat(5_000), NOW)] })]);

  const [only] = threadTranscript(state, "noisy").messages;
  assert.equal(only.text.length, 2_001);
  assert.ok(only.text.endsWith("…"));
});

test("a thread counts as working while a run is going, resolving, or still queued", () => {
  const tasks = [task("running"), task("resolving"), task("queued"), task("done")];
  const state = workspace(tasks, {
    activeRuns: { running: { taskId: "running", runId: "run-1", sequence: 0, status: "running" } },
    pendingRuns: { "pending-1": { id: "pending-1", runId: "run-2", origin: "composer", taskId: "resolving", text: "go", prompt: "go", attachments: [] } },
    queuedMessages: { queued: [{ id: "message-1", text: "next", prompt: "next", attachments: [] }] },
  });

  assert.deepEqual(tasks.map((item) => threadBusy(state, item.id)), [true, true, true, false]);
  assert.deepEqual(threadSummaries(state, { scope: { kind: "all" } }, NOW).filter((thread) => thread.status === "running").map((thread) => thread.id).sort(), ["queued", "resolving", "running"]);
});

test("a wait reports the thread and the last thing it said", () => {
  const state = workspace([task("answered", {
    messages: [message("do it", NOW - HOUR), message("done", NOW - HOUR / 2, "assistant"), message("Bash", NOW, "tool")],
  })]);

  const waited = threadWaitResult(state, "answered", false);
  assert.equal(waited.reply, "done", "a tool message after the reply does not stand in for it");
  assert.equal(waited.timedOut, false);
  assert.equal(waited.thread.status, "idle");
  assert.equal(threadWaitResult(state, "missing", false), null);
  assert.equal(threadWaitResult(workspace([task("silent")]), "silent", true).reply, null);
});
