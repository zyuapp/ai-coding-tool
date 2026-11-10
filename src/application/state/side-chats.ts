/**
 * One forked conversation. Its thread is an ordinary thread in `threads`, so everything keyed by a
 * thread id reaches it too: drafts, queued messages, approvals, and steering. This record only marks
 * the thread as one that is never persisted and never listed.
 */
export type SideChat = {
  id: string;
  sourceThreadId: string;
  error: string | null;
};

export type SideChatsState = {
  sideChats: SideChat[];
  sideChatSequence: number;
};

export function initialSideChatsState(): SideChatsState {
  return { sideChats: [], sideChatSequence: 0 };
}

/** The ids of every thread that only lives for this session. */
export function sideChatIds(state: Pick<SideChatsState, "sideChats">) {
  return new Set(state.sideChats.map((chat) => chat.id));
}
