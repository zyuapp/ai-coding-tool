import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolIntent } from "../../../src/domain/run.ts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, harness, input, opened, sentBy, tick, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";
const turnId = "turn-1";
const at = { threadId, turnId };

function started(item: ThreadItem) {
  return { item, threadId, turnId, startedAtMs: 1 };
}

function completed(item: ThreadItem) {
  return { item, threadId, turnId, completedAtMs: 2 };
}

const command = (id: string, command: string): Extract<ThreadItem, { type: "commandExecution" }> => ({
  type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd: "/tmp/project", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
});

const fileChange = (id: string, ...paths: string[]): ThreadItem => ({
  type: "fileChange", id, status: "inProgress", changes: paths.map((path) => ({ path, kind: { type: "update", move_path: null }, diff: `--- ${path}\n+++ ${path}\n` })),
});

const mcpCall = (id: string, server: string, tool: string, args: unknown): ThreadItem => ({
  type: "mcpToolCall", id, server, tool, status: "inProgress", arguments: args as never, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
});

/** The prompt Codex sends before an MCP tool runs, as captured from the real app server. */
function elicitation(server: string, tool: string, params: Record<string, string>) {
  return {
    threadId, turnId, serverName: server, mode: "form" as const,
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Append text.", tool_params: params, tool_params_display: [] },
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: "object" as const, properties: {} },
  };
}

async function asking(overrides: Partial<Parameters<typeof input>[0]> = {}) {
  const asked: ToolIntent[] = [];
  const codex = harness();
  const running = codex.provider.execute(input({ authorize: async (intent) => { asked.push(intent); return overrides.authorize ? overrides.authorize(intent) : "allow"; }, ...overrides, ...(overrides.authorize ? { authorize: async (intent: ToolIntent) => { asked.push(intent); return overrides.authorize!(intent); } } : {}) }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  return { codex, client, asked, end: async () => { completeTurn(client); const result = await running; codex.provider.closeAll(); return result; } };
}

test("a command approval asks the run's user and accepts or declines on their word, never cancelling the turn", async () => {
  const allowed = await asking();
  allowed.client.notify("item/started", started(command("cmd-1", "npm test")));
  const accepted = await allowed.client.ask("item/commandExecution/requestApproval", { kind: "command", ...at, itemId: "cmd-1", startedAtMs: 1, environmentId: null, command: "npm test", cwd: "/tmp/project", reason: "The sandbox blocked it." });
  assert.deepEqual(accepted, { result: { decision: "accept" } });
  assert.deepEqual(allowed.asked, [{ toolId: "cmd-1", name: "command_execution", input: { command: "npm test", cwd: "/tmp/project", reason: "The sandbox blocked it." } }]);
  await allowed.end();

  const denied = await asking({ authorize: async () => "deny" });
  const declined = await denied.client.ask("item/commandExecution/requestApproval", { kind: "command", ...at, itemId: "cmd-2", startedAtMs: 1, environmentId: null, command: "rm -rf build", cwd: "/tmp/project" });
  assert.deepEqual(declined, { result: { decision: "decline" } });
  assert.deepEqual(denied.asked.map((intent) => intent.input), [{ command: "rm -rf build", cwd: "/tmp/project" }]);
  await denied.end();
});

test("a denial that says why is declined on the wire and its reason steered into the turn, while a plain one says nothing more", async () => {
  const reason = "Nobody is watching this scheduled run.";
  const explained = await asking({ authorize: async () => ({ deny: reason }) });
  const declined = await explained.client.ask("item/commandExecution/requestApproval", { kind: "command", ...at, itemId: "cmd-3", startedAtMs: 1, environmentId: null, command: "rm -rf build", cwd: "/tmp/project" });
  assert.deepEqual(declined, { result: { decision: "decline" } });
  await sentBy(explained.client, "turn/steer");
  assert.deepEqual(explained.client.calls("turn/steer"), [{ threadId, input: [{ type: "text", text: reason, text_elements: [] }], expectedTurnId: turnId }]);
  await explained.end();

  const plain = await asking({ authorize: async () => "deny" });
  await plain.client.ask("item/fileChange/requestApproval", { ...at, itemId: "patch-2", startedAtMs: 1 });
  await tick();
  assert.deepEqual(plain.client.calls("turn/steer"), []);
  await plain.end();
});

test("a bypass run accepts an unexpected approval request without asking the user", async () => {
  const session = await asking({ policy: "bypass", authorize: async () => "deny" });
  const accepted = await session.client.ask("item/commandExecution/requestApproval", { kind: "command", ...at, itemId: "cmd-bypass", startedAtMs: 1, environmentId: null, command: "npm test", cwd: "/tmp/project" });

  assert.deepEqual(accepted, { result: { decision: "accept" } });
  assert.deepEqual(session.asked, []);
  await session.end();
});

test("a file change approval is described by the patch the agent already started, and read as a write to its first path", async () => {
  const session = await asking({ authorize: async (intent) => intent.writePath === "/tmp/project/src/app.ts" ? "allow" : "deny" });
  session.client.notify("item/started", started(fileChange("patch-1", "/tmp/project/src/app.ts")));
  const reply = await session.client.ask("item/fileChange/requestApproval", { ...at, itemId: "patch-1", startedAtMs: 1, reason: "Outside the sandbox." });
  assert.deepEqual(reply, { result: { decision: "accept" } });
  assert.equal(session.asked[0].writePath, "/tmp/project/src/app.ts");
  assert.deepEqual(session.asked[0].input, { path: "/tmp/project/src/app.ts", changes: [{ path: "/tmp/project/src/app.ts", kind: "update", diff: "--- /tmp/project/src/app.ts\n+++ /tmp/project/src/app.ts\n" }], reason: "Outside the sandbox." });

  const unknown = await session.client.ask("item/fileChange/requestApproval", { ...at, itemId: "patch-unseen", startedAtMs: 1 });
  assert.deepEqual(unknown, { result: { decision: "decline" } }, "a patch the session never saw carries no path, so the write is not vouched for");
  await session.end();
});

test("an MCP tool prompt is the call the agent has going against that server, and is answered accept or decline", async () => {
  const allowed = await asking();
  allowed.client.notify("item/started", started(mcpCall("mcp-1", "probe", "probe_write", { text: "hello" })));
  const accepted = await allowed.client.ask("mcpServer/elicitation/request", elicitation("probe", "probe_write", { text: "hello" }));
  assert.deepEqual(accepted, { result: { action: "accept", content: {}, _meta: null } });
  assert.deepEqual(allowed.asked, [{ toolId: "mcp-1", name: "probe_write", input: { text: "hello" } }]);
  allowed.client.notify("item/completed", completed({ ...mcpCall("mcp-1", "probe", "probe_write", { text: "hello" }), status: "completed" } as ThreadItem));

  const unseen = await allowed.client.ask("mcpServer/elicitation/request", elicitation("probe", "probe_read", {}));
  assert.deepEqual(unseen, { result: { action: "accept", content: {}, _meta: null } });
  assert.deepEqual(allowed.asked[1], { toolId: "probe:1", name: "probe_read", input: {} }, "a prompt with no call in flight is named by its wording");

  const form = await allowed.client.ask("mcpServer/elicitation/request", { threadId, turnId, serverName: "probe", mode: "form", _meta: null, message: "Which region?", requestedSchema: { type: "object", properties: {} } });
  assert.deepEqual(form, { result: { action: "decline", content: null, _meta: null } }, "a form nobody here can fill is declined without asking");
  assert.equal(allowed.asked.length, 2);
  await allowed.end();

  const denied = await asking({ authorize: async () => "deny" });
  denied.client.notify("item/started", started(mcpCall("mcp-2", "probe", "probe_write", { text: "no" })));
  const declined = await denied.client.ask("mcpServer/elicitation/request", elicitation("probe", "probe_write", { text: "no" }));
  assert.deepEqual(declined, { result: { action: "decline", content: null, _meta: null } });
  await denied.end();
});

test("MCP approval correlation stays inside the requesting root or child thread", async () => {
  const session = await asking();
  session.client.notify("item/started", started(mcpCall("mcp-root", "probe", "root_probe", { owner: "root" })));
  session.client.notify("item/started", started({ type: "subAgentActivity", id: "discover-child", kind: "started", agentThreadId: "child-a", agentPath: "/root/reviewer", model: null, reasoningEffort: null }));
  session.client.notify("item/started", {
    threadId: "child-a",
    turnId: "child-turn",
    startedAtMs: 1,
    item: mcpCall("mcp-child", "probe", "child_probe", { owner: "child" }),
  });

  await session.client.ask("mcpServer/elicitation/request", { ...elicitation("probe", "child_probe", { owner: "child" }), threadId: "child-a", turnId: "child-turn" });
  await session.client.ask("mcpServer/elicitation/request", elicitation("probe", "root_probe", { owner: "root" }));

  assert.deepEqual(session.asked, [
    { toolId: "mcp-child", name: "child_probe", input: { owner: "child" } },
    { toolId: "mcp-root", name: "root_probe", input: { owner: "root" } },
  ]);
  await session.end();
});

test("permissions use approvals and questions return typed answers", async () => {
  const allowed = await asking({ askQuestion: async () => ({ q1: "Chicago" }) });
  const permissions = { network: { enabled: true }, fileSystem: null } as never;
  const granted = await allowed.client.ask("item/permissions/requestApproval", { ...at, itemId: "perm-1", environmentId: null, startedAtMs: 1, cwd: "/tmp/project", reason: "npm install", permissions });
  assert.deepEqual(granted, { result: { permissions: { network: { enabled: true } }, scope: "turn" } });
  assert.deepEqual(allowed.asked[0], { toolId: "perm-1", name: "permissions", input: { cwd: "/tmp/project", reason: "npm install", permissions } });
  const answered = await allowed.client.ask("item/tool/requestUserInput", { ...at, itemId: "ask-1", questions: [{ id: "q1", header: "Region", question: "Which region?", isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null });
  assert.deepEqual(answered, { result: { answers: { q1: { answers: ["Chicago"] } } } });
  await allowed.end();

  const denied = await asking({ authorize: async () => "deny" });
  const refused = await denied.client.ask("item/permissions/requestApproval", { ...at, itemId: "perm-2", environmentId: null, startedAtMs: 1, cwd: "/tmp/project", reason: null, permissions });
  assert.deepEqual(refused, { result: { permissions: {}, scope: "turn" } });
  const declined = await denied.client.ask("item/tool/requestUserInput", { ...at, itemId: "ask-2", questions: [], isBlocking: true, autoResolutionMs: null });
  assert.equal("error" in declined, true);
  await denied.end();
});

test("a question with no run to ask is declined, and one the session cannot answer is refused", async () => {
  const codex = harness();
  const { client } = await turn(codex);
  const reply = await client.ask("item/commandExecution/requestApproval", { kind: "command", ...at, itemId: "late", startedAtMs: 1, environmentId: null, command: "ls" });
  assert.deepEqual(reply, { result: { decision: "decline" } });
  const unsupported = await client.ask("item/tool/call", { ...at, callId: "dyn-1", namespace: null, tool: "custom", arguments: {} });
  assert.equal("error" in unsupported && unsupported.error.code, -32601);
  codex.provider.closeAll();
});
