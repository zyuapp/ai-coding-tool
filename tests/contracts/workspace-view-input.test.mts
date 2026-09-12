import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { isWorkspaceViewInput, type WorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";

test("the view can send provider commands, attachments, and presentation reports", () => {
  const inputs: WorkspaceViewInput[] = [
    { type: "engine.reload-settings" },
    { type: "task.send", taskId: "thread", text: "Review the screenshot", attachments: [{ path: "/tmp/screenshot.png", labels: ["button", ""] }], steer: true },
    { type: "task.set-policy", policy: "autonomous" },
    { type: "task.set-effort", engine: "codex", effort: "xhigh" },
    { type: "task.set-effort", engine: "claude", effort: "max" },
    { type: "question.answer", taskId: "thread", runId: "run", requestId: "request", questionId: "question", text: "Use the first choice" },
    { type: "question.set-answer", taskId: "thread", runId: "run", requestId: "request", questionId: "question", text: "" },
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
    { type: "diff.set-mode", mode: "branch" },
    { type: "diff.open-commit", taskId: "thread", commit: "60cceb8" },
    { type: "diff.set-range", range: { kind: "commit", commit: "60cceb8" } },
    { type: "image.open", source: "message-image://file/?path=%2Ftmp%2Fshot.png&root=&message=reply" },
    { type: "image.close" },
    { type: "image.download" },
    { type: "find.results", target: { kind: "terminal", terminalId: "terminal" }, results: { matches: 0, index: 0, counting: false } },
    { type: "shortcut.captured", binding: null },
    { type: "shortcut.unavailable", refusal: { reason: "unsupported", binding: "Meta+Shift+P", message: "Not available" } },
    { type: "action.failed", message: "Could not read the dropped file" },
  ];
  for (const input of inputs) assert.equal(isWorkspaceViewInput(input), true, input.type);
});

test("a view cannot inject storage, provider, or scheduler events", () => {
  const types = ["store.loaded", "store.thread-loaded", "store.absent", "store.failed", "run.resolved", "run.event", "thread.event", "agent.events", "automation.fired", "remote.changed", "engine.loaded", "worktree.deleted", "preferences.loaded"];
  for (const type of types) assert.equal(isWorkspaceViewInput({ type }), false, type);
  for (const value of [null, [], "task.send", {}, { type: "__proto__" }, { type: "constructor" }, { type: "unknown" }]) {
    assert.equal(isWorkspaceViewInput(value), false);
  }
});

test("malformed fields and nested values are rejected before reaching the reducer", () => {
  const inputs = [
    { type: "diff.set-mode", mode: "pull-request" },
    { type: "task.select" },
    { type: "task.select", taskId: 42 },
    { type: "task.send", text: null },
    { type: "task.send", attachments: [{ path: "/image", labels: [1] }] },
    { type: "task.send", attachments: new Array(2) },
    { type: "question.answer", taskId: "thread", runId: "run", requestId: "request" },
    { type: "question.set-answer", taskId: "thread", runId: "run", requestId: "request", questionId: "question", text: null },
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

test("image and commit actions validate their targets at the view boundary", () => {
  assert.equal(isWorkspaceViewInput({ type: "image.open", source: "file:///etc/passwd" }), false);
  assert.equal(isWorkspaceViewInput({ type: "image.open", source: "https://example.com/image.png" }), false);
  assert.equal(isWorkspaceViewInput({ type: "diff.open-commit", commit: "--output=/tmp/file" }), false);
  assert.equal(isWorkspaceViewInput({ type: "diff.set-range", range: { kind: "commit", commit: "HEAD;touch x" } }), false);
});

test("every command the application declares has exactly one shape", async () => {
  const commands = await readFile(new URL("../../src/contracts/commands.ts", import.meta.url), "utf8");
  const shapes = await readFile(new URL("../../src/contracts/workspace-view-input.ts", import.meta.url), "utf8");
  const table = shapes.slice(shapes.indexOf("const shapes = {"));
  const declared = new Set([...commands.matchAll(/\{ type: "([\w.-]+)"/g)].map(([, type]) => type));
  assert.ok(declared.size > 100, `found ${declared.size} command types`);
  for (const type of declared) {
    const entries = [...table.matchAll(new RegExp(`^ {2}"${type.replace(/\./g, "\\.")}":`, "gm"))];
    assert.equal(entries.length, 1, `${type} has ${entries.length} shape entries`);
  }
});
