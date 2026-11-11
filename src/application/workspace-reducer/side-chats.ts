/** Side chats, which fork a thread to ask something beside it. */
import { retireAutomations } from "./automations.js";
import { docksOf, focusDockTabIn, showDockTabIn } from "./dock-tabs.js";
import { withQueued } from "./run-queue.js";
import { clearedDraft } from "../composer-drafts.js";
import { now, settled } from "./shared.js";
import type { SliceTransition } from "./slice.js";
import { addedIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { sideChatThread } from "../thread-fork.js";
import { pruneDeletedThreads } from "../thread-pruning.js";
import { withActiveRun, withBackgroundProcesses, withRunStatus } from "../thread-run-state.js";
import { dockTabAfterClosing, type SideChat, type ThreadDock, type WorkspaceState } from "../workspace-state.js";
import type { SideChatsState } from "../state/side-chats.js";

export const SIDE_CHAT_INPUTS = ["side-chat.open"] as const;

/** Closing one ends its run and drops what waits on it. */
export const SIDE_CHAT_CLOSE_INPUTS = ["side-chat.close"] as const;

export function reduceSideChats(state: WorkspaceState, input: Extract<WorkspaceInput, { type: "side-chat.open" }>): SliceTransition<SideChatsState> {
  const source = state.threads.find((thread) => thread.id === state.currentId);
  if (!source) return {};
  const sequence = state.sideChatSequence + 1;
  const thread = sideChatThread(source, input.chatId, `Chat ${sequence}`, now());
  const shown = focusDockTabIn(showDockTabIn(docksOf(state), source.id, input.chatId), source.id, input.chatId);
  return {
    patch: { sideChats: [...state.sideChats, { id: input.chatId, sourceThreadId: source.id, error: null }], sideChatSequence: sequence },
    edits: [addedIn(threadsOf(state), thread), shown.docks],
    effects: shown.effects,
  };
}

export function reduceSideChatClose(state: WorkspaceState, input: Extract<WorkspaceInput, { type: "side-chat.close" }>): WorkspaceTransition {
  const chat = state.sideChats.find((item) => item.id === input.chatId);
  return chat ? closeSideChats(state, [chat]) : settled(state);
}

/** Closing a side chat discards the thread itself, so its run, queue, and draft go with it. */
export function closeSideChats(state: WorkspaceState, closing: SideChat[]): WorkspaceTransition {
  const effects: WorkspaceEffect[] = [];
  let next = state;
  for (const chat of closing) {
    const active = next.activeRuns[chat.id];
    if (active) {
      effects.push({ type: "send-run-command", command: { type: "cancel", taskId: chat.id, runId: active.runId } });
      const { [active.runId]: _abandoned, ...approvals } = next.approvals;
      next = { ...next, approvals };
    }
    next = clearedDraft(withQueued(withRunStatus(withActiveRun(withBackgroundProcesses(next, chat.id, []), chat.id, null), chat.id, "idle"), chat.id, []), chat.id);
  }
  const closed = new Set(closing.map((chat) => chat.id));
  /** Nothing a side chat can reach schedules one today; this keeps that true if the tool table changes. */
  effects.push(...retireAutomations(next, closed));
  return {
    state: pruneDeletedThreads({
      ...next,
      automations: next.automations.filter((automation) => !closed.has(automation.taskId)),
      threads: next.threads.filter((thread) => !closed.has(thread.id)),
      sideChats: next.sideChats.filter((chat) => !closed.has(chat.id)),
      docks: Object.fromEntries(Object.entries(next.docks).map(([owner, dock]): [string, ThreadDock] => [
        owner,
        closed.has(dock.tab) ? { ...dock, tab: dockTabAfterClosing(next, owner, dock.tab) } : dock,
      ])),
      pendingRuns: Object.fromEntries(Object.entries(next.pendingRuns).filter(([, pending]) => !(pending.taskId && closed.has(pending.taskId)))),
      readingPoints: Object.fromEntries(Object.entries(next.readingPoints).filter(([taskId]) => !closed.has(taskId))),
    }, closed),
    effects,
  };
}
