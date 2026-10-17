/**
 * What the workspace puts on the desktop when a thread needs the user. The window decides whether
 * the user is somewhere it has to be reached; this only decides whether there is anything to say.
 */
import type { ThreadNotice } from "../contracts/ipc.js";
import { coordinatorOf, isCoordinator } from "../domain/coordination.js";
import type { Thread } from "../domain/thread.js";
import { lastReply } from "./coordination.js";
import type { WorkspaceEffect } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

type NoticeState = Pick<WorkspaceState, "notifications" | "threads" | "sideChats">;

/**
 * Why a thread wants the user: its turn finished or failed, it waits on an approval or a question,
 * it put a decision to them, it reported itself blocked, or a scheduled run found something.
 */
export type NoticeReason = "finished" | "failed" | "waiting" | "decision" | "blocked" | "finding";

/** The longest line a coordinator's reply puts on the desktop. */
const POSTED = 120;

/** The thread a side chat sits beside, which is whose notices it shares; any other thread is its own. */
function ownerOf(state: NoticeState, thread: Thread): Thread | undefined {
  const chat = state.sideChats.find((item) => item.id === thread.id);
  return chat ? state.threads.find((item) => item.id === chat.sourceThreadId) : thread;
}

/** The coordinator a thread's notices answer to: the thread itself when it is one, else the one it works under. */
function leadOf(state: NoticeState, thread: Thread | undefined): Thread | undefined {
  return isCoordinator(thread) ? thread : coordinatorOf(state.threads, thread);
}

/**
 * What a notice calls the thread. A side chat only exists beside another thread, and a thread under
 * a coordinator is one of its threads, so each names both.
 */
function noticeTitle(state: NoticeState, thread: Thread): string {
  const owner = ownerOf(state, thread);
  if (owner !== thread) return owner ? `${owner.title} · ${thread.title}` : thread.title;
  const lead = coordinatorOf(state.threads, thread);
  return lead ? `${lead.title} · ${thread.title}` : thread.title;
}

/**
 * Whether the user wants to hear this. A muted coordinator keeps back everything from itself and its
 * threads. A turn its thread finished speaks through the coordinator's reply, so only a turn the
 * user's own words started is theirs to hear about.
 */
function wanted(state: NoticeState, thread: Thread, reason: NoticeReason): boolean {
  const lead = leadOf(state, ownerOf(state, thread));
  if (lead?.muted) return false;
  if (reason !== "finished" || !coordinatorOf(state.threads, thread)) return true;
  return latestUserMessage(thread)?.origin === undefined;
}

function latestUserMessage(thread: Thread) {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.kind === "user" && !message.withdrawn) return message;
  }
  return undefined;
}

/** A line a thread wants in front of the user, kept back while notifications are off or the user does not want it. */
export function announced(state: NoticeState, thread: Thread, headline: string, reason: NoticeReason): WorkspaceEffect[] {
  if (!wanted(state, thread, reason)) return [];
  return announcedNotice(state, { taskId: thread.id, title: noticeTitle(state, thread), headline });
}

/** A notice already worded, such as one for a thread on another computer, under the same switch. */
export function announcedNotice(state: Pick<NoticeState, "notifications">, notice: ThreadNotice): WorkspaceEffect[] {
  if (!state.notifications) return [];
  return [{ type: "announce-thread", notice }];
}

/**
 * What a coordinator's finished turn says on the desktop: the first line of what it replied in that
 * turn, which is the coordinator posting, or nothing when it replied nothing.
 */
export function postedHeadline(thread: Thread, from: number): string | undefined {
  const line = lastReply(thread, from)?.split("\n", 1)[0]!.replace(/^#{1,6}\s+/, "").trim();
  if (!line) return undefined;
  return line.length > POSTED ? `${line.slice(0, POSTED - 1)}…` : line;
}
