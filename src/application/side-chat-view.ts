import type { QueuedMessage, SideChat, SideChatView, WorkspaceState } from "./workspace-state.js";
import { runStatusFor, type ApprovalView } from "./thread-run-state.js";
import { annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";

const NO_QUEUED: QueuedMessage[] = [];

/** One open side chat projected from its owning thread and active run. */
export function sideChatView(state: WorkspaceState, chat: SideChat): SideChatView[] {
  const thread = state.threads.find((item) => item.id === chat.id);
  if (!thread) return [];
  const active = state.activeRuns[chat.id];
  const approval = active?.status === "awaiting-approval" ? state.approvals[active.runId] as ApprovalView | undefined : undefined;
  return [{
    ...chat,
    title: thread.title,
    thread,
    prompt: state.prompts[chat.id] ?? "",
    annotations: annotationsFor(state, chat.id),
    pastes: pastesFor(state, chat.id),
    images: imagesFor(state, chat.id),
    files: filesFor(state, chat.id),
    running: Boolean(active),
    question: active?.questions?.[0],
    replyingToQuestion: active?.replyingToQuestion !== false,
    compacting: active?.status === "compacting",
    status: active ? "running" : runStatusFor(state, chat.id),
    streamingTail: state.streamingTails[chat.id] ?? null,
    queuedMessages: state.queuedMessages[chat.id] ?? NO_QUEUED,
    readingPoint: state.readingPoints[chat.id] ?? null,
    ...(approval ? { approval } : {}),
  }];
}
