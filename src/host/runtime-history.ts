import { findTargetFor, type WorkspaceState } from "../application/workspace-state.js";
import { inputScope } from "../application/input-scope.js";
import { shortcutCommands, type WorkspaceInput } from "../application/workspace-reducer.js";
import { resolveScope, threadSummaries } from "../application/thread-projection.js";
import type { ConversationMessage } from "../domain/conversation.js";
import type { ThreadFilter, ThreadRequest } from "../contracts/threads.js";
import { adoptPersistedMessages, type PersistenceQueue } from "./workspace-persistence.js";
import { resolveThreadRead, type PreparedThreadRequest } from "./thread-reads.js";

export type HistoryHost = {
  state(): WorkspaceState;
  load(taskId: string): Promise<ConversationMessage[]>;
  /** Which of these threads have stored message text containing the lowercased search. */
  search(search: string, taskIds: string[]): Promise<string[]>;
  dispatch(input: WorkspaceInput): Promise<void>;
  persistence: PersistenceQueue;
};

/** Concurrent readers share the disk read, and loaded messages become the durable baseline. */
export function createRuntimeHistory(host: HistoryHost) {
  const reads = new Map<string, Promise<void>>();
  let generation = 0;
  function hydrate(taskId: string): Promise<void> {
    const held = reads.get(taskId);
    if (held) return held;
    if (!host.state().threads.find((thread) => thread.id === taskId)?.historySummary) return Promise.resolve();
    const currentGeneration = generation;
    const read = host.load(taskId).then(async (messages) => {
      if (generation !== currentGeneration) return;
      adoptPersistedMessages(host.persistence, taskId, messages);
      await host.dispatch({ type: "store.thread-loaded", taskId, messages });
    }).catch((error: unknown) => {
      if (generation === currentGeneration) throw error;
    }).finally(() => {
      if (reads.get(taskId) === read) reads.delete(taskId);
    });
    reads.set(taskId, read);
    return read;
  }

  /**
   * Only operations that read or append transcript content require its disk history. Selection does
   * not: it lands at once and the thread on screen loads behind its loading state.
   */
  function needed(input: WorkspaceInput): string[] {
    const state = host.state();
    const ids = new Set<string>();
    function add(taskId: string | null | undefined) {
      if (taskId) ids.add(taskId);
    }
    function claimants(worktreeId: string | undefined) {
      if (!worktreeId) return;
      for (const thread of state.threads) if (thread.worktreeId === worktreeId) add(thread.id);
    }
    switch (input.type) {
      case "view.shortcut": {
        const commands = shortcutCommands(state, input.action, input.surface);
        if (commands.some((command) => command.type === "task.new")) break;
        for (const command of commands) for (const id of needed(command)) add(id);
        break;
      }
      case "task.send":
        add(input.taskId ?? (input.text === undefined ? state.currentId : null));
        break;
      case "task.fork":
      case "task.set-worktree":
      case "task.move-worktree":
      case "run.compact":
      case "review.start":
        add(input.taskId ?? state.currentId);
        break;
      case "view.move-worktree":
        if (input.worktree !== null) add(state.currentId);
        break;
      case "side-chat.open":
        add(state.currentId);
        break;
      case "view.find-open": {
        const target = input.target ?? state.find?.target ?? findTargetFor(state, "any");
        if (target.kind === "thread") add(target.taskId);
        break;
      }
      case "view.find-query":
      case "view.find-step":
        if (state.find?.target.kind === "thread") add(state.find.target.taskId);
        break;
      case "agent.events":
        for (const event of input.events) if ("taskId" in event) add(event.taskId);
        break;
      case "run.event":
        add(input.event.taskId);
        break;
      case "automation.fired":
        add(input.fire.taskId);
        break;
      case "run.resolved":
        add(state.pendingRuns[input.pendingId]?.taskId);
        break;
      case "worktree.created":
        add(input.taskId);
        break;
      case "worktree.released":
        claimants(state.threads.find((thread) => thread.id === input.taskId)?.worktreeId);
        break;
      case "worktree.deleted":
        claimants(state.worktrees.find((worktree) => worktree.id === input.worktreeId || worktree.root === input.root)?.id);
        break;
      case "worktree.delete": {
        const taskId = input.taskId ?? state.currentId;
        const id = input.worktreeId ?? (input.root
          ? state.worktrees.find((worktree) => worktree.root === input.root)?.id
          : state.threads.find((thread) => thread.id === taskId)?.worktreeId);
        claimants(id);
        break;
      }
    }
    return [...ids].filter((id) => state.threads.find((thread) => thread.id === id)?.historySummary);
  }

  return {
    hydrate,
    needed,
    scope: (input: WorkspaceInput) => inputScope(host.state(), input),
    invalidate() {
      generation += 1;
      reads.clear();
    },
    /** A list search reads unloaded histories on disk, so it answers without loading them into the workspace. */
    async prepareThreadRequest(request: ThreadRequest): Promise<PreparedThreadRequest | void> {
      if ((request.op === "read" || request.op === "list") && request.computer && !["this", "all"].includes(request.computer)) return;
      if (request.op === "read") {
        const match = resolveThreadRead(host.state(), request.threadId, request.computer);
        if (!match.computer) await hydrate(match.thread.id);
      }
      if (request.op === "wait") {
        const match = resolveThreadRead(host.state(), request.threadId);
        if (!match.computer) await hydrate(match.thread.id);
      }
      if (request.op !== "list" || !request.search?.trim()) return;
      const state = host.state();
      const scope = resolveScope(state, request.taskId, request.project ?? (request.computer === "all" ? "all" : undefined));
      if ("error" in scope) return;
      const filter: ThreadFilter = { scope };
      if (request.archived !== undefined) filter.archived = request.archived;
      if (request.attachments !== undefined) filter.attachments = request.attachments;
      if (request.idleForMs !== undefined) filter.idleForMs = request.idleForMs;
      const search = request.search.trim().toLowerCase();
      const unloaded = new Set(state.threads.flatMap((thread) => thread.historySummary ? [thread.id] : []));
      const ids = threadSummaries(state, filter, Date.now())
        .flatMap((thread) => unloaded.has(thread.id) && !thread.title.toLowerCase().includes(search) ? [thread.id] : []);
      return { stored: new Set(ids.length ? await host.search(search, ids) : []) };
    },
  };
}
