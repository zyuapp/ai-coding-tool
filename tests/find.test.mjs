import assert from "node:assert/strict";
import test from "node:test";
import { findHits, MAX_FIND_HITS, sameFindTarget, stepMatch } from "../dist/main/domain/find.js";
import { reduce } from "../dist/main/application/workspace-reducer.js";
import { deriveView, dockFor, dockOwner, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";

function messages(...entries) {
  return entries.map((entry, index) => ({ id: `m${index}`, at: index * 1000, ...entry }));
}

function thread(...entries) {
  const task = {
    id: "t1",
    title: "T",
    executionPolicy: "confirm",
    messages: messages(...entries),
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
  return { ...emptyWorkspaceState(), tasks: [task], currentId: task.id };
}

function run(state, inputs) {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

test("a query matches a thread's own text, folded and off-screen alike", () => {
  const found = findHits(messages(
    { kind: "user", text: "Where is the retry?" },
    { kind: "tool", text: "Read", detail: "retry once, then retry again" },
    { kind: "assistant", text: "Nothing here." },
  ), "RETRY");

  assert.deepEqual(found, [
    { messageId: "m0", field: "text", start: 13, occurrence: 0 },
    { messageId: "m1", field: "detail", start: 0, occurrence: 0 },
    { messageId: "m1", field: "detail", start: 17, occurrence: 1 },
  ]);
});

test("a query nothing can be searched for finds nothing", () => {
  assert.deepEqual(findHits(messages({ kind: "user", text: "anything" }), "   "), []);
});

test("a query that matches everything is capped", () => {
  const wall = messages({ kind: "assistant", text: "a".repeat(MAX_FIND_HITS + 50) });

  assert.equal(findHits(wall, "a").length, MAX_FIND_HITS);
});

test("stepping wraps at both ends, and stays put with nothing to step through", () => {
  assert.equal(stepMatch(2, 1, 3), 0);
  assert.equal(stepMatch(0, -1, 3), 2);
  assert.equal(stepMatch(0, 1, 0), 0);
});

test("sameFindTarget tells one page from another", () => {
  assert.ok(sameFindTarget({ kind: "transcript" }, { kind: "transcript" }));
  assert.ok(!sameFindTarget({ kind: "browser", tabId: "a" }, { kind: "browser", tabId: "b" }));
  assert.ok(!sameFindTarget({ kind: "browser", tabId: "a" }, { kind: "terminal", terminalId: "a" }));
});

test("⌘F over the transcript counts matches here and steps through them", () => {
  const state = thread(
    { kind: "user", text: "retry" },
    { kind: "tool", text: "Read", detail: "retry twice" },
  );
  const opened = reduce(state, { type: "view.shortcut", action: "find.open", surface: "any" });

  assert.deepEqual(opened.effects, [], "a thread's own matches need nothing outside the reducer");
  assert.deepEqual(opened.state.find.target, { kind: "transcript" });

  const searching = reduce(opened.state, { type: "view.find-query", query: "retry" }).state;
  assert.equal(deriveView(searching).find.matches, 2);
  assert.deepEqual(deriveView(searching).find.hit, { messageId: "m0", field: "text", start: 0, occurrence: 0 });

  const stepped = run(searching, [{ type: "view.find-step", delta: 1 }, { type: "view.find-step", delta: 1 }]);
  assert.equal(deriveView(stepped).find.index, 0, "stepping past the last match wraps to the first");
});

test("find belongs to the thread it is searching, so moving away closes it", () => {
  const state = thread({ kind: "user", text: "retry" });
  const other = { ...state, tasks: [...state.tasks, { ...state.tasks[0], id: "t2", messages: [] }] };
  const searching = run(other, [{ type: "view.find-open" }, { type: "view.find-query", query: "retry" }]);

  assert.equal(reduce(searching, { type: "task.select", taskId: "t2" }).state.find, null);
});

test("⌘F while a page has the keys searches the page, and takes the keyboard back for the bar", () => {
  const opened = reduce(emptyWorkspaceState(), { type: "browser.new-tab" }).state;
  const tabId = dockFor(opened, dockOwner(opened)).browserTabId;
  const finding = reduce(opened, { type: "view.shortcut", action: "find.open", surface: "browser" });

  assert.deepEqual(finding.state.find.target, { kind: "browser", tabId });
  assert.deepEqual(finding.effects, [{ type: "focus-window" }]);

  const searching = reduce(finding.state, { type: "view.find-query", query: "invoice" });
  assert.deepEqual(searching.effects, [{ type: "find-in-page", tabId, query: "invoice", forward: true, findNext: false }]);

  const stepped = reduce(searching.state, { type: "view.find-step", delta: -1 });
  assert.deepEqual(stepped.effects, [{ type: "find-in-page", tabId, query: "invoice", forward: false, findNext: true }]);

  const reported = reduce(stepped.state, { type: "find.results", target: { kind: "browser", tabId }, results: { matches: 4, index: 3 } }).state;
  assert.deepEqual(deriveView(reported).find.matches, 4);
  assert.deepEqual(deriveView(reported).find.index, 3);

  assert.deepEqual(reduce(reported, { type: "view.find-close" }).effects, [{ type: "stop-find-in-page", tabId }]);
});

test("a page that closes takes the search of it with it", () => {
  const opened = reduce(emptyWorkspaceState(), { type: "browser.new-tab" }).state;
  const tabId = dockFor(opened, dockOwner(opened)).browserTabId;
  const searching = run(opened, [
    { type: "view.shortcut", action: "find.open", surface: "browser" },
    { type: "view.find-query", query: "invoice" },
  ]);

  assert.equal(reduce(searching, { type: "browser.close-tab", tabId }).state.find, null);
});

test("⌘F while a shell has the keys searches that shell", () => {
  const opened = reduce({ ...emptyWorkspaceState(), lastFolder: "/p" }, { type: "terminal.open" }).state;
  const terminalId = dockFor(opened, dockOwner(opened)).terminalId;
  const focused = reduce(opened, { type: "terminal.focus", terminalId }).state;
  const finding = reduce(focused, { type: "view.shortcut", action: "find.open", surface: "any" });

  assert.deepEqual(finding.state.find.target, { kind: "terminal", terminalId });

  const searching = reduce(finding.state, { type: "view.find-query", query: "npm" });
  assert.deepEqual(searching.effects, [{ type: "find-in-terminal", terminalId, query: "npm", forward: true }]);
  assert.deepEqual(reduce(searching.state, { type: "view.find-close" }).effects, [{ type: "stop-find-in-terminal", terminalId }]);
});

test("asking for find again keeps what it was searching and takes the caret back", () => {
  const state = thread({ kind: "user", text: "retry" });
  const searching = run(state, [{ type: "view.find-open" }, { type: "view.find-query", query: "retry" }]);
  const again = reduce(searching, { type: "view.shortcut", action: "find.open", surface: "any" }).state;

  assert.equal(again.find.query, "retry");
  assert.equal(again.find.focus, searching.find.focus + 1);
});

test("⌘G opens find when it is closed, and steps it when it is not", () => {
  const state = thread({ kind: "user", text: "retry retry" });
  const opened = reduce(state, { type: "view.shortcut", action: "find.next", surface: "any" }).state;
  assert.deepEqual(opened.find.target, { kind: "transcript" });

  const searching = reduce(opened, { type: "view.find-query", query: "retry" }).state;
  const stepped = reduce(searching, { type: "view.shortcut", action: "find.next", surface: "any" }).state;
  assert.equal(stepped.find.index, 1);
});
