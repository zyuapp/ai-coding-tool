/** Side chats, which fork a thread to ask something beside it. */
import { closeSideChats, focusDockTab, now, settled, showDockTab } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { sideChatThread } from "../thread-fork.js";
import type { WorkspaceState } from "../workspace-state.js";

type SideChatInput = Extract<WorkspaceInput, {
  type: "side-chat.open" | "side-chat.close";
}>;

export function reduceSideChats(state: WorkspaceState, input: SideChatInput): WorkspaceTransition {
  switch (input.type) {
    case "side-chat.open": {
      const source = state.threads.find((thread) => thread.id === state.currentId);
      if (!source) return settled(state);
      const sequence = state.sideChatSequence + 1;
      const thread = sideChatThread(source, input.chatId, `Chat ${sequence}`, now());
      const opened: WorkspaceState = {
        ...state,
        threads: [...state.threads, thread],
        sideChats: [...state.sideChats, { id: input.chatId, sourceThreadId: source.id, error: null }],
        sideChatSequence: sequence,
      };
      return focusDockTab(showDockTab(opened, source.id, input.chatId), source.id, input.chatId);
    }

    case "side-chat.close": {
      const chat = state.sideChats.find((item) => item.id === input.chatId);
      return chat ? closeSideChats(state, [chat]) : settled(state);
    }
  }
}
