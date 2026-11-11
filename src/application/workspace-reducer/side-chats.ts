/** Side chats, which fork a thread to ask something beside it. */
import { retireAutomations } from "./automations.js";
import { chatTabsClosedIn, docksOf, focusDockTabIn, showDockTabIn } from "./dock-tabs.js";
import { clearedDraftIn, composerOf } from "../composer-drafts.js";
import { now } from "./shared.js";
import { andThen, applied, inTurn, type SliceTransition, type Step } from "./slice.js";
import { addedIn, removedIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { sideChatThread } from "../thread-fork.js";
import { pruned } from "../thread-pruning.js";
import type { SideChat, WorkspaceState } from "../workspace-state.js";
import type { SideChatsState } from "../state/side-chats.js";

export const SIDE_CHAT_INPUTS = ["side-chat.open", "side-chat.close"] as const;

export function reduceSideChats(state: WorkspaceState, input: Extract<WorkspaceInput, { type: (typeof SIDE_CHAT_INPUTS)[number] }>): SliceTransition<SideChatsState> {
  if (input.type === "side-chat.close") return sideChatClosed(state, input.chatId);
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

/** Closing one ends its run and drops what waits on it. */
function sideChatClosed(state: WorkspaceState, chatId: string): Step {
  const chat = state.sideChats.find((item) => item.id === chatId);
  return chat ? sideChatsClosed(state, [chat]) : {};
}

/** Closing a side chat discards the thread itself, so its run, queue, and draft go with it, the run cancelled first. */
export function sideChatsClosed(state: WorkspaceState, closing: SideChat[]): Step {
  const closed = new Set(closing.map((chat) => chat.id));
  const discarded = closing.map((chat) => (next: WorkspaceState): Step => {
    const active = next.activeRuns[chat.id];
    return {
      edits: [clearedDraftIn(composerOf(next), chat.id)],
      ...(active ? { effects: [{ type: "send-run-command", command: { type: "cancel", taskId: chat.id, runId: active.runId } }] } : {}),
    };
  });
  return inTurn(state, {}, [...discarded, (next) => andThen(next, {
    edits: [removedIn(threadsOf(next), closed), chatTabsClosedIn(docksOf(next), next.sideChats, closed)],
    /** Nothing a side chat can reach schedules one today; this keeps that true if the tool table changes. */
    effects: retireAutomations(next, closed),
  }, (left) => pruned(left, closed))]);
}

/** {@link sideChatsClosed}, on the whole state. */
export function closeSideChats(state: WorkspaceState, closing: SideChat[]): WorkspaceTransition {
  return applied(state, sideChatsClosed(state, closing));
}
