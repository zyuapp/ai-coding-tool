import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import type { AutomationBridge, BrowserBridge, FindingBridge, ProviderEvent, ProviderRunInput, TerminalBridge, ThreadBridge } from "../../../src/main/agent/agent-provider.mts";
import { runTools } from "../../../src/main/agent/run-tools.mts";
import { browserTools } from "../../../src/main/tools/browser.mts";
import { terminalTools } from "../../../src/main/tools/terminal.mts";
import { McpHttpHost } from "../../../src/main/tools/mcp-http-host.mts";
import { input, queryFactory, type QueryCapture } from "../../support/claude-session.mjs";

const hosts: McpHttpHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close();
});

function host() {
  const opened = new McpHttpHost();
  hosts.push(opened);
  return opened;
}

async function connect(url: string, token: string) {
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

const refused = (error: unknown) => error instanceof StreamableHTTPError && error.code === 401;

async function names(client: Client) {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

const browser: BrowserBridge = { command: async () => {}, read: async () => ({ kind: "tabs", tabs: [] }) };
const terminal = { read: async () => ({}) } as unknown as TerminalBridge;

test("a token reaches the tools it was served, and nothing reaches the host without one", async () => {
  const served = await host().serve(browserTools(browser));
  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

  const client = await connect(served.url, served.token);
  assert.deepEqual(await names(client), ["browser_back", "browser_click", "browser_close_tab", "browser_console", "browser_network", "browser_open", "browser_read", "browser_screenshot", "browser_search", "browser_tabs", "browser_type", "browser_wait"]);
  const result = await client.callTool({ name: "browser_tabs", arguments: {} });
  assert.deepEqual(result.content, [{ type: "text", text: "The browser panel has no tab open." }]);

  await assert.rejects(connect(served.url, "not-a-token"), refused);
  await assert.rejects(connect(served.url, ""), refused);
});

test("a released token is refused, while other tokens on the same host go on", async () => {
  const shared = host();
  const first = await shared.serve(browserTools(browser));
  const second = await shared.serve(terminalTools(terminal));
  assert.equal(first.url, second.url, "one listener serves every set");
  assert.notEqual(first.token, second.token);

  const client = await connect(first.url, first.token);
  first.release();
  await assert.rejects(client.listTools(), refused, "an open session dies with its token");
  await assert.rejects(connect(first.url, first.token), refused);
  assert.deepEqual(await names(await connect(second.url, second.token)), ["terminal_list", "terminal_read"]);
});

const automations = { list: async () => [], read: async () => null, save: async () => ({}), update: async () => ({}), remove: async () => true } as unknown as AutomationBridge;
const findings = { notify: async () => ({}), nothingToReport: async () => ({}) } as unknown as FindingBridge;
const threads = { list: async () => [], read: async () => null, wait: async () => ({}), command: async () => ({}) } as unknown as ThreadBridge;

/** The tools Claude would be offered for a run, by bare name, once its disallow list is applied. */
async function claudeToolNames(run: ProviderRunInput) {
  const capture: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(run);
  const options = capture.options?.options;
  assert.ok(options);
  const disallowed = new Set(options.disallowedTools ?? []);
  const offered: string[] = [];
  for (const [server, config] of Object.entries(options.mcpServers ?? {})) {
    if (config.type !== "sdk") continue;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (config.instance as McpServer).connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    clients.push(client);
    await client.connect(clientSide);
    for (const tool of (await client.listTools()).tools) {
      if (!disallowed.has(`mcp__${server}__${tool.name}`)) offered.push(tool.name);
    }
  }
  return offered.sort();
}

test("a run's tool set over HTTP is the set Claude's host builds for the same run", async () => {
  const bridges = { automations, findings, threads, browser, terminal };
  for (const overrides of [
    { ...bridges, channel: "main" as const },
    { ...bridges, channel: "side" as const },
    { ...bridges, channel: "main" as const, computerUse: { status: "setup-required" as const } },
    { threads, browser, channel: "main" as const },
  ]) {
    const run = input(overrides);
    const served = await host().serve(runTools(run).flatMap((set) => set.tools));
    const expected = await claudeToolNames(run);
    assert.deepEqual(await names(await connect(served.url, served.token)), expected, JSON.stringify(Object.keys(overrides)));
    if (overrides.channel === "side") assert.ok(!expected.includes("schedule") && expected.includes("status"), "the comparison covers what a side chat is short of");
  }
});

test("the setup tool served to Codex asks the app to open computer-use settings", async () => {
  const emitted: ProviderEvent[] = [];
  const served = await host().serve(runTools(input({ computerUse: { status: "setup-required" }, emit: (event) => emitted.push(event) })).flatMap((set) => set.tools));
  const client = await connect(served.url, served.token);
  assert.deepEqual(await names(client), ["request_setup"]);
  const result = await client.callTool({ name: "request_setup", arguments: {} });
  assert.deepEqual(emitted, [{ type: "computer-use.setup-required" }]);
  assert.match(JSON.stringify(result.content), /Settings → Computer use/);
});
