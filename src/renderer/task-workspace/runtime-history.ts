import { findTargetFor, reachableVisit, type WorkspaceState } from "../../application/workspace-state";
import { shortcutCommands, type WorkspaceInput } from "../../application/workspace-reducer";
import { findThread, resolveScope, threadSummaries } from "../../application/thread-projection";
import type { ConversationMessage } from "../../domain/conversation";
import type { ThreadFilter, ThreadRequest } from "../../contracts/threads";
import { adoptPersistedMessages, type PersistenceQueue } from "./workspace-persistence";

export type HistoryHost = {
  state(): WorkspaceState;
  load(taskId: string): Promise<ConversationMessage[]>;
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

  /** Only operations that read or append transcript content require its disk history. */
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
      case "task.select":
      case "worktree.open-thread":
      case "view.jump-choose": {
        add(input.taskId);
        add(state.sideChats.find((chat) => chat.id === input.taskId)?.sourceThreadId);
        break;
      }
      case "view.go-back":
      case "view.go-forward": {
        const index = reachableVisit(state, input.type === "view.go-back" ? -1 : 1);
        if (index !== null) add(state.history[index]);
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
        for (const event of input.events) add(event.taskId);
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
        const id = input.root
          ? state.worktrees.find((worktree) => worktree.root === input.root)?.id
          : state.threads.find((thread) => thread.id === taskId)?.worktreeId;
        claimants(id);
        break;
      }
    }
    return [...ids].filter((id) => state.threads.find((thread) => thread.id === id)?.historySummary);
  }

  return {
    hydrate,
    needed,
    invalidate() {
      generation += 1;
      reads.clear();
    },
    async prepareThreadRequest(request: ThreadRequest) {
      if (request.op === "read" || request.op === "wait") {
        const thread = findThread(host.state(), request.threadId);
        if (thread) await hydrate(thread.id);
      }
      if (request.op !== "list" || !request.search?.trim()) return;
      const state = host.state();
      const scope = resolveScope(state, request.taskId, request.project);
      if ("error" in scope) return;
      const filter: ThreadFilter = { scope };
      if (request.archived !== undefined) filter.archived = request.archived;
      if (request.attachments !== undefined) filter.attachments = request.attachments;
      if (request.idleForMs !== undefined) filter.idleForMs = request.idleForMs;
      const search = request.search.trim().toLowerCase();
      const threads = threadSummaries(state, filter, Date.now());
      for (const thread of threads) {
        if (!thread.title.toLowerCase().includes(search)) await hydrate(thread.id);
      }
    },
  };
}
