import assert from "node:assert/strict";
import test from "node:test";
import { describeToolCall, toolFamily } from "../dist/main/domain/tool-call.js";

test("a call is named by its argument, and marked by what kind of argument it is", () => {
  assert.deepEqual(describeToolCall("Bash", JSON.stringify({ command: "git status --short" })), { family: "shell", sigil: "$", argument: "git status --short" });
  assert.deepEqual(describeToolCall("WebSearch", JSON.stringify({ query: "electron menu roles" })), { family: "web", argument: "electron menu roles" });
  assert.deepEqual(describeToolCall("Task", JSON.stringify({ description: "audit the reducer", prompt: "…" })), { family: "agent", argument: "audit the reducer" });
});

test("a path keeps the two segments that say which file, and drops the ones that say which machine", () => {
  assert.equal(describeToolCall("Read", JSON.stringify({ file_path: "/Users/x/workspace/claudex/src/renderer/styles.css" })).argument, "…/renderer/styles.css");
  assert.equal(describeToolCall("Read", JSON.stringify({ file_path: "src/renderer/styles.css" })).argument, "src/renderer/styles.css");
  assert.equal(describeToolCall("Read", JSON.stringify({ file_path: "/etc/hosts" })).argument, "/etc/hosts");
});

test("a search says where it looked, so two runs of one pattern read apart", () => {
  assert.equal(describeToolCall("Grep", JSON.stringify({ pattern: "work-row", path: "src/renderer" })).argument, "work-row in src/renderer");
  assert.equal(describeToolCall("Grep", JSON.stringify({ pattern: "work-row" })).argument, "work-row");
});

test("a command spanning lines is flattened to the one line a row can show", () => {
  const call = describeToolCall("Bash", JSON.stringify({ command: "cat <<'EOF' > f\n  one\n  two\nEOF" }));
  assert.equal(call.argument, "cat <<'EOF' > f one two EOF");
  const long = describeToolCall("Bash", JSON.stringify({ command: "x".repeat(400) }));
  assert.equal(long.argument.length, 240);
  assert.ok(long.argument.endsWith("…"));
});

test("a call carrying nothing to name falls back to no argument at all", () => {
  assert.equal(describeToolCall("Bash", "not json").argument, "");
  assert.equal(describeToolCall("ListAgents", JSON.stringify({})).argument, "");
  assert.equal(describeToolCall("Edit", JSON.stringify({ old_string: "a", new_string: "b" })).argument, "", "two candidates and no named key names neither");
});

test("a tool the list has never seen still lands in a family", () => {
  assert.equal(toolFamily("browser_click"), "web");
  assert.equal(toolFamily("mcp__aicodingtool-terminal__terminal_read"), "other");
  assert.equal(toolFamily("MultiEdit"), "write");
});
