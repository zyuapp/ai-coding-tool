/** Side chats as one input leaves them. Only the functions here make one. */
import { ownFields } from "./slice.js";
import { withoutMatching } from "../removals.js";
import type { SideChatsState } from "../state/side-chats.js";

class SideChatsChange {
  private declare readonly owned: never;
  constructor(readonly view: SideChatsState) {}
}

export type SideChatsEdit = SideChatsChange;

export function sideChatsOf(state: SideChatsState): SideChatsEdit {
  return new SideChatsChange(ownFields<SideChatsState>(state, { sideChats: true, sideChatSequence: true }));
}

/** A side chat whose run could not start, saying why in the dock rather than in the main thread's banner. */
export function chatFailedIn(edit: SideChatsEdit, chatId: string, error: string): SideChatsEdit {
  return new SideChatsChange({ ...edit.view, sideChats: edit.view.sideChats.map((chat) => chat.id === chatId ? { ...chat, error } : chat) });
}

/** Threads gone for good take the side chats they were, or were forked from, with them. */
export function sideChatsForgottenIn(edit: SideChatsEdit, removed: Set<string>): SideChatsEdit {
  return new SideChatsChange({ ...edit.view, sideChats: withoutMatching(edit.view.sideChats, (chat) => removed.has(chat.id) || removed.has(chat.sourceThreadId)) });
}
