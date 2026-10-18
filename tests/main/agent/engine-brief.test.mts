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
const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) } as unknown as CoordinationBridge;
const browser: BrowserBridge = { command: async () => {}, read: async () => ({ kind: "tabs", tabs: [] }) };
const terminal = { read: async () => ({}) } as unknown as TerminalBridge;
const cua = { command: "/app/cua-driver", args: ["mcp", "--embedded"], env: {} };

type Settings = Partial<ProviderRunInput>;

/** What one engine's run was told and offered: its instructions, its tools by bare name, with bundled computer use as `cua-driver`, and what each app tool says of itself. */
type Brief = { instructions: string; tools: string[]; descriptions: Record<string, string | undefined> };

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
  const descriptions: Record<string, string | undefined> = {};
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
      if (disallowed.has(`mcp__${server}__${tool.name}`)) continue;
      tools.push(tool.name);
      descriptions[tool.name] = tool.description;
    }
  }
  return { instructions: prompt.append ?? "", tools: tools.sort(), descriptions };
}

async function codexBrief(settings: Settings): Promise<Brief> {
  const codex = harness();
  const { client } = await codexTurn(codex, settings);
  codex.provider.closeAll();
  const started = client.calls("thread/start")[0] as { developerInstructions: string };
  const served = codex.host.served[0]?.tools ?? [];
  const tools = served.map((tool) => tool.name);
  if (client.command.args.some((arg) => arg.startsWith("mcp_servers.cua-driver.command="))) tools.push("cua-driver");
  return { instructions: started.developerInstructions, tools: tools.sort(), descriptions: Object.fromEntries(served.map((tool) => [tool.name, tool.description])) };
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
  { name: "worktrees", on: { threads }, told: /When the user asks for work in a worktree, use the AICodingTool worktree tools/, offered: "move_to_worktree" },
  { name: "coordinator", on: { coordinationRole: "coordinator", coordination }, told: /You are a coordinator/, offered: "raise_decision" },
  { name: "coordinated member", on: { coordinationRole: "member", coordination }, told: /Before you end the turn in which you finish your brief, get blocked, or fail, call report_status as done, blocked, or failed: your closing message is not a report\./, offered: "report_status" },
  { name: "a coordinator hearing a thread end its turn without reporting", on: { coordinationRole: "coordinator", coordination }, told: /A thread that ends its turn without reporting tells you where it stands only in its last reply/ },
  { name: "coordinator memory", on: { coordinationRole: "coordinator", coordination }, told: /Your memory holds/, offered: "remember" },
  { name: "suggested threads", on: { coordinationRole: "coordinator", coordination }, told: /call propose_threads/, offered: "propose_threads" },
  { name: "a member that cannot reach something", on: { coordinationRole: "member", coordination }, told: /say exactly what's missing and stop\. Don't substitute, mock, or guess\. Say it with report_status as blocked\./ },
  { name: "a member in a checkout of its own", on: { coordinationRole: "member", coordination, workspaceRoot: "/worktrees/repo-1", projectRoot: "/repo" }, told: /You work in your own checkout, \/worktrees\/repo-1\. The project's main checkout, \/repo, is the user's: never change anything there\./ },
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
        if (feature.offered !== "cua-driver") assert.ok(on[engine].descriptions[feature.offered], `${engine} reads what ${feature.offered} is for`);
      }
    }
    assert.deepEqual(on.claude.tools, on.codex.tools, "both engines are offered the same tools");
    assert.deepEqual(on.claude.descriptions, on.codex.descriptions, "and each says the same of itself to both");
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
  assert.match(claude.instructions, /with git worktree or the Agent tool's worktree isolation\./);
  assert.match(codex.instructions, /with git worktree\./);
  const neutral = (text: string) => text.replace(/App task IDs identify AICodingTool threads, not [^.]*\./, "").replace(" or the Agent tool's worktree isolation", "");
  assert.equal(neutral(claude.instructions), neutral(codex.instructions));
});

test("a coordinator on either engine reads the browser panel but is never offered a tool that drives it, nor told to", async () => {
  const lead = await briefs({ browser, terminal, coordinationRole: "coordinator", coordination });
  const member = await briefs({ browser, coordinationRole: "member", coordination });
  const panel = (brief: Brief) => brief.tools.filter((tool) => tool.startsWith("browser_"));
  for (const engine of ["claude", "codex"] as const) {
    assert.deepEqual(panel(lead[engine]), ["browser_console", "browser_network", "browser_read", "browser_screenshot", "browser_tabs", "browser_wait"]);
    assert.ok(lead[engine].tools.includes("terminal_read"), "what the user's terminals printed is reading too");
    assert.match(lead[engine].instructions, /read the pages they have open there with browser_tabs/);
    assert.doesNotMatch(lead[engine].instructions, /browser_open/);
    assert.ok(panel(member[engine]).includes("browser_click"), "a thread under a coordinator does the work, so it drives the panel");
  }
  assert.deepEqual(lead.claude.tools, lead.codex.tools);
});

test("a coordinator on either engine is told how it reads with the tools it really has, and that it changes nothing", async () => {
  const { claude, codex } = await briefs({ coordinationRole: "coordinator", coordination });
  for (const brief of [claude, codex]) assert.match(brief.instructions, /Never change anything yourself, however small\./);
  assert.match(claude.instructions, /Your own tools read and search; none edits files or runs shell commands\./, "Claude's coordinator has no shell");
  assert.match(codex.instructions, /Your shell is read-only: use it to read and search/, "Codex's coordinator reads through its read-only shell");
  assert.doesNotMatch(codex.instructions, /shell commands are not available|runs shell commands/, "Codex's coordinator is never told it has no shell");
  assert.doesNotMatch(claude.instructions, /Your shell/, "Claude's coordinator is never told of a shell it lacks");
});

test("a coordinator is told to keep its project's folder out of what a worktree thread is sent, and a member in its project's checkout is told of no other", async () => {
  const lead = await briefs({ coordinationRole: "coordinator", coordination });
  const member = await briefs({ coordinationRole: "member", coordination });
  for (const engine of ["claude", "codex"] as const) {
    assert.match(lead[engine].instructions, /never point it at this project's folder by path in its prompt or doneWhen/);
    assert.doesNotMatch(member[engine].instructions, /main checkout/);
  }
});

test("a Codex member in a checkout of its own is told its commits run outside its sandbox, and a Claude one, which has none, is not", async () => {
  const own = await briefs({ coordinationRole: "member", coordination, workspaceRoot: "/worktrees/repo-1", projectRoot: "/repo" });
  const shared = await briefs({ coordinationRole: "member", coordination });
  const lead = await briefs({ coordinationRole: "coordinator", coordination });
  const outside = /If your sandbox keeps a git command such as git add or git commit from writing the git data .*, ask to run it outside the sandbox, and report blocked only if that is refused\./;
  assert.match(own.codex.instructions, outside);
  assert.doesNotMatch(own.claude.instructions, outside);
  for (const brief of [shared.codex, lead.codex]) assert.doesNotMatch(brief.instructions, outside, "only a member working apart from the project's checkout is told");
  assert.match(lead.codex.instructions, /never ask to run a command outside its sandbox/);
});

test("a side chat, which cannot move its thread, is only told to start a thread in a worktree", async () => {
  const main = await briefs({ threads });
  const side = await briefs({ threads, channel: "side" });
  for (const engine of ["claude", "codex"] as const) {
    assert.match(main[engine].instructions, /To do the work in this thread, call move_to_worktree with "new"/);
    assert.doesNotMatch(side[engine].instructions, /move_to_worktree/);
    assert.match(side[engine].instructions, /Start a thread with start_thread and worktree to do it\./);
  }
});

test("a coordinator on either engine, which does no work itself, is never offered a move into a worktree nor told to make one, only to start a thread in one", async () => {
  const { claude, codex } = await briefs({ threads, coordinationRole: "coordinator", coordination });
  for (const brief of [claude, codex]) {
    assert.ok(!brief.tools.includes("move_to_worktree"));
    assert.ok(brief.tools.includes("delete_worktree"), "it can still clear away a worktree once the user asks");
    assert.doesNotMatch(brief.instructions, /move_to_worktree/);
    assert.match(brief.instructions, /Start a thread with start_thread and worktree to do it\./);
    assert.match(brief.instructions, /Never merge, discard work, or do anything destructive or irreversible without the user's explicit word/);
  }
  assert.deepEqual(claude.tools, codex.tools);
});

/** Settings that change what a run is told or offered, each of which a warm session cannot take on. */
const briefChanges: [string, Settings][] = [
  ["automations", { automations }],
  ["findings", { automations, findings }],
  ["threads", { threads }],
  ["coordination", { coordinationRole: "member", coordination }],
  ["the project checkout a member keeps out of", { coordinationRole: "member", coordination, projectRoot: "/repo" }],
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
