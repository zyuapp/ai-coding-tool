import assert from "node:assert/strict";
import { test } from "vitest";
import { claudeMcpServer, readOnlyToolNames } from "../../../src/main/agent/claude-mcp-host.mts";
import { AUTOMATION_TOOLS, FINDING_TOOLS } from "../../../src/main/tools/automation.mts";
import { BROWSER_SERVER_NAME, BROWSER_TOOLS, browserTools } from "../../../src/main/tools/browser.mts";
import { TERMINAL_TOOLS } from "../../../src/main/tools/terminal.mts";
import { THREAD_SERVER_NAME, THREAD_TOOLS } from "../../../src/main/tools/threads.mts";
import type { BrowserBridge } from "../../../src/main/agent/agent-provider.mts";

test("the tools Claude may use without asking are the ones the definitions call read-only", () => {
  assert.deepEqual([...readOnlyToolNames(THREAD_SERVER_NAME, THREAD_TOOLS)], [
    "mcp__aicodingtool-threads__list_threads",
    "mcp__aicodingtool-threads__read_thread",
    "mcp__aicodingtool-threads__wait_for_thread",
  ]);
  assert.deepEqual([...readOnlyToolNames(BROWSER_SERVER_NAME, BROWSER_TOOLS)], [
    "mcp__aicodingtool-browser__browser_read",
    "mcp__aicodingtool-browser__browser_tabs",
  ]);
  const readOnly = (definitions: readonly { name: string; readOnly: boolean }[]) => definitions.flatMap((definition) => definition.readOnly ? [definition.name] : []);
  assert.deepEqual(readOnly(AUTOMATION_TOOLS), ["status", "list_all"]);
  assert.deepEqual(readOnly(FINDING_TOOLS), []);
  assert.deepEqual(readOnly(TERMINAL_TOOLS), ["terminal_list", "terminal_read"]);
});

test("a hosted server keeps every tool under the server name it was given", () => {
  const bridge = { command: async () => {}, read: async () => ({ kind: "tabs" as const, tabs: [] }) } satisfies BrowserBridge;
  const server = claudeMcpServer(BROWSER_SERVER_NAME, browserTools(bridge));
  assert.equal(server.type, "sdk");
  assert.equal(server.name, BROWSER_SERVER_NAME);
});
