import assert from "node:assert/strict";
import { test } from "vitest";
import { fileReviewHits, findHits, MAX_FIND_HITS, reviewHits, sameFindTarget, sameReviewHit, searchesItself, stepMatch, type ReviewFile } from "../../src/domain/find.ts";
import type { DiffFile, DiffLineKind } from "../../src/domain/diff.ts";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { DIFF_PANEL, deriveView, dockFor, dockOwner, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";

type MessageSeed = Omit<ConversationMessage, "id" | "at"> & Partial<Pick<ConversationMessage, "id" | "at">>;

function messages(...entries: MessageSeed[]): ConversationMessage[] {
  return entries.map((entry, index) => ({ id: `m${index}`, at: index * 1000, ...entry }));
}

function thread(...entries: MessageSeed[]): WorkspaceState {
  const subject: Thread = {
    id: "t1",
    title: "T",
    engine: "claude",
    executionPolicy: "confirm",
    messages: messages(...entries),
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
  return { ...emptyWorkspaceState(), threads: [subject], currentId: subject.id };
}

function run(state: WorkspaceState, inputs: WorkspaceInput[]): WorkspaceState {
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
  const found = findHits(wall, "a");

  assert.equal(found.length, MAX_FIND_HITS);
  assert.deepEqual(found.at(-1), { messageId: "m0", field: "text", start: MAX_FIND_HITS - 1, occurrence: MAX_FIND_HITS - 1 });
});

test("a message counts text then detail, and the next message starts its own occurrence count", () => {
  const found = findHits(messages(
    { kind: "tool", text: "hit hit", detail: "hit" },
    { kind: "assistant", text: "hit" },
  ), "hit");

  assert.deepEqual(found, [
    { messageId: "m0", field: "text", start: 0, occurrence: 0 },
    { messageId: "m0", field: "text", start: 4, occurrence: 1 },
    { messageId: "m0", field: "detail", start: 0, occurrence: 2 },
    { messageId: "m1", field: "text", start: 0, occurrence: 0 },
  ]);
});

test("stepping wraps at both ends, and stays put with nothing to step through", () => {
  assert.equal(stepMatch(2, 1, 3), 0);
  assert.equal(stepMatch(0, -1, 3), 2);
  assert.equal(stepMatch(0, 1, 0), 0);
});

test("sameFindTarget tells one page from another", () => {
  assert.ok(sameFindTarget({ kind: "thread", taskId: "t1" }, { kind: "thread", taskId: "t1" }));
  assert.ok(!sameFindTarget({ kind: "thread", taskId: "t1" }, { kind: "thread", taskId: "t2" }));
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
  assert.deepEqual(opened.state.find!.target, { kind: "thread", taskId: "t1" });

  const searching = reduce(opened.state, { type: "view.find-query", query: "retry" }).state;
  assert.equal(deriveView(searching).find!.matches, 2);
  assert.deepEqual(deriveView(searching).find!.hit, { messageId: "m0", field: "text", start: 0, occurrence: 0 });

  const stepped = run(searching, [{ type: "view.find-step", delta: 1 }, { type: "view.find-step", delta: 1 }]);
  assert.equal(deriveView(stepped).find!.index, 0, "stepping past the last match wraps to the first");
});

test("find belongs to the thread it is searching, so moving away closes it", () => {
  const state = thread({ kind: "user", text: "retry" });
  const other: WorkspaceState = { ...state, threads: [...state.threads, { ...state.threads[0], id: "t2", messages: [] }] };
  const searching = run(other, [{ type: "view.find-open" }, { type: "view.find-query", query: "retry" }]);

  assert.equal(reduce(searching, { type: "task.select", taskId: "t2" }).state.find, null);
});

test("⌘F while a page has the keys searches the page, and takes the keyboard back for the bar", () => {
  const opened = reduce(emptyWorkspaceState(), { type: "browser.new-tab" }).state;
  const tabId = dockFor(opened, dockOwner(opened)).browserTabId;
  assert.ok(tabId);
  const finding = reduce(opened, { type: "view.shortcut", action: "find.open", surface: "browser" });

  assert.deepEqual(finding.state.find!.target, { kind: "browser", tabId });
  assert.deepEqual(finding.effects, [{ type: "focus-window" }]);

  const searching = reduce(finding.state, { type: "view.find-query", query: "invoice" });
  assert.deepEqual(searching.effects, [{ type: "find-in-page", tabId, query: "invoice", forward: true, findNext: false }]);

  const stepped = reduce(searching.state, { type: "view.find-step", delta: -1 });
  assert.deepEqual(stepped.effects, [{ type: "find-in-page", tabId, query: "invoice", forward: false, findNext: true }]);

  const reported = reduce(stepped.state, { type: "find.results", target: { kind: "browser", tabId }, results: { matches: 4, index: 3 } }).state;
  assert.deepEqual(deriveView(reported).find!.matches, 4);
  assert.deepEqual(deriveView(reported).find!.index, 3);

  assert.deepEqual(reduce(reported, { type: "view.find-close" }).effects, [
    { type: "stop-find-in-page", tabId },
    { type: "focus-browser", tabId },
  ]);
});

test("a page that closes takes the search of it with it", () => {
  const opened = reduce(emptyWorkspaceState(), { type: "browser.new-tab" }).state;
  const tabId = dockFor(opened, dockOwner(opened)).browserTabId;
  assert.ok(tabId);
  const searching = run(opened, [
    { type: "view.shortcut", action: "find.open", surface: "browser" },
    { type: "view.find-query", query: "invoice" },
  ]);

  assert.equal(reduce(searching, { type: "browser.close-tab", tabId }).state.find, null);
});

test("⌘F while a shell has the keys searches that shell", () => {
  const opened = reduce({ ...emptyWorkspaceState(), lastFolder: "/p" }, { type: "terminal.open" }).state;
  const terminalId = dockFor(opened, dockOwner(opened)).terminalId;
  assert.ok(terminalId);
  const focused = reduce(opened, { type: "view.dock-keys", tab: terminalId }).state;
  const finding = reduce(focused, { type: "view.shortcut", action: "find.open", surface: "any" });

  assert.deepEqual(finding.state.find!.target, { kind: "terminal", terminalId });

  const searching = reduce(finding.state, { type: "view.find-query", query: "npm" });
  assert.deepEqual(searching.effects, [{ type: "find-in-terminal", terminalId, query: "npm", forward: true }]);
  assert.deepEqual(reduce(searching.state, { type: "view.find-close" }).effects, [{ type: "stop-find-in-terminal", terminalId }]);
});

test("⌘F searches whichever dock view holds the keys", () => {
  const state = run(thread({ kind: "user", text: "retry" }), [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "view.open-dock-panel", panel: DIFF_PANEL },
  ]);
  const owner = dockOwner(state);

  const inPanel = reduce(state, { type: "view.dock-keys", tab: "agents" }).state;
  assert.deepEqual(reduce(inPanel, { type: "view.shortcut", action: "find.open", surface: "any" }).state.find!.target, { kind: "panel", owner, panel: "agents" });

  const inReview = reduce(state, { type: "view.dock-keys", tab: DIFF_PANEL }).state;
  assert.deepEqual(reduce(inReview, { type: "view.shortcut", action: "find.open", surface: "any" }).state.find!.target, { kind: "review", owner });

  const back = reduce(inReview, { type: "view.dock-keys", tab: null }).state;
  assert.deepEqual(reduce(back, { type: "view.shortcut", action: "find.open", surface: "any" }).state.find!.target, { kind: "thread", taskId: "t1" });
});

test("a side chat is searched by the thread search, pointed at the chat's own task", () => {
  const state = run(thread({ kind: "user", text: "retry" }), [{ type: "side-chat.open", chatId: "chat-1" }]);
  const typing = reduce(state, { type: "view.dock-keys", tab: "chat-1" }).state;
  const finding = reduce(typing, { type: "view.shortcut", action: "find.open", surface: "any" });

  assert.deepEqual(finding.effects, [], "a chat's messages are counted here, like any other thread's");
  assert.deepEqual(finding.state.find!.target, { kind: "thread", taskId: "chat-1" });

  const closed = reduce(finding.state, { type: "side-chat.close", chatId: "chat-1" }).state;
  assert.equal(closed.find, null, "the chat going takes its bar with it");
});

test("asking for find again keeps what it was searching and takes the caret back", () => {
  const state = thread({ kind: "user", text: "retry" });
  const searching = run(state, [{ type: "view.find-open" }, { type: "view.find-query", query: "retry" }]);
  const again = reduce(searching, { type: "view.shortcut", action: "find.open", surface: "any" }).state;

  assert.equal(again.find!.query, "retry");
  assert.equal(again.find!.focus, searching.find!.focus + 1);
});

test("⌘G opens find when it is closed, and steps it when it is not", () => {
  const state = thread({ kind: "user", text: "retry retry" });
  const opened = reduce(state, { type: "view.shortcut", action: "find.next", surface: "any" }).state;
  assert.deepEqual(opened.find!.target, { kind: "thread", taskId: "t1" });

  const searching = reduce(opened, { type: "view.find-query", query: "retry" }).state;
  const stepped = reduce(searching, { type: "view.shortcut", action: "find.next", surface: "any" }).state;
  assert.equal(stepped.find!.index, 1);
});

function patch(path: string, ...lines: Array<[DiffLineKind, string]>): DiffFile {
  return {
    path,
    hunks: [{
      header: "",
      oldStart: 1,
      oldLines: lines.length,
      newStart: 1,
      newLines: lines.length,
      rows: lines.map(([kind, text], index) => ({ kind, key: `0:${index}`, text, oldLine: index + 1, newLine: index + 1 })),
    }],
  };
}

test("a file's review matches read its name first, then its lines top to bottom", () => {
  const file = patch("src/find.ts", ["context", "const find = 1;"], ["add", "let other = 2;"], ["delete", "find(find);"]);

  assert.deepEqual(fileReviewHits("src/find.ts", file, "find", MAX_FIND_HITS), [
    { path: "src/find.ts", key: null, occurrence: 0 },
    { path: "src/find.ts", key: "0:0", occurrence: 0 },
    { path: "src/find.ts", key: "0:2", occurrence: 0 },
    { path: "src/find.ts", key: "0:2", occurrence: 1 },
  ]);
});

test("hunk headers are chrome, so nothing in one is ever a match", () => {
  const file = patch("a.ts", ["context", "kept"]);
  file.hunks[0].header = "function findHits";

  assert.deepEqual(fileReviewHits("a.ts", file, "find", MAX_FIND_HITS), []);
});

test("a file whose patch has not been read still answers for its own name", () => {
  assert.deepEqual(fileReviewHits("src/find.ts", null, "find", MAX_FIND_HITS), [
    { path: "src/find.ts", key: null, occurrence: 0 },
  ]);
});

test("a file's matches stop at the room left for them", () => {
  const file = patch("a.ts", ["add", "e e e"], ["add", "e e"]);

  assert.equal(fileReviewHits("a.ts", file, "e", 3).length, 3);
  assert.deepEqual(fileReviewHits("a.ts", file, "e", 0), []);
});

test("two review hits are the same only when they name the same match of the same row", () => {
  const hit = { path: "a.ts", key: "0:1", occurrence: 0 };
  assert.ok(sameReviewHit(hit, { ...hit }));
  assert.ok(!sameReviewHit(hit, { ...hit, occurrence: 1 }));
  assert.ok(!sameReviewHit(hit, { ...hit, key: null }));
  assert.ok(!sameReviewHit(hit, { ...hit, path: "b.ts" }));
});

test("a review target names the dock it belongs to", () => {
  assert.ok(sameFindTarget({ kind: "review", owner: "t1" }, { kind: "review", owner: "t1" }));
  assert.ok(!sameFindTarget({ kind: "review", owner: "t1" }, { kind: "review", owner: "t2" }));
  assert.ok(!searchesItself({ kind: "review", owner: "t1" }), "a review is counted where it is drawn");
  assert.ok(searchesItself({ kind: "browser", tabId: "a" }));
});

const READ = (path: string, ...lines: Array<[DiffLineKind, string]>): ReviewFile =>
  ({ path, version: `${path}|1`, file: patch(path, ...lines), coming: false });
const COMING = (path: string): ReviewFile => ({ path, version: `${path}|1`, file: null, coming: true });
const SKIPPED = (path: string): ReviewFile => ({ path, version: `${path}|1`, file: null, coming: false });

test("a folded file's matches fold in where its file sits, once its patch lands", () => {
  const before = reviewHits([READ("a.ts", ["add", "needle"]), COMING("b.ts"), READ("c.ts", ["add", "needle"])], "needle");

  assert.deepEqual(before.hits.map((hit) => [hit.path, hit.key]), [["a.ts", "0:0"], ["c.ts", "0:0"]]);
  assert.ok(before.counting, "a patch still on its way is a total that is not final");

  const after = reviewHits([READ("a.ts", ["add", "needle"]), READ("b.ts", ["add", "needle needle"]), READ("c.ts", ["add", "needle"])], "needle");

  assert.deepEqual(after.hits.map((hit) => [hit.path, hit.occurrence]), [["a.ts", 0], ["b.ts", 0], ["b.ts", 1], ["c.ts", 0]]);
  assert.ok(!after.counting);
});

test("a patch too large to show is skipped rather than waited on", () => {
  const found = reviewHits([SKIPPED("huge.lock"), READ("a.ts", ["add", "needle"])], "needle");

  assert.deepEqual(found.hits, [{ path: "a.ts", key: "0:0", occurrence: 0 }]);
  assert.ok(!found.counting, "a file that will never be read cannot hold the total open");
});

test("the order is the review's own, however the patches arrived", () => {
  const files = [READ("c.ts", ["add", "needle"]), READ("a.ts", ["add", "needle"]), READ("b.ts", ["add", "needle"])];
  const scanned = new Map();

  const first = reviewHits(files, "needle", scanned);
  const again = reviewHits([...files].reverse(), "needle", scanned);

  assert.deepEqual(first.hits.map((hit) => hit.path), ["c.ts", "a.ts", "b.ts"]);
  assert.deepEqual(again.hits.map((hit) => hit.path), ["b.ts", "a.ts", "c.ts"], "the list's order is the order");
});

test("a scanned file is not read again when another patch lands beside it", () => {
  const scanned = new Map();
  const one = reviewHits([READ("a.ts", ["add", "needle"]), COMING("b.ts")], "needle", scanned);
  const two = reviewHits([READ("a.ts", ["add", "needle"]), READ("b.ts", ["add", "needle"])], "needle", scanned);

  assert.equal(scanned.size, 2);
  assert.equal(two.hits[0], one.hits[0], "the first file's matches are the very same ones");
});

test("a review cannot build more matches than anyone would step through", () => {
  const many = Array.from({ length: 200 }, (unused, index) => READ(`file-${index}.ts`, ["add", "e e e e e"]));

  const found = reviewHits(many, "e", new Map());

  assert.equal(found.hits.length, MAX_FIND_HITS);
  assert.equal(found.hits[0].path, "file-0.ts");
});
