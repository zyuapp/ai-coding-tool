import assert from "node:assert/strict";
import { test } from "vitest";
import { isWorkspaceViewInput, type WorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";

test("the view can send provider commands, attachments, and presentation reports", () => {
  const inputs: WorkspaceViewInput[] = [
    { type: "task.send", taskId: "thread", text: "Review the screenshot", attachments: [{ path: "/tmp/screenshot.png", labels: ["button", ""] }], steer: true },
    { type: "task.set-policy", policy: "autonomous" },
    { type: "task.set-effort", engine: "codex", effort: "xhigh" },
    { type: "task.set-effort", engine: "claude", effort: "max" },
    { type: "question.answer", taskId: "thread", runId: "run", requestId: "request", questionId: "question", text: "Use the first choice" },
    { type: "annotation.add", quote: "text", anchor: { kind: "message", messageId: "message", start: 0, end: 4 } },
    { type: "annotation.recall", annotations: [{ id: "annotation", quote: "text", note: "", anchor: { kind: "diff", comparison: "working", path: "src/app.ts", start: "1", end: "2", side: "new" } }] },
    { type: "file.attach", files: [{ path: "/repo/src", name: "src", folder: true }] },
    { type: "file.recall", files: [{ id: "file", path: "/repo/file", name: "file" }] },
    { type: "view.reading-point", taskId: "thread", point: { anchor: "message", depth: 0.5 } },
    { type: "view.reading-point", taskId: "thread", point: null },
    { type: "view.set-prompt", prompt: "", taskId: undefined },
    { type: "view.set-menu", menu: null },
    { type: "view.select-dock-index", index: -1 },
    { type: "browser.act", action: { kind: "type", ref: "1", text: "", submit: true } },
    { type: "task.move-worktree", destination: { kind: "worktree", id: "checkout" } },
    { type: "automation.save", draft: { prompt: "Check status", schedule: "0 * * * *", paused: false } },
    { type: "automation.update", patch: { surfaceWhen: "", paused: true } },
    { type: "review.start", target: { type: "commit", sha: "abc", title: null } },
    { type: "find.results", target: { kind: "terminal", terminalId: "terminal" }, results: { matches: 0, index: 0, counting: false } },
    { type: "shortcut.captured", binding: null },
    { type: "shortcut.unavailable", refusal: { reason: "unsupported", binding: "Meta+Shift+P", message: "Not available" } },
    { type: "action.failed", message: "Could not read the dropped file" },
  ];
  for (const input of inputs) assert.equal(isWorkspaceViewInput(input), true, input.type);
});

test("a view cannot inject storage, provider, scheduler, or history events", () => {
  const types = ["store.loaded", "store.thread-loaded", "store.absent", "store.failed", "run.resolved", "run.event", "thread.event", "agent.events", "automation.fired", "remote.changed", "engine.loaded", "worktree.deleted", "preferences.loaded"];
  for (const type of types) assert.equal(isWorkspaceViewInput({ type }), false, type);
  for (const value of [null, [], "task.send", {}, { type: "__proto__" }, { type: "constructor" }, { type: "unknown" }]) {
    assert.equal(isWorkspaceViewInput(value), false);
  }
});

test("malformed fields and nested values are rejected before reaching the reducer", () => {
  const inputs = [
    { type: "task.select" },
    { type: "task.select", taskId: 42 },
    { type: "task.send", text: null },
    { type: "task.send", attachments: [{ path: "/image", labels: [1] }] },
    { type: "task.send", attachments: new Array(2) },
    { type: "question.answer", taskId: "thread", runId: "run", requestId: "request" },
    { type: "question.reply-mode", taskId: "thread", runId: "run", replying: "yes" },
    { type: "task.set-model", engine: "codex", model: "invented" },
    { type: "task.set-effort", engine: "claude", effort: "invented" },
    { type: "task.set-policy", policy: "unrestricted" },
    { type: "annotation.add", quote: "text", anchor: { kind: "message", messageId: "id", start: "0", end: 4 } },
    { type: "annotation.recall", annotations: [{ id: "a", quote: "text" }] },
    { type: "file.attach", files: [{ path: "/repo/file", name: "file", folder: false }] },
    { type: "browser.act", action: { kind: "execute", text: "arbitrary script" } },
    { type: "browser.go", delta: 100 },
    { type: "terminal.resize", terminalId: "term", cols: Infinity, rows: 80 },
    { type: "view.reading-point", taskId: "thread", point: { anchor: "message", depth: NaN } },
    { type: "task.move-worktree", destination: { kind: "worktree" } },
    { type: "view.set-capture-options", options: { sound: true } },
    { type: "find.results", target: { kind: "terminal" }, results: { matches: 2 } },
    { type: "find.results", target: { kind: "thread", taskId: null }, results: { matches: "many" } },
    { type: "shortcut.unavailable", refusal: { reason: "taken", binding: "Meta+P" } },
  ];
  for (const input of inputs) assert.equal(isWorkspaceViewInput(input), false, JSON.stringify(input));
});

test("large valid composer content remains within the view contract", () => {
  const text = "x".repeat(2_000_000);
  assert.equal(isWorkspaceViewInput({ type: "paste.add", text }), true);
  assert.equal(isWorkspaceViewInput({ type: "task.send", text, attachments: Array.from({ length: 6 }, (_, index) => ({ path: `/tmp/${index}.png`, labels: [] })) }), true);
});
