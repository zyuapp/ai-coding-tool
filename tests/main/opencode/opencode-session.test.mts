import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent, ProviderResult, ProviderRunInput, SteerMessage } from "../../../src/main/agent/agent-provider.mts";
import { OpenCodeAgentProvider } from "../../../src/main/opencode/opencode-agent-provider.mts";
import { formAnswer, questionsOf } from "../../../src/main/opencode/opencode-session.mts";
import { OpenCodeError, type ExitStatus, type OpenCodeClient, type OpenCodeEvent, type ServerOptions } from "../../../src/main/opencode/opencode-server.mts";
import type { ToolHost } from "../../../src/main/tools/mcp-http-host.mts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const MODEL = "openrouter/z-ai/glm-5.3-flash";

type Call = { method: string; path: string; body: unknown };

/** A server that answers from a script and emits whatever the test says it does. */
class FakeServer implements OpenCodeClient {
  readonly calls: Call[] = [];
  readonly listeners = new Set<(event: OpenCodeEvent) => void>();
  readonly exited: Promise<ExitStatus>;
  private exit!: (status: ExitStatus) => void;
  private inbox = 0;
  closed = false;
  missing = new Set<string>();
  empty = new Set<string>();

  constructor(readonly options: ServerOptions) {
    this.exited = new Promise((resolve) => { this.exit = resolve; });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    const answer = (value: unknown) => value as T;
    if (method === "GET" && path.startsWith("/api/model")) return answer([{ id: "z-ai/glm-5.3-flash", providerID: "openrouter", variants: [{ id: "low" }, { id: "high" }, { id: "none" }], limit: { context: 1_000 } }]);
    if (method === "GET" && path.startsWith("/api/skill")) return answer([{ id: "review-thread" }]);
    if (method === "GET" && path.startsWith("/api/command")) return answer([{ name: "init" }]);
    if (method === "POST" && path === "/api/session") return answer({ id: "ses_new" });
    if (method === "GET" && path.startsWith("/api/session/")) {
      const id = path.split("/")[3]!;
      if (this.missing.has(id)) throw new OpenCodeError(404, "SessionNotFoundError", `Session not found: ${id}`);
      return answer({ id, location: { directory: "/tmp/project" } });
    }
    if (method === "POST" && path.endsWith("/fork")) {
      const id = path.split("/")[3]!;
      if (this.empty.has(id)) throw new OpenCodeError(400, "InvalidRequestError", `Cannot fork empty session: ${id}`);
      return answer({ id: "ses_fork", location: { directory: "/tmp/project" } });
    }
    if (method === "POST" && (path.endsWith("/prompt") || path.endsWith("/command"))) return answer({ id: `msg_${++this.inbox}` });
    return answer(undefined);
  }

  subscribe(listener: (event: OpenCodeEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(type: string, data: Record<string, unknown>) {
    for (const listener of this.listeners) listener({ type, data });
  }

  sent(method: string, suffix: string) {
    return this.calls.filter((call) => call.method === method && call.path.endsWith(suffix));
  }

  die(stderr: string) {
    this.exit({ code: 1, signal: null, stderr });
  }

  async close() {
    this.closed = true;
    this.exit({ code: 0, signal: null, stderr: "" });
  }
}

class Steering {
  private queue: (SteerMessage | null)[] = [];
  private waiting: ((message: SteerMessage | null) => void) | null = null;
  next = () => this.queue.length ? Promise.resolve(this.queue.shift()!) : new Promise<SteerMessage | null>((resolve) => { this.waiting = resolve; });
  push(message: SteerMessage | null) {
    if (this.waiting) {
      this.waiting(message);
      this.waiting = null;
    } else this.queue.push(message);
  }
}

const host: ToolHost = { serve: async () => ({ url: "http://127.0.0.1:1/mcp", token: "token-1", release() {} }) };

function setup() {
  const servers: FakeServer[] = [];
  const provider = new OpenCodeAgentProvider({ host, connect: async (options) => { const server = new FakeServer(options); servers.push(server); return server; } });
  return { provider, servers, server: () => servers.at(-1)! };
}

const threads = { list: async () => [], read: async () => { throw new Error("unused"); }, wait: async () => { throw new Error("unused"); }, command: async () => ({ thread: null }) };

function input(overrides: Partial<ProviderRunInput> = {}) {
  const events: ProviderEvent[] = [];
  const steering = new Steering();
  const run: ProviderRunInput = {
    channel: "main", taskId: "task-1", title: "Probe", prompt: "Reply with PONG.", workspaceRoot: "/tmp/project", projectless: false,
    computerUse: { status: "unavailable", message: "test" }, policy: "confirm", engine: "opencode", model: MODEL, effort: "low",
    steering, abortController: new AbortController(),
    authorize: async () => "allow", askQuestion: async () => null,
    emit: (event) => { events.push(event); },
    reportWorkflow() {}, reportBackground() {}, reportSubagent() {}, reportGoal() {}, beginAgentTurn: () => null,
    ...overrides,
  };
  return { run, events, steering };
}

async function settled(promise: Promise<ProviderResult>) {
  let result: ProviderResult | undefined;
  void promise.then((value) => { result = value; });
  for (let waited = 0; waited < 5; waited += 1) await tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return result;
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Opens a session and lets it put its first message in the inbox. */
async function started(overrides: Partial<ProviderRunInput> = {}) {
  const context = setup();
  const run = input(overrides);
  const result = context.provider.execute(run.run);
  await until(() => context.servers.length > 0 && context.server().sent("POST", "/prompt").length + context.server().sent("POST", "/command").length + context.server().sent("POST", "/compact").length > 0, "the first message");
  return { ...context, ...run, result };
}

test("a new session starts on the run's folder, model, depth, mode and tools, then streams its answer and usage", async () => {
  const { server, events, result } = await started({ threads });
  const create = server().calls.find((call) => call.method === "POST" && call.path === "/api/session")!;
  assert.deepEqual(create.body, {
    location: { directory: "/tmp/project" },
    model: { providerID: "openrouter", id: "z-ai/glm-5.3-flash", variant: "low" },
    agent: "build",
    permissions: (create.body as { permissions: unknown }).permissions,
    metadata: { aicodingtool: "task-1" },
  });
  const config = server().options.config as { mcp: Record<string, { url: string; headers: Record<string, string>; codemode: boolean }>; instructions: string[] };
  assert.equal(config.mcp.aicodingtool!.url, "http://127.0.0.1:1/mcp");
  assert.equal(config.mcp.aicodingtool!.headers.Authorization, "Bearer token-1");
  assert.equal(config.mcp.aicodingtool!.codemode, false, "the app's tools are called directly, not through code mode");
  assert.equal(config.instructions.length, 1);
  assert.equal(server().options.cwd, "/tmp/project");
  assert.deepEqual(events[0], { type: "continuation", continuation: { provider: "opencode", value: "ses_new" } });
  assert.deepEqual(server().sent("POST", "/prompt")[0]!.body, { text: "Reply with PONG.", delivery: "queue" });

  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  server().emit("session.text.delta", { sessionID: "ses_new", assistantMessageID: "a1", ordinal: 0, delta: "PO" });
  server().emit("session.text.delta", { sessionID: "ses_new", assistantMessageID: "a1", ordinal: 0, delta: "NG" });
  server().emit("session.text.ended", { sessionID: "ses_new", assistantMessageID: "a1", ordinal: 0, text: "PONG" });
  server().emit("session.step.ended", { sessionID: "ses_new", tokens: { input: 900, output: 10, reasoning: 5, cache: { read: 80, write: 5 } } });
  server().emit("session.text.delta", { sessionID: "ses_other", assistantMessageID: "x", ordinal: 0, delta: "not ours" });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  assert.deepEqual(await settled(result), { status: "succeeded" });
  const shown = events.filter((event) => event.type === "assistant").map((event) => event.text).join("");
  assert.equal(shown, "PONG");
  assert.deepEqual(events.find((event) => event.type === "usage"), { type: "usage", tokens: 1_000, limit: 1_000, model: MODEL });
  assert.deepEqual(events.find((event) => event.type === "spend"), { type: "spend", tokens: 1_000 });
});

test("an effort the model offers no variant for is not sent, and a model with none takes none", async () => {
  const { server } = await started({ effort: "medium" });
  const create = server().calls.find((call) => call.method === "POST" && call.path === "/api/session")!;
  assert.deepEqual((create.body as { model: unknown }).model, { providerID: "openrouter", id: "z-ai/glm-5.3-flash" });
});

test("a turn ends with the execution that took its last message, so a steered message is answered before it settles", async () => {
  const { server, events, steering, result } = await started();
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  steering.push({ messageId: "steer-1", prompt: "And say BANANA." });
  await until(() => server().sent("POST", "/prompt").length === 2, "the steered message");
  assert.deepEqual(server().sent("POST", "/prompt")[1]!.body, { text: "And say BANANA.", delivery: "steer" });
  assert.ok(events.some((event) => event.type === "steered" && event.messageId === "steer-1"));
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  assert.equal(await settled(result), undefined, "the steered message is still waiting");
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_2" });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  assert.deepEqual(await settled(result), { status: "succeeded" });
});

test("a message the server takes before it answers the send is not waited on", async () => {
  /** A server that has taken and finished a message by the time it answers the send. */
  class Racing extends FakeServer {
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const answer = await super.request<T>(method, path, body);
      if (path.endsWith("/prompt")) {
        this.emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
        this.emit("session.execution.succeeded", { sessionID: "ses_new" });
      }
      return answer;
    }
  }
  const provider = new OpenCodeAgentProvider({ host, connect: async (options) => new Racing(options) });
  assert.deepEqual(await provider.execute(input().run), { status: "succeeded" });
});

test("a tool call is shown as it was made, and the approval the rules ask for is put to the run as that call", async () => {
  const asked: unknown[] = [];
  let answer: "allow" | "deny" = "allow";
  const { server, events } = await started({ authorize: async (intent) => { asked.push(intent); return answer; } });
  server().emit("session.tool.input.started", { sessionID: "ses_new", id: "call-1", name: "write" });
  server().emit("session.tool.called", { sessionID: "ses_new", id: "call-1", input: { path: "notes.md", content: "hi" } });
  const intent = { toolId: "call-1", name: "write", input: { path: "notes.md", content: "hi" }, writePath: "/tmp/project/notes.md" };
  assert.deepEqual(events.find((event) => event.type === "tool"), { type: "tool", intent });
  server().emit("permission.asked", { id: "per_1", sessionID: "ses_new", action: "edit", resources: ["notes.md"], source: { type: "tool", id: "call-1" } });
  await until(() => server().sent("POST", "/reply").length === 1, "the reply");
  assert.deepEqual(asked, [intent]);
  assert.equal(server().sent("POST", "/reply")[0]!.path, "/api/session/ses_new/permission/per_1/reply");
  assert.deepEqual(server().sent("POST", "/reply")[0]!.body, { decision: "once" });
  answer = "deny";
  server().emit("session.tool.input.started", { sessionID: "ses_new", id: "call-2", name: "aicodingtool_start_thread" });
  server().emit("session.tool.called", { sessionID: "ses_new", id: "call-2", input: { prompt: "go" } });
  server().emit("permission.asked", { id: "per_2", sessionID: "ses_new", action: "aicodingtool_start_thread", resources: ["*"], source: { type: "tool", id: "call-2" } });
  await until(() => server().sent("POST", "/reply").length === 2, "the second reply");
  assert.deepEqual(server().sent("POST", "/reply")[1]!.body, { decision: "reject" });
  assert.equal((asked[1] as { name: string }).name, "start_thread", "the app's own tools are named as the app names them");
});

test("a denial that says why is rejected with its reason", async () => {
  const { server } = await started({ authorize: async () => ({ deny: "Nobody is watching this scheduled run." }) });
  server().emit("permission.asked", { id: "per_r", sessionID: "ses_new", action: "shell", resources: ["rm -rf build"] });
  await until(() => server().sent("POST", "/reply").length === 1, "the reply");
  assert.deepEqual(server().sent("POST", "/reply")[0]!.body, { decision: "reject", message: "Nobody is watching this scheduled run." });
});

test("a subagent's session is answered for too, and a stranger's is left alone", async () => {
  const { server } = await started();
  server().emit("session.created", { sessionID: "ses_child", parentID: "ses_new" });
  server().emit("permission.asked", { id: "per_c", sessionID: "ses_child", action: "shell", resources: ["ls"] });
  server().emit("permission.asked", { id: "per_x", sessionID: "ses_stranger", action: "shell", resources: ["ls"] });
  await until(() => server().sent("POST", "/reply").length === 1, "the child's reply");
  await tick();
  assert.deepEqual(server().sent("POST", "/reply").map((call) => call.path), ["/api/session/ses_child/permission/per_c/reply"]);
});

test("a form is asked as the composer's questions and answered in each field's own type", async () => {
  const form = {
    id: "frm_1", sessionID: "ses_new", title: "Questions",
    fields: [
      { key: "color", type: "string", title: "Color", description: "Which color?", options: [{ value: "r", label: "Red" }, { value: "b", label: "Blue" }] },
      { key: "sure", type: "boolean", title: "Sure?" },
      { key: "count", type: "integer", title: "How many?" },
      { key: "langs", type: "multiselect", title: "Languages", options: [{ value: "ts", label: "TypeScript" }, { value: "go", label: "Go" }] },
    ],
  };
  const request = questionsOf(form);
  assert.deepEqual(request?.questions[0], { id: "color", header: "Color", question: "Which color?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] });
  assert.deepEqual(request?.questions[1]?.options.map((option) => option.label), ["Yes", "No"]);
  assert.deepEqual(formAnswer(form, { color: "Blue", sure: "Yes", count: "3", langs: "TypeScript, Go" }), { color: "b", sure: true, count: 3, langs: ["ts", "go"] });
  assert.equal(questionsOf({ ...form, fields: [{ key: "link", type: "external" }] }), null, "a link nobody can answer in chat is not asked");

  let answers: Record<string, string> | null = { color: "Red", sure: "No", count: "1", langs: "Go" };
  const { server } = await started({ askQuestion: async () => answers });
  server().emit("form.created", { form });
  await until(() => server().sent("POST", "/form/frm_1/reply").length === 1, "the answer");
  assert.deepEqual(server().sent("POST", "/form/frm_1/reply")[0]!.body, { answer: { color: "r", sure: false, count: 1, langs: ["go"] } });
  answers = null;
  server().emit("form.created", { form: { ...form, id: "frm_2" } });
  await until(() => server().sent("DELETE", "/form/frm_2").length === 1, "the withdrawal");
});

test("a cancelled run interrupts the session, and the server's interruption ends it", async () => {
  const { server, run, result } = await started();
  run.abortController.abort();
  await until(() => server().sent("POST", "/interrupt").length === 1, "the interrupt");
  server().emit("session.execution.interrupted", { sessionID: "ses_new" });
  assert.deepEqual(await settled(result), { status: "cancelled" });
});

test("a failed execution fails the run with what the server said", async () => {
  const { server, result } = await started();
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  server().emit("session.execution.failed", { sessionID: "ses_new", error: { message: "Provider rejected the key" } });
  assert.deepEqual(await settled(result), { status: "failed", message: "Provider rejected the key" });
});

test("compaction is the session's own operation, and the run settles when it ends", async () => {
  const { server, events, result } = await started({ prompt: "", operation: { type: "compact", preTokens: 4_000 }, continuation: { provider: "opencode", value: "ses_old" } });
  assert.equal(server().sent("POST", "/compact")[0]!.path, "/api/session/ses_old/compact");
  server().emit("session.compaction.started", { sessionID: "ses_old" });
  server().emit("session.execution.succeeded", { sessionID: "ses_old" });
  assert.equal(await settled(result), undefined, "an execution ending is not the compaction ending");
  server().emit("session.compaction.ended", { sessionID: "ses_old" });
  assert.deepEqual(await settled(result), { status: "succeeded" });
  assert.deepEqual(events.filter((event) => event.type.startsWith("compaction")), [
    { type: "compaction-status", compacting: true },
    { type: "compaction", trigger: "manual", preTokens: 4_000 },
    { type: "compaction-status", compacting: false },
  ]);
});

test("a continuation resumes its session, a fork starts its own, and one the server lost says so", async () => {
  const resumed = await started({ continuation: { provider: "opencode", value: "ses_old" } });
  assert.equal(resumed.server().calls.some((call) => call.method === "POST" && call.path === "/api/session"), false);
  assert.equal(resumed.server().sent("POST", "/prompt")[0]!.path, "/api/session/ses_old/prompt");

  const forked = await started({ continuation: { provider: "opencode", value: "ses_old" }, forkContinuation: true });
  assert.deepEqual(forked.events[0], { type: "continuation", continuation: { provider: "opencode", value: "ses_fork" } });
  assert.equal(forked.server().sent("POST", "/prompt")[0]!.path, "/api/session/ses_fork/prompt");

  const context = setup();
  const lost = input({ continuation: { provider: "opencode", value: "ses_gone" } });
  const lostProvider = new OpenCodeAgentProvider({ host, connect: async (options) => { const server = new FakeServer(options); server.missing.add("ses_gone"); context.servers.push(server); return server; } });
  const result = await lostProvider.execute(lost.run);
  assert.equal(result.status, "failed");
  assert.match(result.message ?? "", /could not continue this session/);
  assert.ok(lost.events.some((event) => event.type === "continuation-lost"));
});

test("a side chat starts behind the boundary that keeps the parent's work the parent's", async () => {
  const { server } = await started({ channel: "side" });
  const boundary = server().sent("POST", "/synthetic")[0]!;
  assert.equal(boundary.path, "/api/session/ses_new/synthetic");
  assert.equal((boundary.body as { resume: boolean }).resume, false);
});

test("a warm session is moved only on what changed between turns", async () => {
  const { provider, server } = setup();
  const first = input();
  const one = provider.execute(first.run);
  await until(() => server()?.sent("POST", "/prompt").length === 1, "the first prompt");
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  await one;
  const second = input({ continuation: { provider: "opencode", value: "ses_new" }, effort: "high", policy: "bypass" });
  const two = provider.execute(second.run);
  await until(() => server().sent("POST", "/prompt").length === 2, "the second prompt");
  assert.deepEqual(server().sent("POST", "/model").at(-1)!.body, { model: { providerID: "openrouter", id: "z-ai/glm-5.3-flash", variant: "high" } });
  assert.equal(server().sent("POST", "/agent").length, 1, "the agent was set once and the mode keeps it");
  assert.deepEqual((server().sent("PATCH", "/ses_new").at(-1)!.body as { permissions: unknown[] }).permissions[0], { action: "*", resource: "*", effect: "allow" });
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_2" });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  assert.deepEqual(await two, { status: "succeeded" });
  const plan = input({ continuation: { provider: "opencode", value: "ses_new" }, effort: "high", policy: "plan" });
  const three = provider.execute(plan.run);
  await until(() => server().sent("POST", "/prompt").length === 3, "the third prompt");
  assert.deepEqual(server().sent("POST", "/agent").at(-1)!.body, { agent: "plan" });
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_3" });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  await three;
});

test("a slash command runs as the server's command, and a skill named in a prompt is loaded with it", async () => {
  const command = await started({ prompt: "/init add tests" });
  assert.deepEqual(command.server().sent("POST", "/command")[0]!.body, { name: "init", text: "add tests", delivery: "queue" });
  const skill = await started({ prompt: "/review-thread opus high" });
  assert.deepEqual(skill.server().sent("POST", "/prompt")[0]!.body, { text: "/review-thread opus high", skills: [{ id: "review-thread" }], delivery: "queue" });
  const path = await started({ prompt: "Read /review-thread/SKILL.md" });
  assert.deepEqual(path.server().sent("POST", "/prompt")[0]!.body, { text: "Read /review-thread/SKILL.md", delivery: "queue" }, "a path that starts with a skill's name loads no skill");
});

test("a session closed while its server starts closes that server once it is up", async () => {
  let up!: () => void;
  const starting = new Promise<void>((resolve) => { up = resolve; });
  const servers: FakeServer[] = [];
  const provider = new OpenCodeAgentProvider({ host, connect: async (options) => { await starting; const server = new FakeServer(options); servers.push(server); return server; } });
  const run = input();
  const result = provider.execute(run.run);
  await new Promise((resolve) => setTimeout(resolve, 20));
  provider.closeAll();
  up();
  await settled(result);
  await until(() => servers.length === 1 && servers[0]!.closed, "the late server closing");
});

test("a model whose context window the server does not say reports its spend, and no usage against a window of nothing", async () => {
  const { server, events, result } = await started({ model: "openrouter/unlisted" });
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  server().emit("session.step.ended", { sessionID: "ses_new", tokens: { input: 900, output: 10, reasoning: 5, cache: { read: 80, write: 5 } } });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  assert.deepEqual(await settled(result), { status: "succeeded" });
  assert.deepEqual(events.find((event) => event.type === "spend"), { type: "spend", tokens: 1_000 });
  assert.equal(events.some((event) => event.type === "usage"), false);
});

test("a server that dies mid-turn fails the run, and closing the provider stops every server", async () => {
  const { provider, server, result } = await started();
  server().die("panic: out of memory");
  assert.deepEqual(await settled(result), { status: "failed", message: "OpenCode stopped: panic: out of memory" });
  const again = await started();
  again.provider.closeAll();
  await tick();
  assert.equal(again.server().closed, true);
  provider.closeAll();
});

test("a session taken into another checkout is moved there, and one already there is left where it is", async () => {
  const same = await started({ continuation: { provider: "opencode", value: "ses_old" } });
  assert.equal(same.server().sent("POST", "/move").length, 0);
  const worktree = await started({ continuation: { provider: "opencode", value: "ses_old" }, forkContinuation: true, workspaceRoot: "/tmp/project-wt" });
  assert.deepEqual(worktree.server().sent("POST", "/move").map((call) => [call.path, call.body]), [["/api/session/ses_fork/move", { directory: "/tmp/project-wt" }]]);
  assert.equal(worktree.server().sent("POST", "/prompt")[0]!.path, "/api/session/ses_fork/prompt");
});

test("a fork of a session with nothing in it starts afresh", async () => {
  const context = setup();
  const provider = new OpenCodeAgentProvider({ host, connect: async (options) => { const server = new FakeServer(options); server.empty.add("ses_blank"); context.servers.push(server); return server; } });
  const run = input({ continuation: { provider: "opencode", value: "ses_blank" }, forkContinuation: true });
  void provider.execute(run.run);
  await until(() => context.servers.at(-1)?.sent("POST", "/prompt").length === 1, "the prompt");
  assert.ok(context.servers.at(-1)!.calls.some((call) => call.method === "POST" && call.path === "/api/session"));
  assert.deepEqual(run.events[0], { type: "continuation", continuation: { provider: "opencode", value: "ses_new" } });
});

test("a server whose events stop arriving fails the turn and is let go, so the next run starts afresh", async () => {
  const { server, provider, result } = await started();
  server().emit("aicodingtool.feed.ended", {});
  assert.deepEqual(await result, { status: "failed", message: "OpenCode stopped sending events" });
  await until(() => server().closed, "the server closing");
  const next = input();
  void provider.execute(next.run);
  await until(() => next.events.some((event) => event.type === "continuation"), "a new session");
});

test("a feed lost because its server died reports what the server died of", async () => {
  const { server, result } = await started();
  server().emit("aicodingtool.feed.ended", {});
  server().die("Error: invalid config: mcp.app.url is not a URL");
  assert.deepEqual(await result, { status: "failed", message: "OpenCode stopped: Error: invalid config: mcp.app.url is not a URL" });
});

test("archiving files the session on the thread's own server and lets its warm session go; with none, a server is started for it alone", async () => {
  const warm = await started();
  warm.server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  warm.server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  await warm.result;
  const opened = warm.servers.length;
  assert.equal(warm.provider.archiveThread("task-1", { provider: "opencode", value: "ses_new" }, true), true);
  await until(() => warm.server().closed, "the warm session going");
  assert.equal(warm.servers.length, opened, "no server was started to file it");
  assert.deepEqual(warm.server().sent("PATCH", "/ses_new").at(-1)!.body, { archived: true });

  const cold = setup();
  assert.equal(cold.provider.archiveThread("task-9", { provider: "opencode", value: "ses_old" }, false), true);
  await until(() => cold.servers.length === 1 && cold.server().closed, "a server started and stopped for it");
  assert.deepEqual(cold.server().sent("PATCH", "/ses_old")[0]!.body, { archived: false });
  assert.equal(cold.provider.archiveThread("task-9", { provider: "codex", value: "thread-1" }, true), false, "another engine's thread is not this one's to file");
  assert.equal(cold.provider.archiveThread("task-8", undefined, true), false, "a thread with no session has nothing to file");
});

test("a run waits for its thread's filing to land before it starts", async () => {
  const { provider, servers } = setup();
  provider.archiveThread("task-1", { provider: "opencode", value: "ses_old" }, false);
  const run = input({ continuation: { provider: "opencode", value: "ses_old" } });
  void provider.execute(run.run);
  await until(() => servers.length === 2 && servers[1]!.sent("POST", "/prompt").length === 1, "the run's prompt");
  assert.equal(servers[0]!.closed, true, "the filing's server was done before the run's started");
});

test("a thread archived before its session was saved is filed under the session it has", async () => {
  const { provider, server, result } = await started();
  assert.equal(provider.archiveThread("task-1", undefined, true), true);
  await until(() => server().sent("PATCH", "/ses_new").some((call) => (call.body as { archived?: boolean }).archived === true), "the filing");
  assert.equal(server().closed, false, "the session waits out the turn it is answering");
  server().emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_1" });
  server().emit("session.execution.succeeded", { sessionID: "ses_new" });
  await result;
  await until(() => server().closed, "the warm session going once its turn answered");
});
