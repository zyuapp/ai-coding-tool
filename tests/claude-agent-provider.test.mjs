import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeAgentProvider, discoverClaudeCommands, packagedClaudeExecutable } from "../dist/main/main/agent/claude-agent-provider.mjs";

function input(overrides = {}) {
  return {
    channel: "main",
    prompt: "inspect the app",
    workspaceRoot: "/tmp/project",
    projectless: false,
    computerUse: { status: "unavailable", message: "test" },
    policy: "confirm",
    model: "default",
    contextWindow: "default",
    abortController: new AbortController(),
    authorize: async () => "allow",
    emit() {},
    ...overrides,
  };
}

function queryFactory(messages, capture = {}) {
  return (options) => {
    capture.options = options;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      close() {
        capture.closed = true;
      },
    };
  };
}

test("packaged builds use the unpacked Claude executable", async () => {
  const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "claudex-resources-"));
  const executable = path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "");
  assert.equal(packagedClaudeExecutable(resourcesPath), executable);
  assert.equal(packagedClaudeExecutable(path.join(resourcesPath, "missing")), undefined);
});

test("command discovery initializes an idle workspace session and closes it", async () => {
  const capture = {};
  const commands = [{ name: "pdf", description: "Work with PDFs", argumentHint: "<file>" }];
  const result = await discoverClaudeCommands("/tmp/project", false, (options) => {
    capture.options = options;
    return {
      supportedCommands: async () => commands,
      close: () => { capture.closed = true; },
    };
  });

  assert.deepEqual(result, commands);
  assert.equal(typeof capture.options.prompt[Symbol.asyncIterator], "function");
  assert.deepEqual(capture.options.options.settingSources, ["user", "project", "local"]);
  assert.equal(capture.options.options.skills, "all");
  assert.equal(capture.closed, true);
});

test("Claude query options follow run policy and workspace settings", async () => {
  const cases = [
    { policy: "confirm", permissionMode: "default" },
    { policy: "plan", permissionMode: "plan" },
    { policy: "allow-edits", permissionMode: "acceptEdits" },
    { policy: "autonomous", permissionMode: "auto" },
  ];
  for (const { policy, permissionMode } of cases) {
    const capture = {};
    const provider = new ClaudeAgentProvider(queryFactory([], capture));
    assert.deepEqual(await provider.execute(input({ policy })), { status: "succeeded" });
    assert.equal(capture.options.options.permissionMode, permissionMode);
    assert.equal(capture.closed, true);
  }

  const capture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({
    projectless: true,
    model: "opus",
    contextWindow: "1m",
    continuation: { provider: "claude", value: "session-1" },
  }));
  assert.deepEqual(capture.options.options.settingSources, ["user"]);
  assert.equal(capture.options.options.model, "opus");
  assert.equal(capture.options.options.resume, "session-1");
  assert.deepEqual(capture.options.options.betas, ["context-1m-2025-08-07"]);
  assert.equal(capture.options.options.skills, "all");
  assert.equal(capture.options.options.forwardSubagentText, true);
});

test("side chat forks the main continuation and exposes read-only tools", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(queryFactory([], capture));
  await provider.execute(input({
    channel: "side",
    policy: "autonomous",
    continuation: { provider: "claude", value: "main-session" },
    forkContinuation: true,
  }));

  assert.equal(capture.options.options.resume, "main-session");
  assert.equal(capture.options.options.forkSession, true);
  assert.equal(capture.options.options.permissionMode, "plan");
  assert.deepEqual(capture.options.options.tools, ["Read", "Grep", "Glob"]);
});

test("Claude receives bundled computer-use MCP or the internal setup tool", async () => {
  const availableCapture = {};
  await new ClaudeAgentProvider(queryFactory([], availableCapture)).execute(input({
    computerUse: { status: "available", mcp: { command: "/app/cua-driver", args: ["mcp", "--embedded"], env: { CUA_DRIVER_EMBEDDED: "1" } } },
  }));
  assert.deepEqual(availableCapture.options.options.mcpServers["cua-driver"], {
    type: "stdio",
    command: "/app/cua-driver",
    args: ["mcp", "--embedded"],
    env: { CUA_DRIVER_EMBEDDED: "1" },
  });

  const setupCapture = {};
  await new ClaudeAgentProvider(queryFactory([], setupCapture)).execute(input({ computerUse: { status: "setup-required" } }));
  assert.equal(setupCapture.options.options.mcpServers["claudex-computer-use"].type, "sdk");
  assert.equal((await setupCapture.options.options.canUseTool("mcp__claudex-computer-use__request_setup", {}, { toolUseID: "setup-1" })).behavior, "allow");
  assert.match(setupCapture.options.options.systemPrompt.append, /Observe the exact target before every action/);
  assert.match(setupCapture.options.options.systemPrompt.append, /Never invoke a separately installed cua-driver through Bash/);
});

test("autonomous runs allow bundled computer use without bypassing other tool approvals", async () => {
  const capture = {};
  const authorized = [];
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(input({
    policy: "autonomous",
    computerUse: { status: "available", mcp: { command: "/app/cua-driver", args: [], env: {} } },
    authorize: async (intent) => { authorized.push(intent.name); return "allow"; },
  }));

  assert.equal((await capture.options.options.canUseTool("mcp__cua-driver__click", {}, { toolUseID: "cua-1" })).behavior, "allow");
  assert.deepEqual(authorized, []);
  assert.equal((await capture.options.options.canUseTool("Bash", {}, { toolUseID: "bash-1" })).behavior, "allow");
  assert.deepEqual(authorized, ["Bash"]);
});

test("Claude messages translate to provider events and normalized tool intents", async () => {
  const emitted = [];
  const capture = {};
  const provider = new ClaudeAgentProvider(queryFactory([
    { type: "system", subtype: "init", session_id: "session-2" },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 190_000, post_tokens: 40_000 } },
    { type: "system", subtype: "status", status: "compacting" },
    { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "compact failed" },
    {
      type: "assistant",
      uuid: "message-1",
      message: {
        model: "claude-sonnet",
        usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "  " },
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/tmp/project/a.ts" } },
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ], capture));

  assert.deepEqual(await provider.execute(input({ emit: (event) => emitted.push(event) })), { status: "succeeded" });
  assert.deepEqual(emitted, [
    { type: "continuation", continuation: { provider: "claude", value: "session-2" } },
    { type: "compaction", trigger: "auto", preTokens: 190_000, postTokens: 40_000 },
    { type: "compaction-status", compacting: true },
    { type: "compaction-status", compacting: false, error: "compact failed" },
    { type: "assistant", messageId: "message-1", text: "hello" },
    { type: "tool", intent: { toolId: "edit-1", name: "Edit", input: { file_path: "/tmp/project/a.ts" }, writePath: "/tmp/project/a.ts" } },
    { type: "usage", tokens: 17, limit: 200_000, model: "claude-sonnet" },
  ]);

  const intents = [];
  const allow = await capture.options.options.canUseTool("NotebookEdit", { notebook_path: "/tmp/project/a.ipynb" }, { toolUseID: "tool-1" });
  const denyProvider = new ClaudeAgentProvider(queryFactory([], capture));
  await denyProvider.execute(input({ authorize: async (intent) => { intents.push(intent); return "deny"; } }));
  const deny = await capture.options.options.canUseTool("Bash", { command: "pwd" }, { toolUseID: "tool-2" });
  assert.equal(allow.behavior, "allow");
  assert.equal(deny.behavior, "deny");
  assert.deepEqual(intents, [{ toolId: "tool-2", name: "Bash", input: { command: "pwd" } }]);
});

test("Claude failures, exceptions, and aborts close the query", async () => {
  const failureCapture = {};
  const failure = new ClaudeAgentProvider(queryFactory([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["one", "two"] }], failureCapture));
  assert.deepEqual(await failure.execute(input()), { status: "failed", message: "one\ntwo" });
  assert.equal(failureCapture.closed, true);

  let exceptionClosed = false;
  const exception = new ClaudeAgentProvider(() => ({
    async *[Symbol.asyncIterator]() { throw new Error("stream broke"); },
    close() { exceptionClosed = true; },
  }));
  assert.deepEqual(await exception.execute(input()), { status: "failed", message: "stream broke" });
  assert.equal(exceptionClosed, true);

  const abortController = new AbortController();
  abortController.abort();
  const aborted = new ClaudeAgentProvider(queryFactory([]));
  assert.deepEqual(await aborted.execute(input({ abortController })), { status: "cancelled" });
});
