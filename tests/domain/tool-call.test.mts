import assert from "node:assert/strict";
import { test } from "vitest";

import { describeToolCall, toolFamily, toolLabel } from "../../src/domain/tool-call.ts";

test("a call is named by its argument, and marked by what kind of argument it is", () => {
  assert.deepEqual(describeToolCall("claude", "Bash", JSON.stringify({ command: "git status --short" })), { family: "shell", label: "Bash", sigil: "$", argument: "git status --short" });
  assert.deepEqual(describeToolCall("claude", "WebSearch", JSON.stringify({ query: "electron menu roles" })), { family: "web", label: "WebSearch", argument: "electron menu roles" });
  assert.deepEqual(describeToolCall("claude", "Task", JSON.stringify({ description: "audit the reducer", prompt: "…" })), { family: "agent", label: "Task", argument: "audit the reducer" });
});

test("a path keeps the two segments that say which file, and drops the ones that say which machine", () => {
  assert.equal(describeToolCall("claude", "Read", JSON.stringify({ file_path: "/Users/x/workspace/ai-coding-tool/src/renderer/styles.css" })).argument, "…/renderer/styles.css");
  assert.equal(describeToolCall("claude", "Read", JSON.stringify({ file_path: "src/renderer/styles.css" })).argument, "src/renderer/styles.css");
  assert.equal(describeToolCall("claude", "Read", JSON.stringify({ file_path: "/etc/hosts" })).argument, "/etc/hosts");
});

test("a search says where it looked, so two runs of one pattern read apart", () => {
  assert.equal(describeToolCall("claude", "Grep", JSON.stringify({ pattern: "work-row", path: "src/renderer" })).argument, "work-row in src/renderer");
  assert.equal(describeToolCall("claude", "Grep", JSON.stringify({ pattern: "work-row" })).argument, "work-row");
});

test("a command spanning lines is flattened to the one line a row can show", () => {
  const call = describeToolCall("claude", "Bash", JSON.stringify({ command: "cat <<'EOF' > f\n  one\n  two\nEOF" }));
  assert.equal(call.argument, "cat <<'EOF' > f one two EOF");
  const long = describeToolCall("claude", "Bash", JSON.stringify({ command: "x".repeat(400) }));
  assert.equal(long.argument.length, 240);
  assert.ok(long.argument.endsWith("…"));
});

test("a call carrying nothing to name falls back to no argument at all", () => {
  assert.equal(describeToolCall("claude", "Bash", "not json").argument, "");
  assert.equal(describeToolCall("claude", "ListAgents", JSON.stringify({})).argument, "");
  assert.equal(describeToolCall("claude", "Edit", JSON.stringify({ old_string: "a", new_string: "b" })).argument, "", "two candidates and no named key names neither");
});

test("a tool the list has never seen still lands in a family", () => {
  assert.equal(toolFamily("claude", "browser_click"), "web");
  assert.equal(toolFamily("claude", "mcp__aicodingtool-terminal__terminal_read"), "read");
  assert.equal(toolFamily("claude", "MultiEdit"), "write");
});

test("Codex names a call by its item kind, and by the command, path, or query it carried", () => {
  assert.deepEqual(describeToolCall("codex", "command_execution", JSON.stringify({ command: "npm test" })), { family: "shell", label: "command_execution", sigil: "$", argument: "npm test" });
  assert.equal(describeToolCall("codex", "file_change", JSON.stringify({ path: "/Users/x/repo/src/main/index.ts" })).argument, "…/main/index.ts");
  assert.equal(toolFamily("codex", "file_change"), "write");
  assert.deepEqual(describeToolCall("codex", "web_search", JSON.stringify({ query: "codex app-server" })), { family: "web", label: "web_search", argument: "codex app-server" });
  assert.equal(toolFamily("codex", "mcp_tool_call"), "other");
  assert.equal(toolFamily("codex", "browser_click"), "web");
});

test("an engine only a newer build knows has no families here, and a call reads by its common argument", () => {
  assert.equal(toolFamily("gemini" as never, "run_shell"), "other");
  assert.deepEqual(describeToolCall("gemini" as never, "run_shell", JSON.stringify({ command: "ls -la" })), { family: "other", label: "run_shell", argument: "ls -la" });
  assert.equal(describeToolCall("gemini" as never, "browser_open", JSON.stringify({ url: "https://example.com" })).family, "web", "our own tools are known whichever engine calls them");
});

test("the app's own tools read as a verb and what they acted on, whichever engine calls them", () => {
  const start = JSON.stringify({ title: "Review the refactor", prompt: "You are the reviewer…", role: "reviewer" });
  const expected = { family: "thread", label: "Start thread", verb: true, argument: "Review the refactor" };
  assert.deepEqual(describeToolCall("claude", "mcp__aicodingtool-threads__start_thread", start), expected);
  assert.deepEqual(describeToolCall("codex", "start_thread", start), expected);
  assert.deepEqual(describeToolCall("opencode", "start_thread", start), expected);
  assert.equal(describeToolCall("claude", "mcp__aicodingtool-threads__start_thread", JSON.stringify({ prompt: "Fix\nthe dock" })).argument, "Fix the dock", "an untitled thread reads by its prompt");
});

test("a call about a thread carries the thread it named, for the view to call by its title", () => {
  const id = "dedaef8d-9c0c-4f99-a08f-52122b6b5875";
  assert.deepEqual(describeToolCall("claude", "mcp__aicodingtool-threads__wait_for_thread", JSON.stringify({ threadId: id, timeoutSeconds: 900 })), { family: "thread", label: "Wait for thread", verb: true, argument: "", thread: id });
  assert.deepEqual(describeToolCall("codex", "message_thread", JSON.stringify({ threadId: id, text: "Round 4.\nFixed: all" })), { family: "thread", label: "Message thread", verb: true, argument: "Round 4. Fixed: all", thread: id });
  assert.equal(describeToolCall("claude", "mcp__aicodingtool-threads__move_to_worktree", JSON.stringify({ worktreeId: "new" })).argument, "New worktree");
  assert.equal(describeToolCall("claude", "mcp__aicodingtool-threads__move_to_worktree", JSON.stringify({ worktreeId: null })).argument, "Project checkout");
});

test("automation, terminal, and browser tools read by what they do", () => {
  assert.deepEqual(describeToolCall("claude", "mcp__aicodingtool-automation__notify", JSON.stringify({ headline: "CI is red", detail: "…", key: "ci" })), { family: "automation", label: "Notify", verb: true, argument: "CI is red" });
  assert.deepEqual(describeToolCall("claude", "mcp__aicodingtool-browser__browser_open", JSON.stringify({ url: "https://example.com", newTab: true })), { family: "web", label: "Open page", verb: true, argument: "https://example.com" });
  assert.deepEqual(describeToolCall("codex", "browser_click", JSON.stringify({ ref: "e12" })), { family: "web", label: "Click", verb: true, argument: "" });
  assert.equal(describeToolCall("claude", "mcp__aicodingtool-terminal__terminal_read", "{}").label, "Read terminal");
});

test("another server's tool keeps its own name, read as server and tool", () => {
  assert.equal(toolLabel("mcp__cua-driver__get_window_state"), "cua-driver · get window state");
  assert.equal(toolLabel("mcp__cua-driver__status"), "cua-driver · status", "a name the app's tools share is still the other server's");
  assert.equal(describeToolCall("claude", "mcp__cua-driver__status", "{}").verb, undefined);
  assert.equal(toolLabel("mcp__aicodingtool-threads__archive_thread"), "Archive thread");
  assert.equal(toolLabel("Bash"), "Bash");
});
