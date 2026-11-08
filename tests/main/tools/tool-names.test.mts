import assert from "node:assert/strict";
import { test } from "vitest";
import { AUTOMATION_TOOLS, FINDING_TOOLS } from "../../../src/main/tools/automation.mts";
import { BROWSER_SERVER_NAME, BROWSER_TOOLS } from "../../../src/main/tools/browser.mts";
import { SIMULATOR_SERVER_NAME, SIMULATOR_TOOLS } from "../../../src/main/tools/simulator.mts";
import { TERMINAL_TOOLS } from "../../../src/main/tools/terminal.mts";
import { THREAD_SERVER_NAME, THREAD_TOOLS } from "../../../src/main/tools/threads.mts";
import { readOnlyToolNames } from "../../../src/main/tools/tool-names.mts";

test("the tools a run may use without asking are the ones the definitions call read-only", () => {
  assert.deepEqual([...readOnlyToolNames(THREAD_SERVER_NAME, THREAD_TOOLS)], [
    "mcp__aicodingtool-threads__list_threads",
    "mcp__aicodingtool-threads__read_thread",
    "mcp__aicodingtool-threads__wait_for_thread",
  ]);
  assert.deepEqual([...readOnlyToolNames(BROWSER_SERVER_NAME, BROWSER_TOOLS)], [
    "mcp__aicodingtool-browser__browser_read",
    "mcp__aicodingtool-browser__browser_screenshot",
    "mcp__aicodingtool-browser__browser_console",
    "mcp__aicodingtool-browser__browser_network",
    "mcp__aicodingtool-browser__browser_wait",
    "mcp__aicodingtool-browser__browser_tabs",
  ]);
  const readOnly = (definitions: readonly { name: string; readOnly: boolean }[]) => definitions.flatMap((definition) => definition.readOnly ? [definition.name] : []);
  assert.deepEqual(readOnly(AUTOMATION_TOOLS), ["status", "list_all"]);
  assert.deepEqual(readOnly(FINDING_TOOLS), []);
  assert.deepEqual(readOnly(TERMINAL_TOOLS), ["terminal_list", "terminal_read"]);
  assert.deepEqual([...readOnlyToolNames(SIMULATOR_SERVER_NAME, SIMULATOR_TOOLS)], ["mcp__aicodingtool-simulator__simulator_read"]);
});
