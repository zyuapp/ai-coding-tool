import assert from "node:assert/strict";
import { test } from "vitest";
import { AppServerError, AppServerExited } from "../../../src/main/codex/app-server-client.mts";
import { codexPolicy, DEVELOPER_INSTRUCTIONS } from "../../../src/main/codex/codex-session.mts";
import type { ProviderEvent, ProviderResult } from "../../../src/main/agent/agent-provider.mts";
import type { GoalReport } from "../../../src/contracts/ipc.ts";
import type { ToolIntent } from "../../../src/domain/run.ts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { SteerChannel } from "../../../src/main/agent/steer-channel.mts";
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

const command = (id: string, command: string): ThreadItem => ({
  type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd: "/tmp/project", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
});

const fileChange = (id: string, ...paths: string[]): ThreadItem => ({
  type: "fileChange", id, status: "inProgress", changes: paths.map((path) => ({ path, kind: { type: "update", move_path: null }, diff: `--- ${path}\n+++ ${path}\n` })),
});

const mcpCall = (id: string, server: string, tool: string, args: unknown): ThreadItem => ({
  type: "mcpToolCall", id, server, tool, status: "inProgress", arguments: args as never, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
});

const agentMessage = (id: string, text: string): ThreadItem => ({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null, delivery: null });

/** The prompt Codex sends before an MCP tool runs, as captured from the real app server. */
function elicitation(server: string, tool: string, params: Record<string, string>) {
  return {
    threadId, turnId, serverName: server, mode: "form" as const,
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Append text.", tool_params: params, tool_params_display: [] },
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: "object" as const, properties: {} },
  };
}

test("a run opens one app server in the workspace, signs in, starts a thread, and turns on it", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  const { client, result } = await turn(codex, { emit: (event) => emitted.push(event) });

  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(client.command.cwd, "/tmp/project");
  assert.deepEqual(client.command.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.match(client.command.executable, /codex$/);
  assert.deepEqual(client.sent.map((call) => call.method), ["initialize", "account/read", "thread/start", "turn/start"]);
  assert.deepEqual(client.calls("thread/start"), [{ cwd: "/tmp/project", model: "gpt-5.6-sol", approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user", config: { model_reasoning_effort: "high" }, developerInstructions: DEVELOPER_INSTRUCTIONS }]);
  assert.deepEqual(client.calls("turn/start"), [{
    threadId,
    input: [{ type: "text", text: "inspect the app", text_elements: [] }],
    model: "gpt-5.6-sol",
    effort: "high",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  }]);
  assert.deepEqual(emitted, [{ type: "continuation", continuation: { provider: "codex", value: threadId } }]);

  const again = await turn(codex, { prompt: "and again", model: "gpt-5.6-terra", effort: "low", policy: "allow-edits", continuation: { provider: "codex", value: threadId }, emit: (event) => emitted.push(event) });
  assert.equal(again.client, client, "the second turn rides the warm session");
  assert.equal(client.calls("thread/start").length, 1);
  assert.equal(client.calls("thread/resume").length, 0);
  assert.deepEqual(client.calls("turn/start")[1], {
    threadId,
    input: [{ type: "text", text: "and again", text_elements: [] }],
    model: "gpt-5.6-terra",
    effort: "low",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  }, "model, effort, and policy are the turn's, so a switch needs no new process");
  assert.equal(emitted.filter((event) => event.type === "continuation").length, 1, "the thread's id is reported once");
  codex.provider.closeAll();
  assert.equal(client.closed, true);
});

test("every execution policy maps onto Codex approvals, sandbox, and reviewer", () => {
  assert.deepEqual(codexPolicy("confirm"), { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" });
  assert.deepEqual(codexPolicy("plan"), codexPolicy("confirm"));
  assert.deepEqual(codexPolicy("allow-edits"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
  assert.deepEqual(codexPolicy("autonomous"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
});

test("Codex sets a native goal and keeps the run through its follow-up turns", async () => {
  const goals: GoalReport[] = [];
  const codex = harness();
  const running = codex.provider.execute(input({ prompt: "/goal All checks pass", reportGoal: (report) => goals.push(report) }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");

  assert.deepEqual(client.calls("thread/goal/set"), [{ threadId, objective: "All checks pass" }]);
  assert.equal((client.calls("turn/start")[0] as { input: { text: string }[] }).input[0]?.text, "All checks pass");
  completeTurn(client);
  let settled = false;
  void running.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, "an active goal owns the next native turn");

  client.notify("turn/started", { threadId, turn: { id: "turn-2", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 2, completedAt: null, durationMs: null } });
  client.notify("thread/goal/cleared", { threadId });
  client.notify("turn/completed", { threadId, turn: { id: "turn-2", items: [], itemsView: "summary", status: "completed", error: null, startedAt: 2, completedAt: 3, durationMs: 1000 } });

  assert.deepEqual(await running, { status: "succeeded" });
  assert.deepEqual(goals, [
    { type: "goal.changed", goal: null },
    { type: "goal.changed", goal: { objective: "All checks pass", status: "active" } },
    { type: "goal.changed", goal: null },
  ]);
  codex.provider.closeAll();
});

test("a thread the run continues is resumed, and a side chat forks it instead", async () => {
  const resumed = harness();
  const { client } = await turn(resumed, { continuation: { provider: "codex", value: "thread-9" } });
  assert.deepEqual(client.calls("thread/resume"), [{ threadId: "thread-9", cwd: "/tmp/project", model: "gpt-5.6-sol", approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user", config: { model_reasoning_effort: "high" }, developerInstructions: DEVELOPER_INSTRUCTIONS }]);
  assert.equal(client.calls("thread/start").length, 0);
  resumed.provider.closeAll();

  const emitted: ProviderEvent[] = [];
  const forked = harness();
  const fork = await turn(forked, { channel: "side", continuation: { provider: "codex", value: "thread-9" }, forkContinuation: true, emit: (event) => emitted.push(event) });
  assert.deepEqual(fork.client.calls("thread/fork"), [{ threadId: "thread-9", cwd: "/tmp/project", model: "gpt-5.6-sol", approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user", config: { model_reasoning_effort: "high" }, developerInstructions: DEVELOPER_INSTRUCTIONS }]);
  assert.deepEqual(emitted[0], { type: "continuation", continuation: { provider: "codex", value: "thread-fork" } }, "the fork's own id is what the side chat keeps");
  forked.provider.closeAll();

  const foreign = harness();
  const other = await turn(foreign, { continuation: { provider: "claude", value: "session-1" } });
  assert.equal(other.client.calls("thread/start").length, 1, "another engine's continuation means nothing here");
  foreign.provider.closeAll();
});

test("a server that dies while resuming fails the run without giving up the continuation", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness({
    "thread/resume": () => { throw new AppServerExited({ code: 1, signal: null, stderr: "fatal: rollout store locked" }, "while thread/resume was pending"); },
  });
  const result = await codex.provider.execute(input({ continuation: { provider: "codex", value: "thread-9" }, emit: (event) => emitted.push(event) }));

  assert.deepEqual(result, { status: "failed", message: "Codex could not start: fatal: rollout store locked" });
  assert.deepEqual(emitted, [], "the thread may still be there, so nothing says it is lost");
  assert.equal(codex.latest().closed, true);
});

test("a turn the server completes before it has named it needs no interrupt", async () => {
  let name!: (turn: unknown) => void;
  const codex = harness({ "turn/start": () => new Promise((resolve) => { name = resolve; }) });
  const running = codex.provider.execute(input());
  const client = await opened(codex);
  await sentBy(client, "turn/start");

  completeTurn(client);
  assert.deepEqual(await running, { status: "succeeded" });
  name({ turn: { id: turnId } });
  await tick();
  await tick();
  assert.equal(client.calls("turn/interrupt").length, 0, "a turn already over is not interrupted");
  codex.provider.closeAll();
});

test("a thread Codex no longer has fails the run, gives up the continuation, and never starts a fresh thread in its place", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness({
    "thread/resume": () => { throw new AppServerError("thread/resume", -32600, "no rollout found for thread id thread-9"); },
  });
  const result = await codex.provider.execute(input({ continuation: { provider: "codex", value: "thread-9" }, emit: (event) => emitted.push(event) }));

  assert.equal(result.status, "failed");
  assert.match(result.message ?? "", /Codex could not continue this thread/);
  assert.match(result.message ?? "", /no rollout found for thread id thread-9/);
  assert.match(result.message ?? "", /Start a new thread/);
  assert.deepEqual(emitted, [{ type: "continuation-lost" }]);
  const client = codex.latest();
  assert.equal(client.calls("thread/start").length, 0);
  assert.equal(client.closed, true);
});

test("a signed-out Codex fails the run before any thread is started", async () => {
  const codex = harness({ "account/read": () => ({ account: null, requiresOpenaiAuth: true }) });
  const result = await codex.provider.execute(input());
  assert.deepEqual(result, { status: "failed", message: "Sign in to Codex to run this thread." });
  assert.equal(codex.latest().calls("thread/start").length, 0);
  assert.equal(codex.latest().closed, true);
});

test("an app server that cannot start fails the run in one line that names Codex", async () => {
  const exit = { code: null, signal: null, stderr: "spawn /app/codex ENOENT\nmore detail" };
  const codex = harness({}, { handshake: () => Promise.reject(new AppServerExited(exit, "before initialize")) });
  const result = await codex.provider.execute(input());
  assert.deepEqual(result, { status: "failed", message: "Codex could not start: spawn /app/codex ENOENT" });

  const gone = harness({}, { handshake: () => new Promise(() => {}) });
  const running = gone.provider.execute(input());
  const client = await opened(gone);
  client.exit({ code: 1, signal: null, stderr: "" });
  assert.deepEqual(await running, { status: "failed", message: "Codex could not start: exit code 1" });
});

test("streamed text ships whole Markdown blocks with the tail typed out, and a message that never streamed arrives whole", async () => {
  const emitted: ProviderEvent[] = [];
  const messageId = "msg-1";
  const fullText = "## First\n\nParagraph with **bold**.\n\n```ts\nconst x = 1;\n\n```\n";
  const codex = harness();
  await turn(codex, { emit: (event) => emitted.push(event) }, (client) => {
    client.notify("item/started", started(agentMessage(messageId, "")));
    for (const delta of ["## Fi", "rst\n\nParagraph with **bo", "ld**.\n\n```ts\nconst x = 1;\n\n", "```\n"]) {
      client.notify("item/agentMessage/delta", { ...at, itemId: messageId, delta });
    }
    client.notify("item/completed", completed(agentMessage(messageId, fullText)));
    client.notify("item/started", started({ type: "reasoning", id: "rs-1", summary: [], content: [] }));
    client.notify("item/completed", completed({ type: "reasoning", id: "rs-1", summary: ["thinking"], content: [] }));
    client.notify("item/completed", completed(agentMessage("msg-2", "Done.")));
    client.notify("item/completed", completed(agentMessage("msg-3", "  ")));
  });

  assert.deepEqual(emitted.filter((event) => event.type !== "continuation"), [
    { type: "assistant-tail", messageId, text: "## Fi" },
    { type: "assistant", messageId, text: "## First\n\n", append: true },
    { type: "assistant-tail", messageId, text: "Paragraph with **bo" },
    { type: "assistant", messageId, text: "Paragraph with **bold**.\n\n", append: true },
    { type: "assistant-tail", messageId, text: "```ts\nconst x = 1;\n\n" },
    { type: "assistant", messageId, text: "```ts\nconst x = 1;\n\n```\n", append: true },
    { type: "assistant-tail", messageId, text: "" },
    { type: "assistant", messageId: "msg-2", text: "Done." },
  ]);
  codex.provider.closeAll();
});

test("a message whose last block never closed ships the rest when the item completes", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  await turn(codex, { emit: (event) => emitted.push(event) }, (client) => {
    client.notify("item/agentMessage/delta", { ...at, itemId: "msg-1", delta: "Intro.\n\n```ts\nconst delayed =" });
    client.notify("item/agentMessage/delta", { ...at, itemId: "msg-1", delta: " true;" });
    client.notify("item/completed", completed(agentMessage("msg-1", "Intro.\n\n```ts\nconst delayed = true;")));
  });
  assert.deepEqual(emitted.filter((event) => event.type === "assistant").map((event) => event.text), ["Intro.\n\n", "```ts\nconst delayed = true;"]);
  codex.provider.closeAll();
});

test("items the agent starts become tool intents under the names the thread files them by", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  await turn(codex, { emit: (event) => emitted.push(event) }, (client) => {
    client.notify("item/started", started(command("cmd-1", "ls -la")));
    client.notify("item/started", started(fileChange("patch-1", "/tmp/project/src/app.ts", "/tmp/project/README.md")));
    client.notify("item/started", started(mcpCall("mcp-1", "aicodingtool-browser", "browser_open", { url: "https://example.com" })));
    client.notify("item/started", started({ type: "webSearch", id: "search-1", query: "vitest forks pool", action: null, results: null }));
    client.notify("item/started", started({ type: "plan", id: "plan-1", text: "1. look" }));
    client.notify("item/started", started({ type: "imageView", id: "img-1", path: "/tmp/shot.png" }));
  });

  assert.deepEqual(emitted.filter((event): event is Extract<ProviderEvent, { type: "tool" }> => event.type === "tool").map((event) => event.intent), [
    { toolId: "cmd-1", name: "command_execution", input: { command: "ls -la", cwd: "/tmp/project" } },
    {
      toolId: "patch-1",
      name: "file_change",
      input: { path: "/tmp/project/src/app.ts", changes: [
        { path: "/tmp/project/src/app.ts", kind: "update", diff: "--- /tmp/project/src/app.ts\n+++ /tmp/project/src/app.ts\n" },
        { path: "/tmp/project/README.md", kind: "update", diff: "--- /tmp/project/README.md\n+++ /tmp/project/README.md\n" },
      ] },
      writePath: "/tmp/project/src/app.ts",
    },
    { toolId: "mcp-1", name: "browser_open", input: { url: "https://example.com" } },
    { toolId: "search-1", name: "web_search", input: { query: "vitest forks pool" } },
  ] satisfies ToolIntent[]);
  codex.provider.closeAll();
});

test("context usage reports the last request against the model's window, and a compaction is measured from it", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  const breakdown = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens - 200, cachedInputTokens: 11_008, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 69 });
  await turn(codex, { model: "gpt-5.6-terra", emit: (event) => emitted.push(event) }, (client) => {
    client.notify("thread/tokenUsage/updated", { ...at, tokenUsage: { total: breakdown(31_379), last: breakdown(15_707), modelContextWindow: 258_400 } });
    client.notify("item/started", started({ type: "contextCompaction", id: "compact-1" }));
    client.notify("item/completed", completed({ type: "contextCompaction", id: "compact-1" }));
  });

  assert.deepEqual(emitted.filter((event) => event.type !== "continuation"), [
    { type: "usage", tokens: 15_707, limit: 258_400, model: "gpt-5.6-terra" },
    { type: "compaction-status", compacting: true },
    { type: "compaction", trigger: "auto", preTokens: 15_707 },
    { type: "compaction-status", compacting: false },
  ]);
  codex.provider.closeAll();
});

test("manual compaction uses Sol's thread operation and the same visible progress state", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  const running = codex.provider.execute(input({
    prompt: "",
    continuation: { provider: "codex", value: threadId },
    operation: { type: "compact", preTokens: 125_000 },
    emit: (event) => emitted.push(event),
  }));
  const client = await opened(codex);
  await sentBy(client, "thread/compact/start");

  assert.deepEqual(client.calls("thread/compact/start"), [{ threadId }]);
  assert.equal(client.calls("turn/start").length, 0, "compaction is not an empty model turn");
  client.notify("item/started", started({ type: "contextCompaction", id: "compact-1" }));
  client.notify("item/completed", completed({ type: "contextCompaction", id: "compact-1" }));

  assert.deepEqual(await running, { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type !== "continuation"), [
    { type: "compaction-status", compacting: true },
    { type: "compaction", trigger: "manual", preTokens: 125_000 },
    { type: "compaction-status", compacting: false },
  ]);
  codex.provider.closeAll();
});

test("native review runs as a detached session subagent and copies its result into the parent", async () => {
  const emitted: ProviderEvent[] = [];
  const reports: ProviderEvent[] = [];
  const codex = harness();
  const warm = await turn(codex);
  const running = codex.provider.execute(input({
    prompt: "",
    continuation: { provider: "codex", value: threadId },
    model: "gpt-5.6-terra",
    effort: "low",
    policy: "allow-edits",
    operation: { type: "review", target: { type: "baseBranch", branch: "main" } },
    emit: (event) => emitted.push(event),
    reportSubagent: (event) => reports.push(event),
  }));
  for (let waited = 0; codex.clients.length < 2; waited += 1) {
    if (waited > 100) throw new Error("review session was never opened");
    await tick();
  }
  const client = codex.latest();
  await sentBy(client, "review/start");

  assert.notEqual(client, warm.client, "review reopens the thread because review/start has no setting overrides");
  assert.equal(warm.client.closed, true);
  assert.deepEqual(client.calls("thread/resume"), [{
    threadId,
    cwd: "/tmp/project",
    model: "gpt-5.6-terra",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
    config: { model_reasoning_effort: "low" },
    developerInstructions: DEVELOPER_INSTRUCTIONS,
  }]);
  assert.deepEqual(client.calls("review/start"), [{ threadId, target: { type: "baseBranch", branch: "main" }, delivery: "detached" }]);
  assert.equal(client.calls("turn/start").length, 0);
  client.notify("turn/started", {
    threadId: "thread-review",
    turn: { id: turnId, items: [], itemsView: "summary", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
  });
  client.notify("item/completed", {
    threadId: "thread-review",
    turnId,
    item: { type: "exitedReviewMode", id: "review-1", review: "No findings." },
    completedAtMs: 2,
  });
  client.notify("turn/completed", {
    threadId: "thread-review",
    turn: { id: turnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000 },
  });

  assert.deepEqual(await running, { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type !== "continuation"), [{ type: "assistant", messageId: "review:thread-review", text: "No findings." }]);
  assert.deepEqual(client.calls("thread/inject_items"), [{
    threadId,
    items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "No findings." }] }],
  }]);
  assert.deepEqual(reports.filter((event) => event.type === "subagent.started"), [{
    type: "subagent.started", id: "thread-review", description: "Review against main", agentType: "reviewer", sessionScoped: true,
  }]);
  assert.equal(reports.some((event) => event.type === "subagent.activity" && event.kind === "text" && event.text === "No findings."), true);
  codex.provider.closeAll();
});

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
  session.client.notify("item/started", started({ type: "subAgentActivity", id: "discover-child", kind: "started", agentThreadId: "child-a", agentPath: "/root/reviewer" }));
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

test("permission and user-input requests go through the same gate", async () => {
  const allowed = await asking();
  const permissions = { network: { enabled: true }, fileSystem: null } as never;
  const granted = await allowed.client.ask("item/permissions/requestApproval", { ...at, itemId: "perm-1", environmentId: null, startedAtMs: 1, cwd: "/tmp/project", reason: "npm install", permissions });
  assert.deepEqual(granted, { result: { permissions: { network: { enabled: true } }, scope: "turn" } });
  assert.deepEqual(allowed.asked[0], { toolId: "perm-1", name: "permissions", input: { cwd: "/tmp/project", reason: "npm install", permissions } });
  const answered = await allowed.client.ask("item/tool/requestUserInput", { ...at, itemId: "ask-1", questions: [{ id: "q1", header: "Region", question: "Which region?", isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null });
  assert.deepEqual(answered, { result: { answers: {} } });
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

test("cancelling interrupts the turn the server named, and settles once the server says it stopped", async () => {
  const codex = harness();
  const abortController = new AbortController();
  const running = codex.provider.execute(input({ abortController }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");

  abortController.abort();
  await sentBy(client, "turn/interrupt");
  assert.deepEqual(client.calls("turn/interrupt"), [{ threadId, turnId }]);
  completeTurn(client, "interrupted");
  assert.deepEqual(await running, { status: "cancelled" });
  assert.equal(client.closed, false, "a turn that stopped cleanly leaves the session warm");
  codex.provider.closeAll();
});

test("a cancel that lands before the server has named the turn is sent as soon as it has", async () => {
  let name!: (turn: unknown) => void;
  const codex = harness({ "turn/start": () => new Promise((resolve) => { name = resolve; }) });
  const abortController = new AbortController();
  const running = codex.provider.execute(input({ abortController }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");

  abortController.abort();
  await tick();
  assert.equal(client.calls("turn/interrupt").length, 0);
  name({ turn: { id: turnId } });
  await sentBy(client, "turn/interrupt");
  completeTurn(client, "interrupted");
  assert.deepEqual(await running, { status: "cancelled" });
  codex.provider.closeAll();
});

test("steered messages fold into the turn going, and one the server refuses stays with the thread", async () => {
  const emitted: ProviderEvent[] = [];
  let refuse = false;
  const codex = harness({ "turn/steer": () => { if (refuse) throw new AppServerError("turn/steer", -32600, "no active turn to steer"); return { turnId }; } });
  const steering = new SteerChannel();
  const running = codex.provider.execute(input({ steering, emit: (event) => emitted.push(event) }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");

  steering.push({ messageId: "m-1", prompt: "check the tests too" });
  await sentBy(client, "turn/steer");
  assert.deepEqual(client.calls("turn/steer"), [{ threadId, input: [{ type: "text", text: "check the tests too", text_elements: [] }], expectedTurnId: turnId }]);
  await tick();
  assert.deepEqual(emitted.filter((event) => event.type === "steered"), [{ type: "steered", messageId: "m-1" }]);

  refuse = true;
  steering.push({ messageId: "m-2", prompt: "too late" });
  await sentBy(client, "turn/steer", 2);
  await tick();
  assert.deepEqual(emitted.filter((event) => event.type === "steered").length, 1, "an undelivered message is the thread's to send next");

  completeTurn(client);
  steering.close();
  assert.deepEqual(await running, { status: "succeeded" });
  codex.provider.closeAll();
});

test("a turn the server fails ends the run with its reason, and the session stays for the next one", async () => {
  const codex = harness();
  const running = codex.provider.execute(input());
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  client.notify("error", { ...at, error: { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded", additionalDetails: null }, willRetry: false });
  completeTurn(client, "failed");
  assert.deepEqual(await running, { status: "failed", message: "usage limit reached" });

  const again = await turn(codex, { continuation: { provider: "codex", value: threadId } });
  assert.equal(again.client, client);
  codex.provider.closeAll();
});

test("an app server that dies mid-turn fails the run and ends the session", async () => {
  const codex = harness();
  const running = codex.provider.execute(input());
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  client.exit({ code: null, signal: "SIGKILL", stderr: "" });
  assert.deepEqual(await running, { status: "failed", message: "Codex stopped: signal SIGKILL" });

  const next = await turn(codex, { continuation: { provider: "codex", value: threadId } });
  assert.notEqual(next.client, client, "the next run gets a process of its own");
  assert.deepEqual(next.client.calls("thread/resume").map((params) => (params as { threadId: string }).threadId), [threadId]);
  codex.provider.closeAll();
});

test("sessions are per thread, reused only for the thread they hold, and the coldest idle one goes when the pool is full", async () => {
  const codex = harness();
  const results: ProviderResult[] = [];
  for (const taskId of ["a", "b", "c", "d"]) results.push((await turn(codex, { taskId })).result);
  assert.equal(codex.clients.length, 4);
  assert.deepEqual(results.map((result) => result.status), ["succeeded", "succeeded", "succeeded", "succeeded"]);

  await turn(codex, { taskId: "e" });
  assert.equal(codex.clients.length, 5);
  assert.equal(codex.clients[0].closed, true, "thread a's session is the coldest, so it is the one let go");
  assert.equal(codex.clients[1].closed, false);

  await turn(codex, { taskId: "b", continuation: { provider: "codex", value: threadId } });
  assert.equal(codex.clients.length, 5, "thread b's warm session takes its next turn");

  await turn(codex, { taskId: "c", workspaceRoot: "/tmp/elsewhere" });
  assert.equal(codex.clients.length, 6, "a run built differently gets a session of its own");
  assert.equal(codex.clients[2].closed, true);
  codex.provider.closeAll();
  assert.equal(codex.clients.filter((client) => !client.closed).length, 0);
});

test("an idle session is let go after the idle period", async () => {
  const codex = harness({}, { idleMs: 5 });
  const { client } = await turn(codex);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.closed, true);
  const next = await turn(codex, { continuation: { provider: "codex", value: threadId } });
  assert.notEqual(next.client, client);
  codex.provider.closeAll();
});

test("Codex has no background processes of its own to stop", async () => {
  const codex = harness();
  await turn(codex);
  assert.equal(codex.provider.stopProcess("task-1", "anything"), false);
  codex.provider.closeAll();
});

test("a run that was already cancelled never reaches the server", async () => {
  const codex = harness();
  const abortController = new AbortController();
  abortController.abort();
  assert.deepEqual(await codex.provider.execute(input({ abortController })), { status: "cancelled" });
  assert.equal(codex.clients.length, 0);
});
