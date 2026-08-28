import type { SubagentReport } from "../../domain/run.js";
import type { NotificationParams } from "./app-server-client.mjs";
import type { ThreadItem } from "./protocol/v2/ThreadItem.js";

type ChildLifecycle = "unknown" | "working" | "idle" | "failed" | "stopped";

type BufferedActivity = Extract<SubagentReport, { type: "subagent.activity" }>;

type Child = {
  id: string;
  discovered: boolean;
  lifecycle: ChildLifecycle;
  active: boolean;
  prompt?: string;
  preview?: string;
  nickname?: string;
  role?: string;
  path?: string;
  totalTokens: number;
  lastToolName?: string;
  summary?: string;
  statusSummary?: string;
  reportedLifecycle?: Exclude<ChildLifecycle, "unknown">;
  reportedStatusSummary?: string;
  progressKey?: string;
  bufferedActivity: BufferedActivity[];
  seenActivity: Set<string>;
  seenActivityOrder: string[];
  reviewOutput?: string;
  completedTurn?: {
    id: string;
    status: "completed" | "interrupted" | "failed";
    message?: string;
  };
};

type PendingItem = { threadId: string; item: ThreadItem };

export type CodexChildTurn = { threadId: string; turnId: string };

const MAX_BUFFERED_ACTIVITY = 100;
const MAX_SEEN_ACTIVITY = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathLeaf(value: string | undefined) {
  return value?.split("/").filter(Boolean).at(-1);
}

function firstLine(value: string) {
  return value.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function detail(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** Metadata present only on a child thread's `thread/started` notification. */
function spawnMetadata(thread: NotificationParams<"thread/started">["thread"]) {
  const source = thread.source;
  if (!isRecord(source)) return undefined;
  const record = source as Record<string, unknown>;
  if (!isRecord(record.subAgent) || !isRecord(record.subAgent.thread_spawn)) return undefined;
  const spawn = record.subAgent.thread_spawn;
  return {
    nickname: nonempty(spawn.agent_nickname),
    role: nonempty(spawn.agent_role),
    path: nonempty(spawn.agent_path),
  };
}

/** Threads Codex owns for housekeeping must stay out of both the parent conversation and the roster. */
function isInternalThread(thread: NotificationParams<"thread/started">["thread"]) {
  if (thread.threadSource === "memory_consolidation") return true;
  const source = thread.source;
  if (!isRecord(source)) return false;
  const record = source as Record<string, unknown>;
  if (record.subAgent === "memory_consolidation") return true;
  return record.internal === "memory_consolidation" || record.internal === "guardian";
}

function toolActivity(item: ThreadItem): { title: string; text: string; summary?: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { title: "command_execution", text: detail({ command: item.command, cwd: item.cwd }), summary: item.command };
    case "fileChange": {
      const paths = item.changes.map((change) => change.path);
      return { title: "file_change", text: detail({ changes: item.changes }), ...(paths[0] ? { summary: paths[0] } : {}) };
    }
    case "mcpToolCall":
      return { title: item.tool, text: detail(item.arguments), summary: item.tool };
    case "dynamicToolCall":
      return { title: item.tool, text: detail(item.arguments), summary: item.tool };
    case "webSearch":
      return { title: "web_search", text: detail({ query: item.query }), summary: item.query };
    case "imageView":
      return { title: "image_view", text: detail({ path: item.path }), summary: item.path };
    case "imageGeneration":
      return { title: "image_generation", text: detail({ revisedPrompt: item.revisedPrompt, savedPath: item.savedPath }), ...(item.revisedPrompt ? { summary: item.revisedPrompt } : {}) };
    case "sleep":
      return { title: "sleep", text: detail({ durationMs: item.durationMs }), summary: `${item.durationMs} ms` };
    case "collabAgentToolCall":
      return { title: item.tool, text: detail({ prompt: item.prompt, receiverThreadIds: item.receiverThreadIds }), ...(item.prompt ? { summary: item.prompt } : {}) };
    default:
      return undefined;
  }
}

/**
 * Routes Codex multi-agent notifications and folds each child thread into the provider-neutral
 * subagent reports. A foreign thread is suppressed immediately, but nothing appears in the roster
 * until `thread/started` names a `thread_spawn` source or `subAgentActivity` names the child.
 */
export class CodexSubagents {
  private rootThreadId?: string;
  private readonly children = new Map<string, Child>();
  private readonly ignoredThreads = new Set<string>();
  private readonly liveTurnsByThread = new Map<string, string>();
  private readonly pendingItems = new Map<string, PendingItem>();
  private activeChildren = 0;
  private closed = false;

  constructor(
    private readonly report: (event: SubagentReport) => void,
    private readonly onBusyChanged: (busy: boolean) => void = () => {},
  ) {}

  /** Anything closing the app-server process would cut short. */
  get busy() {
    return this.liveTurnsByThread.size > 0 || this.activeChildren > 0;
  }

  /** Child turns currently addressable by `turn/interrupt`, including child-first provisional ones. */
  get liveTurns(): readonly CodexChildTurn[] {
    return [...this.liveTurnsByThread].map(([threadId, turnId]) => ({ threadId, turnId }));
  }

  setRootThreadId(threadId: string) {
    const wasBusy = this.busy;
    this.rootThreadId = threadId;
    this.ignoredThreads.delete(threadId);
    if (this.children.get(threadId)?.active) this.activeChildren -= 1;
    this.children.delete(threadId);
    this.liveTurnsByThread.delete(threadId);
    for (const [itemId, pending] of this.pendingItems) {
      if (pending.threadId === threadId) this.pendingItems.delete(itemId);
    }
    this.changedBusy(wasBusy);
  }

  /** A detached native review is a child thread even though it has no collaboration spawn metadata. */
  registerReview(threadId: string, description: string) {
    return this.withBusy(() => {
      if (threadId === this.rootThreadId || this.ignoredThreads.has(threadId)) return;
      const child = this.child(threadId);
      this.mergeMetadata(child, { prompt: description, role: "reviewer" });
      if (child.lifecycle === "unknown") this.setLifecycle(child, "working");
      this.discover(child);
    });
  }

  /** Review traffic may arrive before `review/start` returns its detached thread id. */
  reviewState(threadId: string) {
    const child = this.children.get(threadId);
    if (!child) return undefined;
    return {
      ...(child.reviewOutput ? { output: child.reviewOutput } : {}),
      ...(child.completedTurn ? { completed: child.completedTurn } : {}),
    };
  }

  /**
   * Whether a notification belongs somewhere other than the root conversation. Once the root is
   * known, unknown foreign ids are suppressed too: Codex can send child status before discovery.
   */
  shouldSuppress(threadId: string) {
    if (threadId === this.rootThreadId) return false;
    return this.children.has(threadId) || this.ignoredThreads.has(threadId) || this.rootThreadId !== undefined;
  }

  /** A child item kept for a later approval request, which may carry only the item id. */
  pendingItem(threadId: string, itemId: string) {
    const pending = this.pendingItems.get(itemId);
    return pending?.threadId === threadId ? pending.item : undefined;
  }

  /** The newest child call against one MCP server, for an elicitation approval with no item id. */
  pendingMcpCall(threadId: string, server: string) {
    let found: Extract<ThreadItem, { type: "mcpToolCall" }> | undefined;
    for (const pending of this.pendingItems.values()) {
      if (pending.threadId === threadId && pending.item.type === "mcpToolCall" && pending.item.server === server) found = pending.item;
    }
    return found;
  }

  threadStarted(params: NotificationParams<"thread/started">) {
    return this.withBusy(() => {
      const { thread } = params;
      if (thread.id === this.rootThreadId) return false;
      if (isInternalThread(thread)) {
        this.ignore(thread.id);
        return true;
      }
      const spawn = spawnMetadata(thread);
      if (!spawn && !this.shouldSuppress(thread.id)) return false;
      const child = this.child(thread.id);
      this.mergeMetadata(child, {
        preview: nonempty(thread.preview),
        nickname: spawn?.nickname ?? nonempty(thread.agentNickname),
        role: spawn?.role ?? nonempty(thread.agentRole),
        path: spawn?.path,
      });
      if (spawn) {
        /** A spawn is work beginning. The thread snapshot commonly still says idle before its first turn. */
        if (!child.discovered && (child.lifecycle === "unknown" || child.lifecycle === "idle")) this.setLifecycle(child, "working");
        this.discover(child);
      }
      return true;
    });
  }

  threadStatusChanged(params: NotificationParams<"thread/status/changed">) {
    return this.withBusy(() => {
      if (!this.shouldSuppress(params.threadId)) return false;
      if (this.ignoredThreads.has(params.threadId)) {
        if (params.status.type === "idle" || params.status.type === "systemError") this.liveTurnsByThread.delete(params.threadId);
        return true;
      }
      this.applyThreadStatus(this.child(params.threadId), params.status);
      return true;
    });
  }

  turnStarted(params: NotificationParams<"turn/started">) {
    return this.withBusy(() => {
      if (!this.shouldSuppress(params.threadId)) return false;
      if (this.ignoredThreads.has(params.threadId)) return true;
      this.liveTurnsByThread.set(params.threadId, params.turn.id);
      const child = this.child(params.threadId);
      child.completedTurn = undefined;
      this.setLifecycle(child, "working");
      return true;
    });
  }

  turnCompleted(params: NotificationParams<"turn/completed">) {
    return this.withBusy(() => {
      if (!this.shouldSuppress(params.threadId)) return false;
      const liveTurn = this.liveTurnsByThread.get(params.threadId);
      if (!liveTurn || liveTurn === params.turn.id) this.liveTurnsByThread.delete(params.threadId);
      if (this.ignoredThreads.has(params.threadId)) return true;
      /** An older completion arriving after a resumed turn says nothing about the newer turn. */
      if (liveTurn && liveTurn !== params.turn.id) return true;
      const child = this.child(params.threadId);
      if (params.turn.status !== "inProgress") {
        child.completedTurn = {
          id: params.turn.id,
          status: params.turn.status,
          ...(params.turn.error?.message ? { message: params.turn.error.message } : {}),
        };
      }
      if (params.turn.status === "completed") this.setLifecycle(child, "idle");
      else if (params.turn.status === "interrupted") this.setLifecycle(child, "stopped");
      else if (params.turn.status === "failed") this.setLifecycle(child, "failed", params.turn.error?.message);
      return true;
    });
  }

  tokenUsageUpdated(params: NotificationParams<"thread/tokenUsage/updated">) {
    return this.withBusy(() => {
      if (!this.shouldSuppress(params.threadId)) return false;
      if (this.ignoredThreads.has(params.threadId)) return true;
      const child = this.child(params.threadId);
      const total = params.tokenUsage.total.totalTokens;
      if (Number.isFinite(total) && total >= 0) child.totalTokens = Math.max(child.totalTokens, total);
      this.emitProgress(child);
      return true;
    });
  }

  error(params: NotificationParams<"error">) {
    return this.withBusy(() => {
      if (!this.shouldSuppress(params.threadId)) return false;
      if (params.willRetry) return true;
      const liveTurn = this.liveTurnsByThread.get(params.threadId);
      /** An error from an older turn cannot fail a child that has already resumed. */
      if (liveTurn && liveTurn !== params.turnId) return true;
      this.liveTurnsByThread.delete(params.threadId);
      if (!this.ignoredThreads.has(params.threadId)) this.setLifecycle(this.child(params.threadId), "failed", params.error.message);
      return true;
    });
  }

  threadClosed(params: NotificationParams<"thread/closed">) {
    return this.withBusy(() => {
      if (!this.shouldSuppress(params.threadId)) return false;
      this.liveTurnsByThread.delete(params.threadId);
      if (this.ignoredThreads.delete(params.threadId)) return true;
      const child = this.children.get(params.threadId);
      if (child) {
        this.dropPendingItems(params.threadId);
        if (child.lifecycle !== "failed") this.setLifecycle(child, "stopped");
      }
      return true;
    });
  }

  itemStarted(params: NotificationParams<"item/started">) {
    return this.item(params.threadId, params.item, true);
  }

  itemCompleted(params: NotificationParams<"item/completed">) {
    return this.item(params.threadId, params.item, false);
  }

  /** Marks unfinished visible children stopped, then releases every session-only reference. */
  close() {
    if (this.closed) return;
    const wasBusy = this.busy;
    for (const child of this.children.values()) {
      if (child.discovered && child.lifecycle !== "idle" && child.lifecycle !== "failed" && child.lifecycle !== "stopped") {
        this.setLifecycle(child, "stopped");
      }
    }
    this.closed = true;
    this.liveTurnsByThread.clear();
    this.pendingItems.clear();
    this.ignoredThreads.clear();
    this.children.clear();
    this.activeChildren = 0;
    this.changedBusy(wasBusy);
  }

  private item(threadId: string, item: ThreadItem, started: boolean) {
    return this.withBusy(() => {
      if (item.type === "subAgentActivity") {
        this.receiveSubagentActivity(item);
        return true;
      }
      if (item.type === "collabAgentToolCall") this.rememberCollaboration(item);
      if (!this.shouldSuppress(threadId)) return false;
      if (this.ignoredThreads.has(threadId)) return true;
      const child = this.child(threadId);
      if (started) this.pendingItems.set(item.id, { threadId, item });
      this.receiveChildItem(child, item, started);
      if (!started) this.pendingItems.delete(item.id);
      return true;
    });
  }

  private receiveSubagentActivity(item: Extract<ThreadItem, { type: "subAgentActivity" }>) {
    const path = item.agentPath.replace(/\/+$/, "") || "/";
    if (item.agentThreadId === this.rootThreadId || path === "/root" || path === "/") return;
    if (this.ignoredThreads.has(item.agentThreadId)) return;
    const child = this.child(item.agentThreadId);
    this.mergeMetadata(child, { path: nonempty(path) });
    if (item.kind === "started") this.setLifecycle(child, "working");
    else if (item.kind === "completed") this.setLifecycle(child, "idle");
    else if (item.kind === "interrupted") this.setLifecycle(child, "stopped");
    else if (child.lifecycle === "unknown") this.setLifecycle(child, "idle");
    /** `interacted` is deliberately not working: Codex also emits it after a child becomes idle. */
    this.discover(child);
  }

  private rememberCollaboration(item: Extract<ThreadItem, { type: "collabAgentToolCall" }>) {
    for (const receiver of item.receiverThreadIds) {
      if (receiver === this.rootThreadId || this.ignoredThreads.has(receiver)) continue;
      const child = this.child(receiver);
      if (item.tool === "spawnAgent" && item.prompt) this.mergeMetadata(child, { prompt: nonempty(item.prompt) });
      const state = item.agentsStates[receiver];
      if (!state) continue;
      if (state.status === "pendingInit" || state.status === "running") this.setLifecycle(child, "working", state.message ?? undefined);
      else if (state.status === "completed") this.setLifecycle(child, "idle", state.message ?? undefined);
      else if (state.status === "errored") this.setLifecycle(child, "failed", state.message ?? undefined);
      else if (state.status === "interrupted" || state.status === "shutdown" || state.status === "notFound") this.setLifecycle(child, "stopped", state.message ?? undefined);
    }
  }

  private receiveChildItem(child: Child, item: ThreadItem, started: boolean) {
    if (item.type === "exitedReviewMode") {
      if (started) return;
      const text = item.review.trim();
      if (!text) return;
      child.reviewOutput = text;
      child.summary = firstLine(text);
      this.queueActivity(child, { type: "subagent.activity", id: child.id, activityId: `${item.id}:review`, kind: "text", text });
      this.emitProgress(child);
      return;
    }
    if (item.type === "agentMessage") {
      if (started) return;
      const text = item.text.trim();
      if (!text) return;
      child.summary = firstLine(text);
      this.queueActivity(child, { type: "subagent.activity", id: child.id, activityId: `${item.id}:text`, kind: "text", text });
      this.emitProgress(child);
      return;
    }
    const activity = toolActivity(item);
    if (!activity) return;
    if (started) this.setLifecycle(child, "working");
    child.lastToolName = activity.title;
    if (activity.summary) child.summary = firstLine(activity.summary);
    this.queueActivity(child, { type: "subagent.activity", id: child.id, activityId: item.id, kind: "tool", title: activity.title, text: activity.text });
    this.emitProgress(child);
  }

  private applyThreadStatus(child: Child, status: NotificationParams<"thread/status/changed">["status"]) {
    if (status.type === "active") {
      const waiting = status.activeFlags.includes("waitingOnApproval")
        ? "Waiting for approval"
        : status.activeFlags.includes("waitingOnUserInput")
          ? "Waiting for input"
          : undefined;
      this.setLifecycle(child, "working", waiting);
    } else if (status.type === "idle" || status.type === "notLoaded") {
      this.setLifecycle(child, "idle");
    } else if (status.type === "systemError") {
      this.setLifecycle(child, "failed");
    }
  }

  private child(id: string) {
    let child = this.children.get(id);
    if (!child) {
      child = {
        id,
        discovered: false,
        lifecycle: "unknown",
        active: false,
        totalTokens: 0,
        bufferedActivity: [],
        seenActivity: new Set(),
        seenActivityOrder: [],
      };
      this.children.set(id, child);
    }
    return child;
  }

  private description(child: Child) {
    return child.prompt ?? child.preview ?? child.nickname ?? pathLeaf(child.path) ?? child.role ?? "Subagent";
  }

  private mergeMetadata(child: Child, metadata: { prompt?: string; preview?: string; nickname?: string; role?: string; path?: string }) {
    const before = this.description(child);
    const role = child.role;
    child.prompt ??= metadata.prompt;
    child.preview ??= metadata.preview;
    child.nickname ??= metadata.nickname;
    child.role ??= metadata.role;
    child.path ??= metadata.path;
    if (child.discovered && (this.description(child) !== before || child.role !== role)) this.emitProgress(child);
  }

  private discover(child: Child) {
    if (child.discovered || this.closed) return;
    child.discovered = true;
    this.report({
      type: "subagent.started",
      id: child.id,
      description: this.description(child),
      ...(child.role ? { agentType: child.role } : {}),
      sessionScoped: true,
    });
    /** `started` implies working; a buffered child-first state corrects it immediately when needed. */
    child.reportedLifecycle = "working";
    if (child.lifecycle !== "unknown" && child.lifecycle !== "working") this.emitLifecycle(child);
    else if (child.lifecycle === "working" && child.statusSummary) this.emitLifecycle(child);
    if (child.totalTokens > 0 || child.lastToolName || child.summary) this.emitProgress(child);
    for (const activity of child.bufferedActivity) this.report(activity);
    child.bufferedActivity = [];
  }

  private setLifecycle(child: Child, lifecycle: Exclude<ChildLifecycle, "unknown">, summary?: string) {
    const wasActive = child.active;
    if (lifecycle === "working" && child.lifecycle !== "working") child.lastToolName = undefined;
    child.lifecycle = lifecycle;
    child.active = lifecycle === "working";
    if (child.active !== wasActive) this.activeChildren += child.active ? 1 : -1;
    if (lifecycle !== "working") {
      this.liveTurnsByThread.delete(child.id);
      this.dropPendingItems(child.id);
    }
    child.statusSummary = lifecycle === "working" ? summary : undefined;
    if (summary && lifecycle !== "working") child.summary = firstLine(summary);
    this.emitLifecycle(child);
  }

  private emitLifecycle(child: Child) {
    if (!child.discovered || this.closed) return;
    const lifecycle = child.lifecycle;
    if (lifecycle === "unknown") return;
    if (lifecycle === "working" || lifecycle === "idle") {
      const statusSummary = lifecycle === "working" ? child.statusSummary : child.summary;
      if (child.reportedLifecycle === lifecycle && child.reportedStatusSummary === statusSummary) return;
      child.reportedLifecycle = lifecycle;
      child.reportedStatusSummary = statusSummary;
      this.report({
        type: "subagent.status",
        id: child.id,
        status: lifecycle,
        ...(statusSummary ? { summary: statusSummary } : {}),
      });
      return;
    }
    const terminalSummary = child.summary ?? "";
    if (child.reportedLifecycle === lifecycle && child.reportedStatusSummary === terminalSummary) return;
    child.reportedLifecycle = lifecycle;
    child.reportedStatusSummary = terminalSummary;
    this.report({ type: "subagent.finished", id: child.id, status: lifecycle, summary: terminalSummary });
  }

  private emitProgress(child: Child) {
    if (!child.discovered || this.closed) return;
    const description = this.description(child);
    const key = detail([description, child.lastToolName ?? null, child.summary ?? null, child.totalTokens]);
    if (key === child.progressKey) return;
    child.progressKey = key;
    this.report({
      type: "subagent.progress",
      id: child.id,
      description,
      ...(child.role ? { agentType: child.role } : {}),
      ...(child.lastToolName ? { lastToolName: child.lastToolName } : {}),
      ...(child.summary ? { summary: child.summary } : {}),
      totalTokens: child.totalTokens,
    });
  }

  private queueActivity(child: Child, activity: BufferedActivity) {
    if (child.seenActivity.has(activity.activityId)) return;
    child.seenActivity.add(activity.activityId);
    child.seenActivityOrder.push(activity.activityId);
    if (child.seenActivityOrder.length > MAX_SEEN_ACTIVITY) {
      const oldest = child.seenActivityOrder.shift();
      if (oldest) child.seenActivity.delete(oldest);
    }
    if (child.discovered && !this.closed) {
      this.report(activity);
      return;
    }
    child.bufferedActivity.push(activity);
    if (child.bufferedActivity.length > MAX_BUFFERED_ACTIVITY) child.bufferedActivity.shift();
  }

  private ignore(threadId: string) {
    this.ignoredThreads.add(threadId);
    this.liveTurnsByThread.delete(threadId);
    if (this.children.get(threadId)?.active) this.activeChildren -= 1;
    this.children.delete(threadId);
    this.dropPendingItems(threadId);
  }

  private dropPendingItems(threadId: string) {
    for (const [itemId, pending] of this.pendingItems) {
      if (pending.threadId === threadId) this.pendingItems.delete(itemId);
    }
  }

  private withBusy<T>(change: () => T) {
    const wasBusy = this.busy;
    const result = change();
    this.changedBusy(wasBusy);
    return result;
  }

  private changedBusy(wasBusy: boolean) {
    const busy = this.busy;
    if (busy !== wasBusy) this.onBusyChanged(busy);
  }
}
