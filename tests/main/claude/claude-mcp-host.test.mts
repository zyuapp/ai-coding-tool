import assert from "node:assert/strict";
import { test } from "vitest";
import { claudeMcpServer } from "../../../src/main/claude/claude-mcp-host.mts";
import { BROWSER_SERVER_NAME, browserTools, type BrowserBridge } from "../../../src/main/tools/browser.mts";

test("a hosted server keeps every tool under the server name it was given", () => {
  const bridge = { command: async () => {}, read: async () => ({ kind: "tabs" as const, tabs: [] }) } satisfies BrowserBridge;
  const server = claudeMcpServer(BROWSER_SERVER_NAME, browserTools(bridge));
  assert.equal(server.type, "sdk");
  assert.equal(server.name, BROWSER_SERVER_NAME);
});
