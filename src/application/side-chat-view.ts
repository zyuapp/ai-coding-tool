import type { QueuedMessage, SideChat, WorkspaceState } from "./workspace-state.js";
import type { ReadingPoint } from "../contracts/commands.js";
import type { Annotation, AttachedFile, PastedText, StagedImage } from "../domain/conversation.js";
import type { RetryNotice } from "../domain/run.js";
import type { PendingQuestion } from "../domain/agent-question.js";
import { runStatusFor, type ApprovalView, type StreamingTail, type ThreadRunStatus } from "./thread-run-state.js";
import { annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";
import { coordinatedThreadStatus, type CoordinatedThreadStatus } from "./coordination.js";
import { projectFor, threadWorkspaceId } from "./thread-location.js";
import type { Thread } from "../domain/thread.js";

const NO_QUEUED: QueuedMessage[] = [];

/** A conversation drawn in a dock tab: its thread, its composer's draft, and its run as it stands. */
export type DockConversationView = {
  id: string;
  title: string;
  thread: Thread;
  prompt: string;
  annotations: Annotation[];
  pastes: PastedText[];
  images: StagedImage[];
  files: AttachedFile[];
  running: boolean;
  compacting: boolean;
  retrying: RetryNotice | null;
  status: ThreadRunStatus;
  streamingTail: StreamingTail | null;
  queuedMessages: QueuedMessage[];
  approval?: ApprovalView;
  question?: PendingQuestion;
  readingPoint: ReadingPoint;
};

export type SideChatView = SideChat & DockConversationView;

/** A thread under the coordinator in front, opened as a tab in its dock. */
export type ThreadTabView = DockConversationView & {
  standing: CoordinatedThreadStatus;
  summary: string | null;
  folder: string;
  workspaceId?: string;
};

/** One thread drawn in a dock tab, projected from the thread and its active run. */
function dockConversationView(state: WorkspaceState, thread: Thread): DockConversationView {
  const active = state.activeRuns[thread.id];
  const approval = active?.status === "awaiting-approval" ? state.approvals[active.runId] as ApprovalView | undefined : undefined;
  return {
    id: thread.id,
    title: thread.title,
    thread,
    prompt: state.prompts[thread.id] ?? "",
    annotations: annotationsFor(state, thread.id),
    pastes: pastesFor(state, thread.id),
    images: imagesFor(state, thread.id),
    files: filesFor(state, thread.id),
    running: Boolean(active),
    question: active?.questions?.[0],
    compacting: active?.status === "compacting",
    retrying: active?.retry ?? null,
    status: active ? "running" : runStatusFor(state, thread.id),
    streamingTail: state.streamingTails[thread.id] ?? null,
    queuedMessages: state.queuedMessages[thread.id] ?? NO_QUEUED,
    readingPoint: state.readingPoints[thread.id] ?? null,
    ...(approval ? { approval } : {}),
  };
}

/** One open side chat projected from its owning thread and active run. */
export function sideChatView(state: WorkspaceState, chat: SideChat): SideChatView[] {
  const thread = state.threads.find((item) => item.id === chat.id);
  return thread ? [{ ...chat, ...dockConversationView(state, thread) }] : [];
}

/** One thread's tab in its coordinator's dock, with where its work stands. */
export function threadTabView(state: WorkspaceState, taskId: string, busy: Set<string>, blocked: Set<string>): ThreadTabView[] {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread) return [];
  const { status: standing, summary } = coordinatedThreadStatus(thread, busy, blocked);
  const workspaceId = threadWorkspaceId(state, thread);
  return [{ ...dockConversationView(state, thread), standing, summary, folder: projectFor(state, thread)?.root ?? "", ...(workspaceId ? { workspaceId } : {}) }];
}
