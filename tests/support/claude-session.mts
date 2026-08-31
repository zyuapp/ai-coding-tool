import { query, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "../../src/main/agent/claude-agent-provider.mts";
import type { ProviderResult, ProviderRunInput } from "../../src/main/agent/agent-provider.mts";

type QueryArguments = Parameters<typeof query>[0];
type FlagSettings = Parameters<Query["applyFlagSettings"]>[0];
type MessageContent = SDKUserMessage["message"]["content"];

export type QueryCapture = {
  options?: QueryArguments;
  stopped?: string[];
  closed?: boolean;
};

export type LiveQueryCapture = QueryCapture & {
  opens: number;
  sent: MessageContent[];
  emit?: (message: unknown) => void;
  interrupted?: boolean;
  model?: string;
  mode?: PermissionMode;
  settings?: FlagSettings;
};

export type PoolSession = AsyncIterable<SDKMessage> & {
  options: QueryArguments;
  closed: boolean;
  interrupted?: boolean;
  sent: MessageContent[];
  emit: (message: unknown) => void;
  interrupt: () => Promise<void>;
  close: () => void;
};

export type PoolCapture = { sessions: PoolSession[] };

/** The fakes a session test runs against: one run's input, and query factories that stand in for the agent process. */
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
    engine: "claude",
    model: "opus",
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

export function queryFactory(messages: readonly unknown[], capture: QueryCapture = {}): typeof query {
  return (options): Query => {
    capture.options = options;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
        for (const message of messages) yield message as SDKMessage;
      },
      stopTask(taskId: string) {
        capture.stopped = [...(capture.stopped ?? []), taskId];
        return Promise.resolve();
      },
      close() {
        capture.closed = true;
      },
    } as unknown as Query;
  };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A session that stays open between turns, the way the agent process does in streaming input mode. */
export function liveQueryFactory(capture: LiveQueryCapture = { opens: 0, sent: [] }): typeof query {
  capture.opens = 0;
  capture.sent = [];
  return (options): Query => {
    capture.options = options;
    capture.opens += 1;
    const pending: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    capture.emit = (message) => { pending.push(message as SDKMessage); wake?.(); wake = null; };
    void (async () => { for await (const message of options.prompt as AsyncIterable<SDKUserMessage>) capture.sent.push(message.message.content); })();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length) yield pending.shift()!;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      interrupt: async () => { capture.interrupted = true; },
      stopTask: async (taskId: string) => { capture.stopped = [...(capture.stopped ?? []), taskId]; },
      setModel: async (model: string | undefined) => { capture.model = model; },
      setPermissionMode: async (mode: PermissionMode) => { capture.mode = mode; },
      applyFlagSettings: async (settings: FlagSettings) => { capture.settings = settings; },
      close() { capture.closed = true; },
    } as unknown as Query;
  };
}

/** Opens a live session and holds its turn, so the tool gate can be asked the way the agent process asks it. */
export async function liveTurn(overrides: Partial<ProviderRunInput> = {}) {
  const capture: LiveQueryCapture = { opens: 0, sent: [] };
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const running = provider.execute(input(overrides));
  await tick();
  const options = capture.options?.options;
  if (!options?.canUseTool) throw new Error("The fake Claude session did not open");
  return {
    ...options,
    canUseTool: options.canUseTool,
    capture,
    end: async () => {
      capture.emit!({ type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage);
      await running;
      provider.closeAll();
    },
  };
}

export async function turn(capture: LiveQueryCapture, promise: Promise<ProviderResult>, ...messages: readonly unknown[]) {
  await tick();
  for (const message of messages) capture.emit!(message as SDKMessage);
  capture.emit!({ type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage);
  return promise;
}

/** A live session per open, so a pool test can watch each process separately. */
export function poolQueryFactory(capture: PoolCapture = { sessions: [] }): typeof query {
  capture.sessions = [];
  return (options): Query => {
    const pending: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    const session: PoolSession = {
      options,
      closed: false,
      sent: [],
      emit: (message) => { pending.push(message as SDKMessage); wake?.(); wake = null; },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length) yield pending.shift()!;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      interrupt: async () => { session.interrupted = true; },
      close() { session.closed = true; },
    };
    void (async () => { for await (const message of options.prompt as AsyncIterable<SDKUserMessage>) session.sent.push(message.message.content); })();
    capture.sessions.push(session);
    return session as unknown as Query;
  };
}

/** Runs one turn against the newest session, delivering the given messages before the turn's result. */
export async function poolTurn(provider: ClaudeAgentProvider, capture: PoolCapture, overrides: Partial<ProviderRunInput> = {}, ...messages: readonly unknown[]) {
  const running = provider.execute(input(overrides));
  await tick();
  const session = capture.sessions.at(-1)!;
  for (const message of messages) session.emit(message as SDKMessage);
  session.emit({ type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage);
  return { session, result: await running };
}
