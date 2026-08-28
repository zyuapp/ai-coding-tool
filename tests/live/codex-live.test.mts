import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import type { ProviderEvent, ProviderRunInput, ThreadBridge, ToolDecision } from "../../src/main/agent/agent-provider.mts";
import { AppServerClient } from "../../src/main/codex/app-server-client.mts";
import { readCodexAccess } from "../../src/main/codex/codex-account.mts";
import { CodexAgentProvider } from "../../src/main/codex/codex-agent-provider.mts";
import { McpHttpHost } from "../../src/main/tools/mcp-http-host.mts";
import type { ThreadSummary } from "../../src/contracts/threads.ts";
import type { Continuation, ToolIntent } from "../../src/domain/run.ts";
import { input } from "../support/codex-client.mjs";

/** Drives the bundled Codex binary for real, so it only runs when asked and signed in. */
const wanted = process.env.CODEX_LIVE === "1";
const signedIn = wanted && await readCodexAccess() === "ready";

const CASE_MS = 120_000;
const MODEL = "gpt-5.6-terra";

type Run = {
  result: Awaited<ReturnType<CodexAgentProvider["execute"]>>;
  events: ProviderEvent[];
  asked: ToolIntent[];
  text: string;
  continuation?: Continuation;
};

function summary(id: string): ThreadSummary {
  return { id, title: `Thread ${id}`, status: "idle", archived: false, createdAt: 0, lastActivityAt: 0, messageCount: 1, attachmentCount: 0 };
}

describe.skipIf(!signedIn)("a Codex thread, live", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "codex-live-"));
  execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
  const host = new McpHttpHost();
  const clients: AppServerClient[] = [];
  const provider = new CodexAgentProvider({
    host,
    connect: (command) => {
      const client = new AppServerClient(command);
      clients.push(client);
      return client;
    },
  });
  let continuation: Continuation | undefined;

  afterAll(async () => {
    provider.closeAll();
    await Promise.all(clients.map((client) => client.exited));
    await host.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function run({ emit: observe, ...overrides }: Partial<ProviderRunInput>, decide: (intent: ToolIntent) => ToolDecision = () => "allow"): Promise<Run> {
    const events: ProviderEvent[] = [];
    const asked: ToolIntent[] = [];
    const result = await provider.execute(input({
      workspaceRoot,
      model: MODEL,
      effort: "low",
      authorize: async (intent) => {
        asked.push(intent);
        return decide(intent);
      },
      ...overrides,
      emit: (event) => {
        events.push(event);
        observe?.(event);
      },
    }));
    const text = events.filter((event) => event.type === "assistant").map((event) => event.text).join("");
    const emitted = events.find((event) => event.type === "continuation");
    return { result, events, asked, text, ...(emitted ? { continuation: emitted.continuation } : {}) };
  }

  /** Codex may read its own skills first, and under a read-only sandbox may ask in prose instead of acting: the prompt asks it not to. */
  const create = "Create a file named hello.txt whose whole content is the word hello, with no punctuation. Do it now without asking me anything first.";
  const hello = path.join(workspaceRoot, "hello.txt");
  const wantsHello = (intent: ToolIntent) => intent.name === "file_change" || JSON.stringify(intent.input).includes("hello.txt");

  test("a denied file change leaves no file behind", { timeout: CASE_MS }, async () => {
    const done = await run({ taskId: "deny", policy: "confirm", prompt: create }, (intent) => (wantsHello(intent) ? "deny" : "allow"));
    assert.equal(done.result.status, "succeeded", JSON.stringify(done.result));
    assert.ok(done.asked.some(wantsHello), `asked: ${JSON.stringify(done.asked)}`);
    assert.ok(!existsSync(hello), "hello.txt was written despite the denial");
  });

  test("an allowed file change writes the file, streams text and names the thread", { timeout: CASE_MS }, async () => {
    const done = await run({ taskId: "allow", policy: "confirm", prompt: create });
    assert.equal(done.result.status, "succeeded", JSON.stringify(done.result));
    assert.ok(done.asked.some(wantsHello), `asked: ${JSON.stringify(done.asked)}`);
    assert.ok(existsSync(hello), "hello.txt was not written");
    assert.equal(readFileSync(hello, "utf8").trim(), "hello");
    assert.ok(done.text.trim().length > 0, "no assistant text arrived");
    assert.equal(done.continuation?.provider, "codex");
    assert.ok(done.continuation?.value);
    continuation = done.continuation;
    provider.closeAll();
  });

  test("resuming the thread in a fresh process keeps its memory", { timeout: CASE_MS }, async () => {
    assert.ok(continuation, "the previous case left no continuation");
    const done = await run({ taskId: "allow", policy: "confirm", continuation, prompt: "What file did you just create? Answer with the file name only." });
    assert.equal(done.result.status, "succeeded", JSON.stringify(done.result));
    assert.ok(done.text.includes("hello.txt"), `answered: ${done.text}`);
    assert.equal(done.events.some((event) => event.type === "continuation-lost"), false);
  });

  /** Codex 0.150 leaves the interrupted command itself running; only its own process is held to account here. */
  test("aborting a slow command cancels the run and ends the process", { timeout: CASE_MS }, async () => {
    const abortController = new AbortController();
    let aborted = 0;
    const abort = () => {
      if (abortController.signal.aborted) return;
      aborted = Date.now();
      abortController.abort();
    };
    /** Two seconds into the command; or, should the command never start, before the case runs out. */
    const fallback = setTimeout(abort, 60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const before = clients.length;
    const done = await run({
      taskId: "abort",
      policy: "autonomous",
      abortController,
      prompt: "Run the shell command `sleep 30` and wait for it to finish, then say done.",
      emit: (event) => {
        if (event.type === "tool" && event.intent.name === "command_execution") timer ??= setTimeout(abort, 2_000);
      },
    });
    clearTimeout(fallback);
    clearTimeout(timer);
    assert.equal(done.result.status, "cancelled", JSON.stringify(done.result));
    assert.ok(aborted > 0, "the run finished before it was aborted");
    assert.ok(Date.now() - aborted < 15_000, `took ${Date.now() - aborted}ms to cancel`);
    assert.ok(done.events.some((event) => event.type === "tool"), "the command never started");
    provider.closeAll();
    const client = clients[before];
    assert.ok(client, "no process was started for the run");
    const exit = await Promise.race([client.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))]);
    assert.ok(exit, "the app server process is still running");
  });

  test("the app's tools answer without an approval", { timeout: CASE_MS }, async () => {
    const listed: unknown[] = [];
    const threads: ThreadBridge = {
      list: async (query) => {
        listed.push(query);
        return [summary("t-1"), summary("t-2"), summary("t-3")];
      },
      read: async () => { throw new Error("not read"); },
      wait: async () => ({ status: "idle", lastMessage: null }) as never,
      command: async () => ({ ok: true }) as never,
    };
    const done = await run({ taskId: "tools", policy: "confirm", threads, prompt: "Call the list_threads tool and tell me how many threads it returned." });
    assert.equal(done.result.status, "succeeded", JSON.stringify(done.result));
    assert.equal(listed.length >= 1, true, "list_threads was never called");
    assert.deepEqual(done.asked.filter((intent) => intent.name === "list_threads"), [], "a tool of the app's asked for approval");
    assert.ok(done.text.includes("3"), `answered: ${done.text}`);
  });
});
