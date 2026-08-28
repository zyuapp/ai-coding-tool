import assert from "node:assert/strict";
import { expectTypeOf, test } from "vitest";
import type { AgentEngine } from "../../src/domain/agent-engine.ts";
import { describeToolCall, toolFamily } from "../../src/domain/tool-call.ts";

test("a call is named by its argument, and marked by what kind of argument it is", () => {
  assert.deepEqual(describeToolCall("claude", "Bash", JSON.stringify({ command: "git status --short" })), { family: "shell", sigil: "$", argument: "git status --short" });
  assert.deepEqual(describeToolCall("claude", "WebSearch", JSON.stringify({ query: "electron menu roles" })), { family: "web", argument: "electron menu roles" });
  assert.deepEqual(describeToolCall("claude", "Task", JSON.stringify({ description: "audit the reducer", prompt: "…" })), { family: "agent", argument: "audit the reducer" });
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
  assert.equal(toolFamily("claude", "mcp__aicodingtool-terminal__terminal_read"), "other");
  assert.equal(toolFamily("claude", "MultiEdit"), "write");
});

test("Codex names a call by its item kind, and by the command, path, or query it carried", () => {
  assert.deepEqual(describeToolCall("codex", "command_execution", JSON.stringify({ command: "npm test" })), { family: "shell", sigil: "$", argument: "npm test" });
  assert.equal(describeToolCall("codex", "file_change", JSON.stringify({ path: "/Users/x/repo/src/main/index.ts" })).argument, "…/main/index.ts");
  assert.equal(toolFamily("codex", "file_change"), "write");
  assert.deepEqual(describeToolCall("codex", "web_search", JSON.stringify({ query: "codex app-server" })), { family: "web", argument: "codex app-server" });
  assert.equal(toolFamily("codex", "mcp_tool_call"), "other");
  assert.equal(toolFamily("codex", "todo_list"), "other");
  assert.equal(toolFamily("codex", "browser_click"), "web");
});

test("only an engine the catalogue knows can name a tool", () => {
  expectTypeOf(toolFamily).parameter(0).toEqualTypeOf<AgentEngine>();
  expectTypeOf(describeToolCall).parameter(0).toEqualTypeOf<AgentEngine>();
});
