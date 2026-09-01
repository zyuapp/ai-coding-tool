import type { AppServerCommand, ClientMethod, ClientParams, ClientResult, ExitStatus, IncomingRequest, JsonRpcError, NotificationMethod, NotificationParams, ServerRequestMethod, ServerRequestParams, ServerRequestResult } from "../../src/main/codex/app-server-client.mts";
import type { ClientInfo } from "../../src/main/codex/protocol/ClientInfo.ts";
import type { InitializeResponse } from "../../src/main/codex/protocol/InitializeResponse.ts";
import type { RequestId } from "../../src/main/codex/protocol/RequestId.ts";
import { CodexAgentProvider } from "../../src/main/codex/codex-agent-provider.mts";
import type { CodexClient } from "../../src/main/codex/codex-session.mts";
import type { ReadOrigin } from "../../src/main/codex/codex-thread-record.mts";
import type { ProviderRunInput } from "../../src/main/agent/agent-provider.mts";
import type { BoundTool, ToolResult } from "../../src/main/tools/tool-definition.mts";
import type { ServedTools, ToolHost } from "../../src/main/tools/mcp-http-host.mts";

export type Sent = { method: string; params: unknown };

/** What the fake server answers each method with. A handler may throw or return a promise, as the real server may. */
export type Script = Partial<Record<ClientMethod, (params: never) => unknown>>;

export type Reply<M extends ServerRequestMethod> = { result: ServerRequestResult<M> } | { error: JsonRpcError };

/** Real shapes for the handful of responses the session reads, trimmed to what it reads. */
export const defaultScript: Script = {
  "skills/list": () => ({ data: [{ cwd: "/tmp/project", skills: [], errors: [] }] }),
  "account/read": () => ({ account: { type: "chatgpt", email: "dev@example.com", planType: "pro" }, requiresOpenaiAuth: true }),
  "thread/start": (params: { model?: string | null }) => ({ thread: { id: "thread-1" }, model: params.model ?? "gpt-5.6-sol" }),
  "thread/resume": (params: { threadId: string }) => ({ thread: { id: params.threadId }, model: "gpt-5.6-sol" }),
  "thread/fork": () => ({ thread: { id: "thread-fork" }, model: "gpt-5.6-sol" }),
  "thread/goal/set": (params: { threadId: string; objective: string }) => ({ goal: { threadId: params.threadId, objective: params.objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } }),
  "thread/goal/get": () => ({ goal: null }),
  "thread/goal/clear": () => ({ cleared: true }),
  "thread/inject_items": () => ({}),
  "thread/name/set": () => ({}),
  "thread/metadata/update": () => ({}),
  "thread/unarchive": () => ({}),
  "thread/compact/start": () => ({}),
  "thread/backgroundTerminals/list": () => ({ data: [], nextCursor: null }),
  "thread/backgroundTerminals/terminate": () => ({ terminated: true }),
  "review/start": () => ({
    turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null },
    reviewThreadId: "thread-review",
  }),
  "turn/start": () => ({ turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } }),
  "turn/steer": () => ({ turnId: "turn-1" }),
  "turn/interrupt": () => ({}),
};

export class FakeCodexClient implements CodexClient {
  readonly sent: Sent[] = [];
  readonly exited: Promise<ExitStatus>;
  closed = false;
  private settleExit!: (exit: ExitStatus) => void;
  private readonly handlers = new Map<string, Set<(params: never) => void>>();
  private readonly requestHandlers = new Set<(request: IncomingRequest) => void>();
  private nextServerId = 0;

  constructor(readonly command: AppServerCommand, private readonly script: Script, private readonly handshake: () => Promise<InitializeResponse> = async () => ({ userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" })) {
    this.exited = new Promise((resolve) => { this.settleExit = resolve; });
  }

  initialize(clientInfo: ClientInfo) {
    this.sent.push({ method: "initialize", params: clientInfo });
    return this.handshake();
  }

  request<M extends ClientMethod>(method: M, ...params: ClientParams<M> extends undefined ? [params?: undefined] : [params: ClientParams<M>]): Promise<ClientResult<M>> {
    this.sent.push({ method, params: params[0] });
    const answer = this.script[method];
    if (!answer) return Promise.reject(new Error(`${method} is not scripted`));
    try {
      return Promise.resolve(answer(params[0] as never) as ClientResult<M>);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  on<M extends NotificationMethod>(method: M, handler: (params: NotificationParams<M>) => void) {
    let handlers = this.handlers.get(method);
    if (!handlers) this.handlers.set(method, handlers = new Set());
    handlers.add(handler as (params: never) => void);
    return () => { handlers.delete(handler as (params: never) => void); };
  }

  onRequest(handler: (request: IncomingRequest) => void) {
    this.requestHandlers.add(handler);
    return () => { this.requestHandlers.delete(handler); };
  }

  close() {
    this.closed = true;
    this.settleExit({ code: 0, signal: null, stderr: "" });
    return this.exited;
  }

  /** The server side: a notification, delivered to whoever listens. */
  notify<M extends NotificationMethod>(method: M, params: NotificationParams<M>) {
    for (const handler of this.handlers.get(method) ?? []) handler(params as never);
  }

  /** The server side: a request, resolved with whatever the session answers it. */
  ask<M extends ServerRequestMethod>(method: M, params: ServerRequestParams<M>): Promise<Reply<M>> {
    const id: RequestId = this.nextServerId++;
    return new Promise((resolve) => {
      const request = {
        id,
        method,
        params,
        respond: (result: unknown) => resolve({ result: result as ServerRequestResult<M> }),
        fail: (error: JsonRpcError) => resolve({ error }),
      } as IncomingRequest;
      for (const handler of this.requestHandlers) handler(request);
    });
  }

  /** The server side: the process going away. */
  exit(exit: ExitStatus) {
    this.settleExit(exit);
  }

  /** Every call of one method, in order. */
  calls(method: string) {
    return this.sent.filter((call) => call.method === method).map((call) => call.params);
  }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until the newest client has sent a method, so a test can answer the server's side of it. */
export async function sentBy(client: FakeCodexClient, method: string, count = 1) {
  for (let waited = 0; client.calls(method).length < count; waited += 1) {
    if (waited > 100) throw new Error(`${method} was never sent`);
    await tick();
  }
}

export function input(overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  const base: ProviderRunInput = {
    channel: "main",
    taskId: "task-1",
    title: "Inspect the app",
    prompt: "inspect the app",
    workspaceRoot: "/tmp/project",
    projectless: false,
    computerUse: { status: "unavailable", message: "test" },
    policy: "confirm",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    steering: { next: () => new Promise<null>(() => {}) },
    abortController: new AbortController(),
    authorize: async () => "allow",
    emit() {},
    reportWorkflow() {},
    reportBackground() {},
    reportSubagent() {},
    reportGoal() {},
    beginAgentTurn: () => null,
  };
  return { ...base, ...overrides };
}

/** One set of tools a session asked the host to serve, and whether the session has let it go. */
export type Serving = { token: string; tools: readonly BoundTool[]; released: boolean; call(name: string, args: unknown): Promise<ToolResult> };

/** Stands in for the HTTP host: hands out tokens and remembers which sets are still served. */
export class FakeToolHost implements ToolHost {
  readonly url = "http://127.0.0.1:1/mcp";
  readonly served: Serving[] = [];

  serve(tools: readonly BoundTool[]): Promise<ServedTools> {
    const serving: Serving = {
      token: `token-${this.served.length + 1}`,
      tools,
      released: false,
      call: (name, args) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`${name} is not served`);
        return tool.handler(args as never);
      },
    };
    this.served.push(serving);
    return Promise.resolve({ url: this.url, token: serving.token, release: () => { serving.released = true; } });
  }
}

export type Harness = {
  provider: CodexAgentProvider;
  clients: FakeCodexClient[];
  latest: () => FakeCodexClient;
  host: FakeToolHost;
};

/** A provider whose app servers are scripted fakes, one per session it opens. */
export function harness(script: Script = {}, options: { handshake?: () => Promise<InitializeResponse>; idleMs?: number; readOrigin?: ReadOrigin } = {}): Harness {
  const clients: FakeCodexClient[] = [];
  const host = new FakeToolHost();
  const provider = new CodexAgentProvider({
    connect: (command) => {
      const client = new FakeCodexClient(command, { ...defaultScript, ...script }, options.handshake);
      clients.push(client);
      return client;
    },
    host,
    idleMs: options.idleMs,
    ...(options.readOrigin ? { readOrigin: options.readOrigin } : {}),
  });
  return { provider, clients, latest: () => clients.at(-1)!, host };
}

/** Runs one turn to its completion, delivering the given notifications before the server completes the turn. */
export async function turn(harness: Harness, overrides: Partial<ProviderRunInput> = {}, deliver: (client: FakeCodexClient) => void = () => {}) {
  const earlier = new Map(harness.clients.map((client) => [client, client.calls("turn/start").length]));
  const running = harness.provider.execute(input(overrides));
  const client = await turning(harness, earlier);
  deliver(client);
  completeTurn(client);
  return { client, result: await running };
}

/** Whichever client the run turned on: a new one, or a warm one with a turn/start more than it had. */
async function turning(harness: Harness, earlier: Map<FakeCodexClient, number>) {
  for (let waited = 0; waited <= 100; waited += 1) {
    const client = harness.clients.find((candidate) => candidate.calls("turn/start").length > (earlier.get(candidate) ?? 0));
    if (client) return client;
    await tick();
  }
  throw new Error("turn/start was never sent");
}

/** The client the run just opened or reused, once it exists. */
export async function opened(harness: Harness) {
  for (let waited = 0; harness.clients.length === 0; waited += 1) {
    if (waited > 100) throw new Error("no app server was opened");
    await tick();
  }
  return harness.latest();
}

export function completeTurn(client: FakeCodexClient, status: "completed" | "interrupted" | "failed" = "completed", error: { message: string } | null = null) {
  const started = client.calls("turn/start").at(-1) as { threadId?: string } | undefined;
  client.notify("turn/completed", {
    threadId: started?.threadId ?? "thread-1",
    turn: { id: "turn-1", items: [], itemsView: "summary", status, error: error ? { message: error.message, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null, startedAt: 1, completedAt: 2, durationMs: 1000 },
  });
}
