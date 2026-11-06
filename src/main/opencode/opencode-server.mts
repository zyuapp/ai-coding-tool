import { spawn, type ChildProcess } from "node:child_process";
import { engineBinaryPath } from "../agent/engine-binary.mjs";

/** Long enough for a cold start that loads the model catalogue, short enough that a stuck one is noticed. */
const START_TIMEOUT_MS = 30_000;
/** How long a server asked to stop has before it is killed. */
const STOP_GRACE_MS = 5_000;
/** No request the app makes waits on a model, so one that takes this long is stuck. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How the server says where it listens and the password it made up. */
const LISTENING = /listening on (https?:\/\/\S+)/i;
const PASSWORD = /server password (\S+)/i;
/** The stderr kept for a failure, enough for the error a server dies with. */
const STDERR_LIMIT = 8_192;

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

/** One frame of the server's event feed: a type, and what it carries. */
export type OpenCodeEvent = { type: string; data?: Record<string, unknown> };

/** Told to every listener when the feed ends while the server is still meant to be up, after which nothing it does is heard. */
export const FEED_ENDED = "aicodingtool.feed.ended";

/** A request the server answered with an error, kept with the tag OpenCode gave it. */
export class OpenCodeError extends Error {
  constructor(readonly status: number, readonly tag: string | undefined, message: string) {
    super(message);
  }
}

export class OpenCodeExited extends Error {
  constructor(readonly exit: ExitStatus) {
    super(firstLine(exit.stderr) || (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`));
  }
}

/**
 * For a server that never said how to reach it in words this build reads: the last line that names
 * what is still missing, where it listens or its password, in other words. None for a slow start.
 */
export function unreadLine(output: string) {
  const missing = [...LISTENING.test(output) ? [] : [/listening/i], ...PASSWORD.test(output) ? [] : [/password/i]];
  return output.split("\n").filter((line) => missing.some((word) => word.test(line))).at(-1)?.trim();
}

/** What to say of a server that started but said how to reach it in words this build cannot read. */
function unreadStartup(line: string) {
  return `OpenCode started, but this version of the app cannot read how to reach it ("${line}"). Update AI Coding Tool, or use the OpenCode version it was built for.`;
}

function firstLine(text: string) {
  return text.trim().split("\n", 1)[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a client asks of a server. The real one fits; a scripted one can stand in for it. */
export type OpenCodeClient = {
  request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  /** Calls `listener` for every event until the server goes; the returned function stops listening. */
  subscribe(listener: (event: OpenCodeEvent) => void): () => void;
  readonly exited: Promise<ExitStatus>;
  close(): Promise<void>;
};

export type ServerOptions = {
  /** Folder the server starts in, which is the location a request names none for. */
  cwd: string;
  /** Inline configuration, merged over the user's own. */
  config?: Record<string, unknown>;
};

export type OpenCodeConnect = (options: ServerOptions) => Promise<OpenCodeClient>;

/**
 * The server does not notice the app going away, so it runs under a shell that stops it once the
 * app's end of stdin closes, whether the app closed it or died, and kills it if it will not stop.
 * The shell leaves with the server.
 */
export const WATCHED_SERVE = [
  "exec 3<&0",
  "\"$0\" serve --hostname 127.0.0.1 --port 0 </dev/null &",
  "server=$!",
  "( read _ <&3; kill $server 2>/dev/null; sleep 3; kill -9 $server 2>/dev/null ) &",
  "watcher=$!",
  "wait $server",
  "status=$?",
  "kill $watcher 2>/dev/null",
  "exit $status",
].join("\n");

/**
 * Starts a private OpenCode server on the loopback interface, on a port of the system's choosing,
 * behind the password it makes up for itself, and connects to it.
 */
export const startOpenCodeServer: OpenCodeConnect = async (options) => {
  const child = spawn("/bin/sh", ["-c", WATCHED_SERVE, engineBinaryPath("opencode") ?? "opencode"], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config) } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const server = new OpenCodeServer(child);
  try {
    await server.ready;
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
};

class OpenCodeServer implements OpenCodeClient {
  readonly ready: Promise<void>;
  readonly exited: Promise<ExitStatus>;
  private url = "";
  private authorization = "";
  private stderr = "";
  private readonly listeners = new Set<(event: OpenCodeEvent) => void>();
  private feed: AbortController | null = null;
  private closing = false;

  constructor(private readonly child: ChildProcess) {
    child.stdin?.on("error", () => {});
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal, stderr: this.stderr }));
      child.once("error", (error) => resolve({ code: null, signal: null, stderr: error.message }));
    });
    child.stderr?.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT); });
    this.ready = new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        const unread = unreadLine(output);
        reject(new Error(unread ? unreadStartup(unread) : "OpenCode did not start in time."));
      }, START_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (this.url) return;
        output += chunk.toString();
        const url = LISTENING.exec(output)?.[1];
        const password = PASSWORD.exec(output)?.[1];
        if (!url || !password) return;
        this.url = url.replace(/\/$/, "");
        this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
        clearTimeout(timer);
        resolve();
      });
      void this.exited.then((exit) => {
        clearTimeout(timer);
        reject(new OpenCodeExited(exit));
      });
    });
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: this.authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const tag = isRecord(parsed) && typeof parsed._tag === "string" ? parsed._tag : undefined;
      const message = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : `${response.status} ${response.statusText}`;
      throw new OpenCodeError(response.status, tag, message);
    }
    /** Most answers wrap their value with the location they were read in. */
    return (isRecord(parsed) && "data" in parsed ? parsed.data : parsed) as T;
  }

  subscribe(listener: (event: OpenCodeEvent) => void) {
    this.listeners.add(listener);
    if (!this.feed) void this.listen();
    return () => { this.listeners.delete(listener); };
  }

  /** One feed per server, shared by every listener, read until the server goes. */
  private async listen() {
    const feed = this.feed = new AbortController();
    try {
      const response = await fetch(`${this.url}/api/event`, { headers: { authorization: this.authorization, accept: "text/event-stream" }, signal: feed.signal });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          this.dispatch(frame);
        }
      }
    } catch {
      /** Why the feed ended does not change what follows: the server's events are no longer heard. */
    }
    if (this.feed === feed) this.feed = null;
    if (!this.closing) for (const listener of [...this.listeners]) listener({ type: FEED_ENDED });
  }

  private dispatch(frame: string) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event) || typeof event.type !== "string") return;
    const parsed: OpenCodeEvent = { type: event.type, ...(isRecord(event.data) ? { data: event.data } : {}) };
    for (const listener of this.listeners) listener(parsed);
  }

  async close() {
    if (this.closing) {
      await this.exited;
      return;
    }
    this.closing = true;
    this.feed?.abort();
    this.listeners.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin?.end();
      const timer = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS);
      timer.unref?.();
      await this.exited;
      clearTimeout(timer);
    }
  }
}

/** How often, and how long, a list is read again while the server is still loading the folder it names. */
const LOADING_RETRY_MS = 500;
const LOADING_ATTEMPTS = 10;

/**
 * A list read in a folder the server has not loaded yet comes back empty, then grows while it loads,
 * so it is read again until two answers in a row agree, for a few seconds at most.
 */
export async function readLoaded<T>(client: Pick<OpenCodeClient, "request">, path: string, retryMs = LOADING_RETRY_MS): Promise<T[]> {
  let previous: T[] | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const list = await client.request<T[] | undefined>("GET", path) ?? [];
    if (list.length && list.length === previous?.length || attempt >= LOADING_ATTEMPTS) return list;
    previous = list;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
