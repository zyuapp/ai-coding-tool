import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeAgentProvider, discoverClaudeCommands, packagedClaudeExecutable } from "../dist/main/main/agent/claude-agent-provider.mjs";
import { input, liveQueryFactory, liveTurn, poolQueryFactory, poolTurn, queryFactory, tick, turn } from "./support/claude-session.mjs";

test("packaged builds use the unpacked Claude executable", async () => {
  const resourcesPath = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-resources-"));
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
    effort: "xhigh",
    continuation: { provider: "claude", value: "session-1" },
  }));
  assert.deepEqual(capture.options.options.settingSources, ["user"]);
  assert.equal(capture.options.options.model, "opus");
  assert.equal(capture.options.options.effort, "xhigh");
  assert.equal(capture.options.options.resume, "session-1");
  assert.deepEqual(capture.options.options.betas, ["context-1m-2025-08-07"]);
  assert.equal(capture.options.options.skills, "all");
  assert.equal(capture.options.options.forwardSubagentText, true);
  assert.equal(capture.options.options.includePartialMessages, true);
  assert.match(capture.options.options.systemPrompt.append, /workspace files as \[label\]\(\/absolute\/path:line\)/);
  assert.equal(capture.options.options.settings, undefined, "a run with no style named leaves the user's own settings alone");
});

test("Claude streams only complete Markdown blocks and does not repeat final text", async () => {
  const emitted = [];
  const messageId = "api-message-streamed";
  const delta = (text) => ({
    type: "stream_event",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
  const fullText = "## First\n\nParagraph with **bold**.\n\n```ts\nconst x = 1;\n\n```\n";
  const provider = new ClaudeAgentProvider(queryFactory([
    { type: "stream_event", uuid: crypto.randomUUID(), parent_tool_use_id: null, event: { type: "message_start", message: { id: messageId } } },
    delta("## Fi"),
    delta("rst\n\nParagraph with **bo"),
    delta("ld**.\n\n```ts\nconst x = 1;\n\n"),
    delta("```\n"),
    {
      type: "assistant",
      uuid: "different-final-wrapper-uuid",
      parent_tool_use_id: null,
      message: { id: messageId, model: "claude-sonnet", usage: { input_tokens: 1 }, content: [{ type: "text", text: fullText }] },
    },
  ]));

  assert.deepEqual(await provider.execute(input({ emit: (event) => emitted.push(event) })), { status: "succeeded" });
  assert.deepEqual(emitted, [
    { type: "assistant-tail", messageId, text: "## Fi" },
    { type: "assistant", messageId, text: "## First\n\n", append: true },
    { type: "assistant-tail", messageId, text: "Paragraph with **bo" },
    { type: "assistant", messageId, text: "Paragraph with **bold**.\n\n", append: true },
    { type: "assistant-tail", messageId, text: "```ts\nconst x = 1;\n\n" },
    { type: "assistant", messageId, text: "```ts\nconst x = 1;\n\n```\n", append: true },
    { type: "assistant-tail", messageId, text: "" },
    { type: "usage", tokens: 1, limit: 1_000_000, model: "claude-sonnet" },
  ]);
});

test("reported context usage tracks the widest window the chosen model offers", async () => {
  const assistant = {
    type: "assistant",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: null,
    message: { id: "api-message", model: "claude-model", usage: { input_tokens: 1 }, content: [] },
  };
  for (const [model, limit] of [["fable", 1_000_000], ["opus", 1_000_000], ["sonnet", 1_000_000], ["haiku", 200_000]]) {
    const emitted = [];
    const provider = new ClaudeAgentProvider(queryFactory([assistant]));
    await provider.execute(input({ model, emit: (event) => emitted.push(event) }));
    assert.deepEqual(emitted, [{ type: "usage", tokens: 1, limit, model: "claude-model" }]);
  }
});

test("a synthetic reply leaves the reported context usage alone", async () => {
  const emitted = [];
  const provider = new ClaudeAgentProvider(queryFactory([
    {
      type: "assistant",
      uuid: crypto.randomUUID(),
      parent_tool_use_id: null,
      message: { id: "api-message", model: "claude-sonnet", usage: { input_tokens: 40_000 }, content: [] },
    },
    {
      type: "assistant",
      uuid: crypto.randomUUID(),
      parent_tool_use_id: null,
      message: {
        id: "synthetic-message",
        model: "<synthetic>",
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: "text", text: "6 MCP server(s): 2 connected." }],
      },
    },
  ]));
  await provider.execute(input({ emit: (event) => emitted.push(event) }));

  assert.deepEqual(emitted.filter((event) => event.type === "usage"), [
    { type: "usage", tokens: 40_000, limit: 1_000_000, model: "claude-sonnet" },
  ]);
  assert.ok(emitted.some((event) => event.type === "assistant" && event.text === "6 MCP server(s): 2 connected."));
});

test("Claude keeps complex Markdown fences intact across adversarial chunk boundaries", async () => {
  const cases = [
    {
      name: "fenced code nested in a list",
      chunks: [
        "Before.\n\n- Example:\n\n    ```ts\n    const first = 1;\n",
        "\n    const second = 2;\n",
        "    ```\n\nAfter.",
      ],
      expected: [
        "Before.\n\n- Example:\n\n",
        "    ```ts\n    const first = 1;\n\n    const second = 2;\n    ```\n\n",
        "After.",
      ],
    },
    {
      name: "four-backtick fence containing a triple-backtick fence",
      chunks: ["``", "``md\n```ts\nconst value = 1;\n", "```\n\nStill outer.\n```", "`\n\nDone."],
      expected: ["````md\n```ts\nconst value = 1;\n```\n\nStill outer.\n````\n\n", "Done."],
    },
    {
      name: "tilde fence with CRLF newlines",
      chunks: ["~~~ts\r\nconst first = 1;\r", "\n\r\nconst second = 2;\r\n", "~~~\r\n\r\nTail."],
      expected: ["~~~ts\r\nconst first = 1;\r\n\r\nconst second = 2;\r\n~~~\r\n\r\n", "Tail."],
    },
    {
      name: "unterminated final fence",
      chunks: ["Intro.\n\n```ts\nconst delayed =", " true;"],
      expected: ["Intro.\n\n", "```ts\nconst delayed = true;"],
    },
  ];

  for (const scenario of cases) {
    const emitted = [];
    /** What the UI shows is the committed blocks plus the tail, so together they must never lag or repeat. */
    let committed = "";
    let chunk = 0;
    const track = (event) => {
      if (event.type === "assistant") committed += event.text;
      if (event.type === "assistant-tail") {
        assert.equal(committed + event.text, scenario.chunks.slice(0, ++chunk).join(""), `${scenario.name} after chunk ${chunk}`);
      }
    };
    const messageId = `complex-${scenario.name}`;
    const fullText = scenario.chunks.join("");
    const messages = [
      { type: "stream_event", uuid: crypto.randomUUID(), parent_tool_use_id: null, event: { type: "message_start", message: { id: messageId } } },
      ...scenario.chunks.map((text) => ({ type: "stream_event", uuid: crypto.randomUUID(), parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } })),
      { type: "assistant", uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: messageId, model: "claude-sonnet", usage: { input_tokens: 1 }, content: [{ type: "text", text: fullText }] } },
    ];

    const provider = new ClaudeAgentProvider(queryFactory(messages));
    await provider.execute(input({ emit: (event) => { track(event); emitted.push(event); } }));
    assert.deepEqual(emitted.filter((event) => event.type === "assistant").map((event) => event.text), scenario.expected, scenario.name);
    assert.equal(chunk, scenario.chunks.length, `${scenario.name} reports a tail for every chunk`);
  }
});

test("the channel tool table is the only thing a side chat is short of", async () => {
  const automations = { list: async () => [], read: async () => null, save: async () => ({}), update: async () => ({}), remove: async () => true };
  const threads = { list: async () => [], read: async () => null, start: async () => ({}), message: async () => ({}), wait: async () => ({}), stop: async () => true, archive: async () => true };

  const main = {};
  await new ClaudeAgentProvider(queryFactory([], main)).execute(input({ automations, threads }));
  const side = {};
  await new ClaudeAgentProvider(queryFactory([], side)).execute(input({ channel: "side", automations, threads }));

  assert.deepEqual(main.options.options.disallowedTools, ["AskUserQuestion"]);
  assert.deepEqual(side.options.options.disallowedTools, [
    "AskUserQuestion",
    ...["schedule", "update", "stop", "notify", "nothing_to_report"].map((name) => `mcp__aicodingtool-automation__${name}`),
  ], "a side chat reads automations, writes none, and raises nothing where nothing could be read");

  assert.deepEqual(
    Object.keys(side.options.options.mcpServers ?? {}).sort(),
    Object.keys(main.options.options.mcpServers ?? {}).sort(),
    "every other server a run gets, a side chat gets",
  );
  assert.equal(side.options.options.tools, undefined, "no tool allowlist narrows a side chat");
});

test("side chat forks the main continuation and keeps the tools of its own policy", async () => {
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
  assert.equal(capture.options.options.permissionMode, "auto");
  assert.equal(capture.options.options.tools, undefined, "a side chat is limited by its policy, not by a tool list");
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

  const setup = await liveTurn({ computerUse: { status: "setup-required" } });
  assert.equal(setup.mcpServers["aicodingtool-computer-use"].type, "sdk");
  assert.equal((await setup.canUseTool("mcp__aicodingtool-computer-use__request_setup", {}, { toolUseID: "setup-1" })).behavior, "allow");
  assert.match(setup.systemPrompt.append, /Observe the exact target before every action/);
  assert.match(setup.systemPrompt.append, /Never invoke a separately installed cua-driver through Bash/);
  await setup.end();
});

test("autonomous runs allow bundled computer use without bypassing other tool approvals", async () => {
  const authorized = [];
  const live = await liveTurn({
    policy: "autonomous",
    computerUse: { status: "available", mcp: { command: "/app/cua-driver", args: [], env: {} } },
    authorize: async (intent) => { authorized.push(intent.name); return "allow"; },
  });

  assert.equal((await live.canUseTool("mcp__cua-driver__click", {}, { toolUseID: "cua-1" })).behavior, "allow");
  assert.deepEqual(authorized, []);
  assert.equal((await live.canUseTool("Bash", {}, { toolUseID: "bash-1" })).behavior, "allow");
  assert.deepEqual(authorized, ["Bash"]);
  await live.end();
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
    { type: "usage", tokens: 17, limit: 1_000_000, model: "claude-sonnet" },
  ]);

  const intents = [];
  const live = await liveTurn({ authorize: async (intent) => { intents.push(intent); return intent.name === "NotebookEdit" ? "allow" : "deny"; } });
  const allow = await live.canUseTool("NotebookEdit", { notebook_path: "/tmp/project/a.ipynb" }, { toolUseID: "tool-1" });
  const deny = await live.canUseTool("Bash", { command: "pwd" }, { toolUseID: "tool-2" });
  assert.equal(allow.behavior, "allow");
  assert.equal(deny.behavior, "deny");
  assert.deepEqual(intents, [
    { toolId: "tool-1", name: "NotebookEdit", input: { notebook_path: "/tmp/project/a.ipynb" }, writePath: "/tmp/project/a.ipynb" },
    { toolId: "tool-2", name: "Bash", input: { command: "pwd" } },
  ]);
  await live.end();
});

test("a skill invocation is named after the skill it runs", async () => {
  const emitted = [];
  const provider = new ClaudeAgentProvider(queryFactory([
    {
      type: "assistant",
      uuid: "message-1",
      message: {
        model: "claude-sonnet",
        usage: { input_tokens: 1 },
        content: [
          { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "quality-check", args: "--report-only" } },
          { type: "tool_use", id: "skill-2", name: "Skill", input: {} },
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));

  await provider.execute(input({ emit: (event) => emitted.push(event) }));
  assert.deepEqual(emitted.filter((event) => event.type === "tool").map((event) => event.intent.name), ["Skill: quality-check", "Skill"]);
});

test("automation tools bypass approval so a scheduled run can stop itself unattended", async () => {
  const asked = [];
  const { canUseTool, end } = await liveTurn({
    automations: { read: async () => null, list: async () => [], save: async () => ({}), update: async () => ({}), remove: async () => true },
    authorize: async (intent) => { asked.push(intent.name); return "deny"; },
  });

  for (const name of ["mcp__aicodingtool-automation__schedule", "mcp__aicodingtool-automation__stop", "mcp__aicodingtool-automation__status"]) {
    assert.equal((await canUseTool(name, {}, { toolUseID: name })).behavior, "allow", name);
  }
  assert.equal((await canUseTool("Bash", { command: "pwd" }, { toolUseID: "bash-1" })).behavior, "deny");
  assert.deepEqual(asked, ["Bash"], "no automation tool ever waited on a human");
  await end();
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

/** Drains the run's input stream alongside its output, the way the SDK does. */
function streamingQueryFactory(messages, capture = {}) {
  return (options) => {
    capture.options = options;
    capture.sent = [];
    const draining = (async () => {
      for await (const message of options.prompt) capture.sent.push(message.message.content);
    })();
    return {
      async *[Symbol.asyncIterator]() {
        await Promise.race([draining, new Promise((resolve) => setImmediate(resolve))]);
        for (const message of messages) yield message;
      },
      close() {
        capture.closed = true;
      },
    };
  };
}

test("a steered message joins the run's input stream and only then counts as delivered", async () => {
  const capture = {};
  const emitted = [];
  const steered = [{ messageId: "message-1", prompt: "check the tests too" }];
  const steering = { next: async () => steered.shift() ?? null };
  const provider = new ClaudeAgentProvider(streamingQueryFactory([], capture));

  assert.deepEqual(await provider.execute(input({ steering, emit: (event) => emitted.push(event) })), { status: "succeeded" });
  assert.deepEqual(capture.sent, ["inspect the app", "check the tests too"]);
  assert.deepEqual(emitted.filter((event) => event.type === "steered"), [{ type: "steered", messageId: "message-1" }]);
});

test("a run ends on its turn's result even though its input stream stays open", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(streamingQueryFactory([{ type: "result", subtype: "success", is_error: false, result: "done" }], capture));

  assert.deepEqual(await provider.execute(input()), { status: "succeeded" });
});


test("a second turn keeps the session the first one warmed, and takes its settings as changes", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));

  const first = await turn(capture, provider.execute(input()), { type: "system", subtype: "init", session_id: "session-1" });
  assert.deepEqual(first, { status: "succeeded" });
  assert.equal(capture.opens, 1);

  const continuation = { provider: "claude", value: "session-1" };
  const second = await turn(capture, provider.execute(input({ continuation, model: "sonnet", effort: "low", policy: "autonomous", prompt: "and again" })));
  assert.deepEqual(second, { status: "succeeded" });
  assert.equal(capture.opens, 1, "the warm session answers the second turn, so nothing is spawned or resumed");
  assert.deepEqual(capture.sent, ["inspect the app", "and again"]);
  assert.deepEqual([capture.model, capture.settings, capture.mode], ["sonnet", { effortLevel: "low" }, "auto"]);

  provider.closeAll();
  assert.equal(capture.closed, true);
});

test("a session is only reused for the thread and the conversation it belongs to", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const continuation = { provider: "claude", value: "session-1" };
  await turn(capture, provider.execute(input()), { type: "system", subtype: "init", session_id: "session-1" });

  for (const [reason, overrides] of [
    ["another thread", { taskId: "task-2", continuation }],
    ["a fork of the same session", { continuation, forkContinuation: true }],
    ["a different session", { continuation: { provider: "claude", value: "session-9" } }],
    ["a different checkout", { continuation, workspaceRoot: "/tmp/worktree" }],
  ]) {
    const opens = capture.opens;
    await turn(capture, provider.execute(input(overrides)), { type: "system", subtype: "init", session_id: "session-1" });
    assert.equal(capture.opens, opens + 1, reason);
  }
  provider.closeAll();
});

test("cancelling a turn interrupts it and leaves the session alive", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const abortController = new AbortController();
  const running = provider.execute(input({ abortController }));

  await tick();
  abortController.abort();
  capture.emit({ type: "result", subtype: "success", is_error: false, result: "stopped" });
  assert.deepEqual(await running, { status: "cancelled" });
  assert.equal(capture.interrupted, true);
  assert.equal(capture.closed, undefined, "an interrupted turn does not take the session's processes with it");
  provider.closeAll();
});

test("reading other threads needs no approval, but starting or stopping one does", async () => {
  const asked = [];
  const { canUseTool, mcpServers, systemPrompt, end } = await liveTurn({
    threads: { list: async () => [], read: async () => ({}), wait: async () => ({}), command: async () => ({ thread: null }) },
    authorize: async (intent) => { asked.push(intent.name); return "deny"; },
  });
  assert.equal(mcpServers["aicodingtool-threads"].type, "sdk");
  assert.match(systemPrompt.append, /the aicodingtool-threads tools are the only way to reach them/);
  for (const name of ["mcp__aicodingtool-threads__list_threads", "mcp__aicodingtool-threads__read_thread", "mcp__aicodingtool-threads__wait_for_thread"]) {
    assert.equal((await canUseTool(name, {}, { toolUseID: name })).behavior, "allow", name);
  }
  for (const name of ["mcp__aicodingtool-threads__start_thread", "mcp__aicodingtool-threads__archive_thread", "mcp__aicodingtool-threads__stop_thread"]) {
    assert.equal((await canUseTool(name, {}, { toolUseID: name })).behavior, "deny", name);
  }
  assert.deepEqual(asked, ["mcp__aicodingtool-threads__start_thread", "mcp__aicodingtool-threads__archive_thread", "mcp__aicodingtool-threads__stop_thread"]);
  await end();
});

test("a run with no workspace bridge is offered no thread tools", async () => {
  const capture = {};
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(input());

  assert.equal(capture.options.options.mcpServers?.["aicodingtool-threads"], undefined);
  assert.doesNotMatch(capture.options.options.systemPrompt.append, /aicodingtool-threads/);
});

test("only background tasks that are processes of their own are reported, and the whole set each time", async () => {
  const emitted = [];
  const provider = new ClaudeAgentProvider(queryFactory([
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "bash-1", task_type: "local_bash", description: "npm run dev" },
        { task_id: "agent-1", task_type: "local_agent", description: "Inspect the renderer" },
        { task_id: "watch-1", task_type: "monitor_ws", description: "Deploy events" },
      ],
    },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bash-1", task_type: "local_bash", description: "npm run dev" }] },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));

  await provider.execute(input({ emit: (event) => emitted.push(event) }));
  assert.deepEqual(emitted.filter((event) => event.type === "background.changed"), [
    { type: "background.changed", processes: [
      { id: "bash-1", kind: "shell", description: "npm run dev" },
      { id: "watch-1", kind: "monitor", description: "Deploy events" },
    ] },
    { type: "background.changed", processes: [{ id: "bash-1", kind: "shell", description: "npm run dev" }] },
  ]);
});

test("a workflow keeps reporting between the turns of the session it runs under", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const reported = [];
  const reportWorkflow = (report) => reported.push(report);

  await turn(capture, provider.execute(input({ reportWorkflow })),
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "system", subtype: "task_started", task_type: "local_workflow", task_id: "wf-1", workflow_name: "review-changes", description: "Review changed files" });

  capture.emit({
    type: "system",
    subtype: "task_progress",
    task_id: "wf-1",
    workflow_progress: [
      { type: "workflow_phase", index: 0, title: "Review" },
      { type: "workflow_agent", index: 0, label: "review:bugs", state: "progress", startedAt: 5 },
    ],
    usage: { total_tokens: 1_200, tool_uses: 4 },
  });
  capture.emit({ type: "system", subtype: "task_notification", task_id: "wf-1", status: "completed", summary: "Dynamic workflow completed" });
  await tick();
  await tick();

  assert.deepEqual(reported.map((report) => report.type), [
    "workflow.started",
    "workflow.progress",
    "workflow.finished",
  ], "a workflow with no turn to report under still reports");
  assert.equal(reported[2].status, "completed");

  const continuation = { provider: "claude", value: "session-1" };
  await turn(capture, provider.execute(input({ continuation, reportWorkflow, prompt: "and again" })),
    { type: "system", subtype: "task_started", task_type: "local_workflow", task_id: "wf-2", workflow_name: "migrate", description: "Migrate call sites" });

  assert.equal(capture.opens, 1);
  assert.deepEqual(reported.at(-1), { type: "workflow.started", id: "wf-2", name: "migrate", description: "Migrate call sites" });
  provider.closeAll();
});

test("a session closing under a workflow reports the workflow stopped", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const reported = [];

  await turn(capture, provider.execute(input({ reportWorkflow: (report) => reported.push(report) })),
    { type: "system", subtype: "task_started", task_type: "local_workflow", task_id: "wf-1", workflow_name: "review-changes", description: "Review changed files" });

  provider.closeAll();
  await tick();

  assert.deepEqual(reported.at(-1), { type: "workflow.finished", id: "wf-1", status: "stopped", summary: "" },
    "a workflow the session took with it does not wait on a notification that can never come");
});

test("a background process is stopped through the thread's session, after its run has ended", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));

  assert.equal(provider.stopProcess("task-1", "bash-1"), false, "no session, nothing to stop");
  await turn(capture, provider.execute(input()));
  assert.equal(provider.stopProcess("task-gone", "bash-1"), false);
  assert.equal(provider.stopProcess("task-1", "wf-1"), true, "the session outlives the run, so the workflow it holds is still reachable");
  await tick();
  assert.deepEqual(capture.stopped, ["wf-1"]);
  provider.closeAll();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const running = (...ids) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "local_workflow", description: "Review changed files" })),
});

test("a session with work still running outlives the idle deadline, and is let go once the work stops", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture), 5);

  const { session } = await poolTurn(provider, capture, {}, running("wf-1"));
  await delay(60);
  assert.equal(session.closed, false, "the workflow the turn left running is not on the turn's clock");

  session.emit(running());
  await delay(60);
  assert.equal(session.closed, true, "the session is handed back once nothing is running under it");
});

test("a session with work still running is passed over when the pool has to let one go", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture));

  await poolTurn(provider, capture, {}, running("wf-1"));
  for (const taskId of ["task-2", "task-3", "task-4", "task-5"]) await poolTurn(provider, capture, { taskId });

  const [workflow, oldestIdle] = capture.sessions;
  assert.equal(workflow.closed, false, "the least recently used session is still running a workflow");
  assert.equal(oldestIdle.closed, true, "the pool gives up the oldest session with nothing running instead");
  provider.closeAll();
});

test("work outstanding when a run is cancelled holds the session no longer than the work does", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture), 5);
  const abortController = new AbortController();

  const cancelled = provider.execute(input({ abortController }));
  await tick();
  const [session] = capture.sessions;
  session.emit(running("wf-1"));
  await tick();
  abortController.abort();
  session.emit({ type: "result", subtype: "success", is_error: false, result: "stopped" });
  assert.deepEqual(await cancelled, { status: "cancelled" });

  await delay(60);
  assert.equal(session.closed, false, "cancelling the turn does not cancel what it left running");
  session.emit(running());
  await delay(60);
  assert.equal(session.closed, true, "and the session is not pinned once that work stops");
});

test("a turn that fails gives its session up even with work outstanding", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture), 5);

  const failing = provider.execute(input());
  await tick();
  const [session] = capture.sessions;
  session.emit(running("wf-1"));
  session.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["broke"] });
  assert.deepEqual(await failing, { status: "failed", message: "broke" });
  assert.equal(session.closed, true);

  await poolTurn(provider, capture, { prompt: "and again" });
  assert.equal(capture.sessions.length, 2, "the failed session is not left in the pool to be reused or reaped");
  provider.closeAll();
});

test("quitting closes a session that still has work running", async () => {
  const capture = {};
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture));

  const { session } = await poolTurn(provider, capture, {}, running("wf-1"));
  provider.closeAll();
  assert.equal(session.closed, true);
});
