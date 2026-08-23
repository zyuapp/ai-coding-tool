import { ClaudeAgentProvider } from "../../dist/main/main/agent/claude-agent-provider.mjs";

/** The fakes a session test runs against: one run's input, and query factories that stand in for the agent process. */
export function input(overrides = {}) {
  return {
    channel: "main",
    taskId: "task-1",
    prompt: "inspect the app",
    workspaceRoot: "/tmp/project",
    projectless: false,
    computerUse: { status: "unavailable", message: "test" },
    policy: "confirm",
    model: "opus",
    effort: "high",
    steering: { next: () => new Promise(() => {}) },
    abortController: new AbortController(),
    authorize: async () => "allow",
    emit() {},
    reportWorkflow() {},
    beginAgentTurn: () => null,
    ...overrides,
  };
}

export function queryFactory(messages, capture = {}) {
  return (options) => {
    capture.options = options;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      stopTask(taskId) {
        capture.stopped = [...(capture.stopped ?? []), taskId];
        return Promise.resolve();
      },
      close() {
        capture.closed = true;
      },
    };
  };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A session that stays open between turns, the way the agent process does in streaming input mode. */
export function liveQueryFactory(capture = {}) {
  capture.opens = 0;
  capture.sent = [];
  return (options) => {
    capture.options = options;
    capture.opens += 1;
    const pending = [];
    let wake = null;
    capture.emit = (message) => { pending.push(message); wake?.(); wake = null; };
    void (async () => { for await (const message of options.prompt) capture.sent.push(message.message.content); })();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length) yield pending.shift();
          await new Promise((resolve) => { wake = resolve; });
        }
      },
      interrupt: async () => { capture.interrupted = true; },
      stopTask: async (taskId) => { capture.stopped = [...(capture.stopped ?? []), taskId]; },
      setModel: async (model) => { capture.model = model; },
      setPermissionMode: async (mode) => { capture.mode = mode; },
      applyFlagSettings: async (settings) => { capture.settings = settings; },
      close() { capture.closed = true; },
    };
  };
}

/** Opens a live session and holds its turn, so the tool gate can be asked the way the agent process asks it. */
export async function liveTurn(overrides = {}) {
  const capture = {};
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const running = provider.execute(input(overrides));
  await tick();
  return {
    ...capture.options.options,
    capture,
    end: async () => {
      capture.emit({ type: "result", subtype: "success", is_error: false, result: "done" });
      await running;
      provider.closeAll();
    },
  };
}

export async function turn(capture, promise, ...messages) {
  await tick();
  for (const message of messages) capture.emit(message);
  capture.emit({ type: "result", subtype: "success", is_error: false, result: "done" });
  return promise;
}

/** A live session per open, so a pool test can watch each process separately. */
export function poolQueryFactory(capture = {}) {
  capture.sessions = [];
  return (options) => {
    const pending = [];
    let wake = null;
    const session = {
      options,
      closed: false,
      emit: (message) => { pending.push(message); wake?.(); wake = null; },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length) yield pending.shift();
          await new Promise((resolve) => { wake = resolve; });
        }
      },
      interrupt: async () => { session.interrupted = true; },
      setPermissionMode: async () => {},
      close() { session.closed = true; },
    };
    session.sent = [];
    void (async () => { for await (const message of options.prompt) session.sent.push(message.message.content); })();
    capture.sessions.push(session);
    return session;
  };
}

/** Runs one turn against the newest session, delivering the given messages before the turn's result. */
export async function poolTurn(provider, capture, overrides = {}, ...messages) {
  const running = provider.execute(input(overrides));
  await tick();
  const session = capture.sessions.at(-1);
  for (const message of messages) session.emit(message);
  session.emit({ type: "result", subtype: "success", is_error: false, result: "done" });
  return { session, result: await running };
}
