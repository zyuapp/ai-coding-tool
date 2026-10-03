import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import type { AutomationBridge, BrowserBridge, CoordinationBridge, FindingBridge, ProviderRunInput, TerminalBridge, ThreadBridge } from "../../../src/main/agent/agent-provider.mts";
import { input as claudeInput, liveQueryFactory, queryFactory, turn as claudeTurn, type LiveQueryCapture, type QueryCapture } from "../../support/claude-session.mjs";
import { harness, turn as codexTurn } from "../../support/codex-client.mjs";

const automations = { list: async () => [], read: async () => null, save: async () => ({}), update: async () => ({}), remove: async () => true } as unknown as AutomationBridge;
const findings = { notify: async () => ({}), nothingToReport: async () => ({}) } as unknown as FindingBridge;
const threads = { list: async () => [], read: async () => null, wait: async () => ({}), command: async () => ({}) } as unknown as ThreadBridge;
const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }) } as unknown as CoordinationBridge;
const browser: BrowserBridge = { command: async () => {}, read: async () => ({ kind: "tabs", tabs: [] }) };
const terminal = { read: async () => ({}) } as unknown as TerminalBridge;
const cua = { command: "/app/cua-driver", args: ["mcp", "--embedded"], env: {} };

type Settings = Partial<ProviderRunInput>;

/** What one engine's run was told and offered: its instructions, and its tools by bare name, with bundled computer use as `cua-driver`. */
type Brief = { instructions: string; tools: string[] };

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
});

async function claudeBrief(settings: Settings): Promise<Brief> {
  const capture: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(claudeInput(settings));
  const options = capture.options?.options;
  assert.ok(options);
  const prompt = options.systemPrompt;
  assert.ok(prompt && typeof prompt === "object" && !Array.isArray(prompt) && "append" in prompt);
  const disallowed = new Set(options.disallowedTools ?? []);
  const tools: string[] = [];
  for (const [server, config] of Object.entries(options.mcpServers ?? {})) {
    if (config.type !== "sdk") {
      tools.push(server);
      continue;
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (config.instance as McpServer).connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    clients.push(client);
    await client.connect(clientSide);
    for (const tool of (await client.listTools()).tools) {
      if (!disallowed.has(`mcp__${server}__${tool.name}`)) tools.push(tool.name);
    }
  }
  return { instructions: prompt.append ?? "", tools: tools.sort() };
}

async function codexBrief(settings: Settings): Promise<Brief> {
  const codex = harness();
  const { client } = await codexTurn(codex, settings);
  codex.provider.closeAll();
  const started = client.calls("thread/start")[0] as { developerInstructions: string };
  const tools = (codex.host.served[0]?.tools ?? []).map((tool) => tool.name);
  if (client.command.args.some((arg) => arg.startsWith("mcp_servers.cua-driver.command="))) tools.push("cua-driver");
  return { instructions: started.developerInstructions, tools: tools.sort() };
}

async function briefs(settings: Settings) {
  return { claude: await claudeBrief(settings), codex: await codexBrief(settings) };
}

/** A setting the user can turn on, what both engines must then be told, and the tool both must then be offered. */
const features: { name: string; on: Settings; told?: RegExp; offered?: string }[] = [
  { name: "computer use", on: { computerUse: { status: "available", mcp: cua } }, told: /Never invoke a separately installed cua-driver through Bash/, offered: "cua-driver" },
  { name: "computer use setup", on: { computerUse: { status: "setup-required" } }, told: /Observe the exact target before every action/, offered: "request_setup" },
  { name: "automations", on: { automations }, told: /This task can schedule itself/, offered: "schedule" },
  { name: "findings", on: { automations, findings }, offered: "notify" },
  { name: "threads", on: { threads }, told: /App task IDs identify AICodingTool threads/, offered: "start_thread" },
  { name: "coordinator", on: { coordinationRole: "coordinator", coordination }, told: /You are a coordinator/, offered: "raise_decision" },
  { name: "coordinated member", on: { coordinationRole: "member", coordination }, told: /Call report_status/, offered: "report_status" },
  { name: "browser panel", on: { browser }, told: /browser panel is a real browser/, offered: "browser_open" },
  { name: "terminal panel", on: { terminal }, told: /terminal_list and terminal_read/, offered: "terminal_read" },
  { name: "side chat", on: { channel: "side" }, told: /You are in an AICodingTool side chat/ },
];

for (const feature of features) {
  test(`${feature.name} reaches Claude and GPT runs alike`, async () => {
    const off = await briefs({});
    const on = await briefs(feature.on);
    for (const engine of ["claude", "codex"] as const) {
      if (feature.told) {
        assert.match(on[engine].instructions, feature.told, `${engine} is told when it is on`);
        assert.doesNotMatch(off[engine].instructions, feature.told, `${engine} is not told when it is off`);
      }
      if (feature.offered) {
        assert.ok(on[engine].tools.includes(feature.offered), `${engine} is offered ${feature.offered} when it is on`);
        assert.ok(!off[engine].tools.includes(feature.offered), `${engine} is not offered ${feature.offered} when it is off`);
      }
    }
    assert.deepEqual(on.claude.tools, on.codex.tools, "both engines are offered the same tools");
  });
}

test("every run, on either engine, is told how to link a thread", async () => {
  const { claude, codex } = await briefs({});
  for (const brief of [claude, codex]) assert.match(brief.instructions, /\[title\]\(aicodingtool:\/\/thread\/<id>\)/);
});

test("a run is never told to schedule where it cannot", async () => {
  for (const settings of [{ automations, channel: "side" }, { automations, coordinationRole: "coordinator", coordination }] satisfies Settings[]) {
    const { claude, codex } = await briefs(settings);
    for (const brief of [claude, codex]) {
      assert.ok(!brief.tools.includes("schedule"));
      assert.doesNotMatch(brief.instructions, /This task can schedule itself/);
    }
  }
});

test("both engines are told the same thing in the same order, short of naming their own sessions", async () => {
  const { claude, codex } = await briefs({ automations, findings, threads, browser, terminal, computerUse: { status: "setup-required" }, coordinationRole: "member", coordination, channel: "side" });
  assert.match(claude.instructions, /not Claude background tasks, sessions, or agents/);
  assert.match(codex.instructions, /not Codex sessions or subagents/);
  const neutral = (text: string) => text.replace(/App task IDs identify AICodingTool threads, not [^.]*\./, "");
  assert.equal(neutral(claude.instructions), neutral(codex.instructions));
});

/** Settings that change what a run is told or offered, each of which a warm session cannot take on. */
const briefChanges: [string, Settings][] = [
  ["automations", { automations }],
  ["findings", { automations, findings }],
  ["threads", { threads }],
  ["coordination", { coordinationRole: "member", coordination }],
  ["browser panel", { browser }],
  ["terminal panel", { terminal }],
  ["computer use", { computerUse: { status: "setup-required" } }],
];

for (const [name, change] of briefChanges) {
  test(`turning ${name} on opens a new session on Claude and GPT alike`, async () => {
    const capture: LiveQueryCapture = { opens: 0, sent: [] };
    const claude = new ClaudeAgentProvider(liveQueryFactory(capture));
    const continuation = { provider: "claude", value: "session-1" } as const;
    await claudeTurn(capture, claude.execute(claudeInput()), { type: "system", subtype: "init", session_id: "session-1" });
    await claudeTurn(capture, claude.execute(claudeInput({ continuation })));
    assert.equal(capture.opens, 1, "Claude keeps its session while nothing changes");
    await claudeTurn(capture, claude.execute(claudeInput({ ...change, continuation })));
    assert.equal(capture.opens, 2, "Claude opens a new session");
    claude.closeAll();

    const codex = harness();
    await codexTurn(codex);
    await codexTurn(codex, { continuation: { provider: "codex", value: "thread-1" } });
    assert.equal(codex.clients.length, 1, "Codex keeps its session while nothing changes");
    await codexTurn(codex, { ...change, continuation: { provider: "codex", value: "thread-1" } });
    assert.equal(codex.clients.length, 2, "Codex opens a new session");
    codex.provider.closeAll();
  });
}
