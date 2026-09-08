import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { codexExecutable } from "./codex-executable.mjs";
import { toml } from "./codex-config.mjs";
import { codexChildEnvironment, sharedCodexHome, PRIVATE_CODEX_HOME_ENV } from "./codex-home.mjs";
import { encryptedMcpCredentials, privateHomeConfig, readHomeConfig, usesSharedKeyring } from "./codex-home-config.mjs";
import { acquireSharedAuth } from "./codex-shared-auth.mjs";
import type { ClientInfo } from "./protocol/ClientInfo.js";
import type { ClientRequest } from "./protocol/ClientRequest.js";
import type { InitializeCapabilities } from "./protocol/InitializeCapabilities.js";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { RequestId } from "./protocol/RequestId.js";
import type { ServerNotification } from "./protocol/ServerNotification.js";
import type { ServerRequest } from "./protocol/ServerRequest.js";
import type { CommandExecutionRequestApprovalResponse } from "./protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./protocol/v2/FileChangeRequestApprovalResponse.js";
import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse.js";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "./protocol/v2/LoginAccountResponse.js";
import type { McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse.js";
import type { PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse.js";
import type { ReviewStartResponse } from "./protocol/v2/ReviewStartResponse.js";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.js";
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse.js";
import type { ThreadGoalClearResponse } from "./protocol/v2/ThreadGoalClearResponse.js";
import type { ThreadGoalGetResponse } from "./protocol/v2/ThreadGoalGetResponse.js";
import type { ThreadGoalSetResponse } from "./protocol/v2/ThreadGoalSetResponse.js";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.js";
import type { ToolRequestUserInputResponse } from "./protocol/v2/ToolRequestUserInputResponse.js";
import type { TurnInterruptResponse } from "./protocol/v2/TurnInterruptResponse.js";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.js";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse.js";

/** Experimental requests enabled by this client but omitted from the generator's default output. */
type BackgroundTerminalRequest =
  | { method: "thread/backgroundTerminals/list"; id: RequestId; params: { threadId: string; cursor?: string | null; limit?: number | null } }
  | { method: "thread/backgroundTerminals/terminate"; id: RequestId; params: { threadId: string; processId: string } };

export type BackgroundTerminal = {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: bigint | null;
};

type AppClientRequest = ClientRequest | BackgroundTerminalRequest;

export type ClientMethod = AppClientRequest["method"];
export type ClientParams<M extends ClientMethod> = Extract<AppClientRequest, { method: M }>["params"];

/** The generator pairs no response with its request; this table does, for the methods the app calls. */
export interface ClientResponses {
  initialize: InitializeResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/fork": ThreadForkResponse;
  "thread/goal/set": ThreadGoalSetResponse;
  "thread/goal/get": ThreadGoalGetResponse;
  "thread/goal/clear": ThreadGoalClearResponse;
  "turn/start": TurnStartResponse;
  "turn/steer": TurnSteerResponse;
  "turn/interrupt": TurnInterruptResponse;
  "thread/backgroundTerminals/list": { data: BackgroundTerminal[]; nextCursor: string | null };
  "thread/backgroundTerminals/terminate": { terminated: boolean };
  "review/start": ReviewStartResponse;
  "skills/list": SkillsListResponse;
  "account/read": GetAccountResponse;
  "account/rateLimits/read": GetAccountRateLimitsResponse;
  "account/login/start": LoginAccountResponse;
}
export type ClientResult<M extends ClientMethod> = M extends keyof ClientResponses ? ClientResponses[M] : unknown;

export type NotificationMethod = ServerNotification["method"];
export type NotificationParams<M extends NotificationMethod> = Extract<ServerNotification, { method: M }>["params"];

export type ServerRequestMethod = ServerRequest["method"];
export type ServerRequestParams<M extends ServerRequestMethod> = Extract<ServerRequest, { method: M }>["params"];
export interface ServerRequestResponses {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponse;
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponse;
  "item/permissions/requestApproval": PermissionsRequestApprovalResponse;
  "item/tool/requestUserInput": ToolRequestUserInputResponse;
  "mcpServer/elicitation/request": McpServerElicitationRequestResponse;
}
export type ServerRequestResult<M extends ServerRequestMethod> = M extends keyof ServerRequestResponses ? ServerRequestResponses[M] : unknown;

export type JsonRpcError = { code: number; message: string; data?: unknown };

/** A request the server sent us. Exactly one of `respond` and `fail` must be called, once. */
export type IncomingRequest = {
  [M in ServerRequestMethod]: {
    id: RequestId;
    method: M;
    params: ServerRequestParams<M>;
    respond(result: ServerRequestResult<M>): void;
    fail(error: JsonRpcError): void;
  };
}[ServerRequestMethod];

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

export type AppServerCommand = { executable: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv; sharedAuth?: AppServerCommand };

/** The server answered a request with a JSON-RPC error. */
export class AppServerError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${message}`);
    this.name = "AppServerError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/** The server process is gone, so no request can be answered. */
export class AppServerExited extends Error {
  readonly exit: ExitStatus;
  constructor(exit: ExitStatus, context: string) {
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
    super(`Codex app server exited with ${how} ${context}${exit.stderr ? `\n${exit.stderr}` : ""}`);
    this.name = "AppServerExited";
    this.exit = exit;
  }
}

const NEWLINE = 10;
const STDERR_KEEP = 16 * 1024;
/** How long after `exit` the stdio pipes get to drain before the client stops waiting for them. */
const DRAIN_MS = 250;
const KILL_GRACE_MS = 2_000;
const METHOD_NOT_FOUND = -32601;

type Pending = { method: string; resolve(result: unknown): void; reject(error: Error): void };

/** How the app introduces itself to the server. */
export const CLIENT_INFO: ClientInfo = { name: "aicodingtool", title: "AICodingTool", version: "1" };

/** Account operations keep the user's home; conversation processes use the app's private state. */
export async function codexAppServer(args: readonly string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv; sharedHome?: boolean } = {}): Promise<AppServerCommand> {
  const environment = options.env ?? process.env;
  const env = options.sharedHome ? environment : await codexChildEnvironment(environment);
  const storage = !options.sharedHome && environment[PRIVATE_CODEX_HOME_ENV] ? [
    "-c", `sqlite_home=${toml(env.CODEX_HOME!)}`,
    "-c", `log_dir=${toml(`${env.CODEX_HOME}/log`)}`,
  ] : [];
  const executable = codexExecutable();
  if (!storage.length) return { executable, args: ["app-server", "--listen", "stdio://", ...args], cwd: options.cwd, env };
  const source = await realpath(sharedCodexHome(environment));
  const config = await readHomeConfig(source);
  if (encryptedMcpCredentials(config) && await stat(path.join(source, "secrets", "mcp_oauth.age")).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) {
    throw new Error("Codex's encrypted MCP credential store cannot be shared across homes. Configure mcp_oauth_credentials_store = \"file\" in your Codex config and reconnect those MCP servers before using them in AICodingTool.");
  }
  const keyring = usesSharedKeyring(config);
  const sharedAuth = keyring ? {
    executable, cwd: source, env: { ...environment, CODEX_HOME: source, CODEX_SQLITE_HOME: env.CODEX_HOME },
    args: ["app-server", "--listen", "stdio://", "--disable", "plugins", "--disable", "apps", "--disable", "hooks", ...storage],
  } : undefined;
  return { executable, args: ["app-server", "--listen", "stdio://", ...privateHomeConfig(config, source, env.CODEX_HOME!), ...args,
    ...(keyring ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : []), ...storage], cwd: options.cwd, env, ...(sharedAuth ? { sharedAuth } : {}) };
}

/** Keeps the newest bytes a stream produced, dropping whole chunks from the front. */
class TailBuffer {
  private readonly keep: number;
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(keep: number) {
    this.keep = keep;
  }

  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.chunks.length > 1 && this.bytes > this.keep) this.bytes -= this.chunks.shift()!.length;
  }

  text() {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8").trim();
  }
}

/**
 * One newline-delimited JSON-RPC 2.0 conversation with an app server process. Client requests are
 * answered by id; server requests reach `onRequest` handlers and must be answered through the
 * `IncomingRequest` they receive; notifications reach `on` handlers. The child exiting rejects
 * everything still pending.
 */
export class AppServerClient {
  readonly exited: Promise<ExitStatus>;
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<(params: never) => void>>();
  private readonly requestHandlers = new Set<(request: IncomingRequest) => void>();
  private readonly stderr = new TailBuffer(STDERR_KEEP);
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private nextId = 1;
  private exit: ExitStatus | undefined;
  private settleExit!: (exit: ExitStatus) => void;
  private sharedAuth: Awaited<ReturnType<typeof acquireSharedAuth>> | undefined;
  private authClosed: Promise<void> | undefined;
  private readonly sharedAuthCommand: AppServerCommand | undefined;

  constructor(command: AppServerCommand) {
    this.sharedAuthCommand = command.sharedAuth;
    this.exited = new Promise((resolve) => { this.settleExit = resolve; });
    /** Its own process group, so closing reaches what the server started under itself as well. */
    this.child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    this.child.stdin!.on("error", () => {});
    let drain: NodeJS.Timeout | undefined;
    this.child.on("exit", (code, signal) => {
      drain = setTimeout(() => this.finish(code, signal), DRAIN_MS);
      drain.unref();
    });
    this.child.on("close", (code, signal) => {
      clearTimeout(drain);
      this.finish(code, signal);
    });
    this.child.on("error", (error) => {
      this.stderr.push(Buffer.from(`${error.message}\n`));
      this.finish(null, null);
    });
  }

  /** The `initialize` / `initialized` handshake the server needs before any other method. */
  async initialize(clientInfo: ClientInfo, capabilities: InitializeCapabilities = { experimentalApi: true, requestAttestation: false }) {
    const server = await this.request("initialize", { clientInfo, capabilities });
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    if (this.sharedAuthCommand) {
      try {
        const auth = await acquireSharedAuth(this.sharedAuthCommand, (command) => new AppServerClient(command));
        if (this.exit) { await auth.release(); throw new AppServerExited(this.exit, "during authentication"); }
        this.sharedAuth = auth;
        const login = await auth.read();
        if (login) await this.request("account/login/start", login);
      } catch (error) { await this.close(); throw error; }
    }
    return server;
  }

  request<M extends ClientMethod>(method: M, ...params: ClientParams<M> extends undefined ? [params?: undefined] : [params: ClientParams<M>]): Promise<ClientResult<M>> {
    if (this.exit) return Promise.reject(new AppServerExited(this.exit, `before ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params: params[0] });
    });
  }

  on<M extends NotificationMethod>(method: M, handler: (params: NotificationParams<M>) => void) {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) this.notificationHandlers.set(method, handlers = new Set());
    handlers.add(handler as (params: never) => void);
    return () => { handlers.delete(handler as (params: never) => void); };
  }

  /** Server requests with no handler are refused with a method-not-found error so the server never waits on us. */
  onRequest(handler: (request: IncomingRequest) => void) {
    this.requestHandlers.add(handler);
    return () => { this.requestHandlers.delete(handler); };
  }

  /** Ends the conversation and, with it, the process group: a healthy server leaves on its own, the rest is signalled. */
  async close() {
    if (!this.exit) {
      this.child.stdin!.end();
      this.signal("SIGTERM");
      const kill = setTimeout(() => this.signal("SIGKILL"), KILL_GRACE_MS);
      kill.unref();
      await this.exited;
      clearTimeout(kill);
    }
    await this.authClosed;
    return this.exited;
  }

  private signal(signal: NodeJS.Signals) {
    const { pid } = this.child;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      this.child.kill(signal);
    }
  }

  private send(message: object) {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  /** Frames lines out of raw chunks; an unfinished line stays as chunk slices until its newline arrives. */
  private receive(chunk: Buffer) {
    let start = 0;
    for (let newline = chunk.indexOf(NEWLINE); newline !== -1; newline = chunk.indexOf(NEWLINE, start)) {
      const tail = chunk.subarray(start, newline);
      const line = this.partial.length ? Buffer.concat([...this.partial, tail], this.partialBytes + tail.length) : tail;
      this.partial = [];
      this.partialBytes = 0;
      this.handleLine(line);
      start = newline + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.partial.push(rest);
      this.partialBytes += rest.length;
    }
  }

  private handleLine(line: Buffer) {
    if (line.length === 0) return;
    let message: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: JsonRpcError };
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (typeof message.method === "string") {
      if (message.id === undefined) this.dispatchNotification(message.method, message.params);
      else this.dispatchRequest(message.id, message.method, message.params);
    } else if (typeof message.id === "number") {
      this.settle(message.id, message);
    }
  }

  private settle(id: number, message: { result?: unknown; error?: JsonRpcError }) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) pending.reject(new AppServerError(pending.method, message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  private dispatchNotification(method: string, params: unknown) {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) handler(params as never);
  }

  private dispatchRequest(id: RequestId, method: string, params: unknown) {
    let answered = false;
    const reply = (body: { result: unknown } | { error: JsonRpcError }) => {
      if (answered) return;
      answered = true;
      if (!this.exit) this.send({ jsonrpc: "2.0", id, ...body });
    };
    const request = {
      id,
      method,
      params,
      respond: (result: unknown) => reply({ result }),
      fail: (error: JsonRpcError) => reply({ error }),
    } as IncomingRequest;
    if (method === "account/chatgptAuthTokens/refresh" && this.sharedAuth) {
      void this.sharedAuth.read(true).then((login) => {
        if (login?.type !== "chatgptAuthTokens") throw new Error("The shared Codex account is no longer signed into ChatGPT.");
        const previous = (params as { previousAccountId?: string | null } | undefined)?.previousAccountId;
        if (previous && previous !== login.chatgptAccountId) throw new Error("The shared Codex account changed. Start a new run to use that account.");
        reply({ result: { accessToken: login.accessToken, chatgptAccountId: login.chatgptAccountId, chatgptPlanType: login.chatgptPlanType ?? null } });
      }).catch(() => reply({ error: { code: -32603, message: "Could not refresh the shared Codex account. Check Codex sign-in and start a new run." } }));
      return;
    }
    if (this.requestHandlers.size === 0) {
      request.fail({ code: METHOD_NOT_FOUND, message: `No handler for ${method}` });
      return;
    }
    for (const handler of this.requestHandlers) handler(request);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exit) return;
    if (this.partialBytes > 0) this.receive(Buffer.from("\n"));
    this.exit = { code, signal, stderr: this.stderr.text() };
    this.authClosed = this.sharedAuth?.release();
    this.sharedAuth = undefined;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new AppServerExited(this.exit, `while ${pending.method} was pending`));
    }
    this.settleExit(this.exit);
  }
}

export const connectAppServer = (command: AppServerCommand) => new AppServerClient(command);
