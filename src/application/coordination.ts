/** What a coordinator and its threads are told, and how the sidebar groups them. */
import { busyThreadIds, blockedThreadIds, type WorkspaceState } from "./workspace-state.js";
import { activitySections, type ActivitySections } from "./thread-order.js";
import { coordinationDecisions, coordinatorOf, coordinatedThreadIds, coordinatedThreads, deliveryLabel, isCoordinator, openDecisions, type CoordinationNote, type Decision, type ThreadBrief } from "../domain/coordination.js";
import type { Thread } from "../domain/thread.js";
import { wantsAttention } from "../domain/attention.js";

/** What a send carries for a coordinator: the thread it starts works under it with this brief, or its run delivers these waiting notes. */
export type CoordinationSend = {
  coordinatorId?: string;
  brief?: ThreadBrief;
  notes?: string[];
};

/** What a send that starts a thread carries for a coordinator, if anything. */
export function coordinationSendOf({ coordinatorId, brief }: CoordinationSend): { coordination?: CoordinationSend } {
  if (!coordinatorId && !brief) return {};
  return { coordination: { ...(coordinatorId ? { coordinatorId } : {}), ...(brief ? { brief } : {}) } };
}

/** The label on a coordinator's message that carries its threads' news rather than the user's words. */
export const COORDINATION_UPDATE_DETAIL = "Thread updates";

/** How much of a thread's last reply a coordinator is told when the thread ends its turn. */
const EXCERPT = 600;

/** Which kind of run the agent process starts, which decides the tools and instructions it gets. */
export function coordinationRole(threads: readonly Thread[], thread: Thread): "coordinator" | "member" | undefined {
  if (isCoordinator(thread)) return "coordinator";
  return coordinatorOf(threads, thread) ? "member" : undefined;
}

export function briefPrompt(brief: ThreadBrief): string {
  return [
    "---",
    "Brief from the coordinator that started this thread:",
    `The user's words: ${brief.intent}`,
    `Done when: ${brief.doneWhen}`,
    `Delivers: ${deliveryLabel(brief.delivers)}${brief.delivers === "report" ? " (no code changes)" : ""}`,
  ].join("\n");
}

function lastReply(thread: Thread): string | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.kind === "assistant" && message.text.trim()) return message.text.trim();
  }
  return undefined;
}

function excerpt(text: string) {
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text;
}

/** What a coordinator hears when one of its threads ends a turn. */
export function turnNote(thread: Thread, status: "succeeded" | "failed" | "cancelled", at: number): CoordinationNote {
  const ended = status === "succeeded" ? "ended its turn" : status === "failed" ? "failed" : "was stopped";
  const reply = lastReply(thread);
  return coordinationNote(thread.id, `"${thread.title}" ${ended}.${reply ? ` It last said: ${excerpt(reply)}` : ""}`, at);
}

export function coordinationNote(threadId: string, text: string, at: number): CoordinationNote {
  return { id: crypto.randomUUID(), threadId, text, at };
}

/** One line per thread working under the coordinator, as it stands right now. */
function roster(state: WorkspaceState, leadId: string): string[] {
  const busy = busyThreadIds(state);
  const blocked = blockedThreadIds(state);
  return coordinatedThreads(state.threads, leadId).map((thread) => {
    const status = blocked.has(thread.id) ? "waiting for the user's approval" : busy.has(thread.id) ? "working" : "idle";
    const parts = [`- "${thread.title}" [${thread.id}] · ${status}`];
    if (thread.report) parts.push(`reported ${thread.report.state}: ${thread.report.summary}`);
    for (const decision of openDecisions(thread)) parts.push(`waiting on the user to decide: ${decision.question}`);
    return parts.join(" · ");
  });
}

/**
 * What a coordinator's run is told beyond its prompt: the news it has not heard yet, and where each of
 * its threads stands. Notes the prompt already carries are left out.
 */
export function coordinationContext(state: WorkspaceState, lead: Thread, carried: readonly string[] = []): string {
  const notes = (lead.coordinationNotes ?? []).filter((note) => !carried.includes(note.id));
  const lines = roster(state, lead.id);
  const own = openDecisions(lead).map((decision) => `- ${decision.question}`);
  const sections = [
    ...(notes.length ? ["Updates from your threads you have not seen yet:", ...notes.map((note) => `- ${note.text}`)] : []),
    ...(lines.length ? ["Your threads right now:", ...lines] : []),
    ...(own.length ? ["Decisions you raised that the user has yet to answer:", ...own] : []),
  ];
  return sections.length ? `\n\n---\n${sections.join("\n")}` : "";
}

/** The message that wakes a coordinator with its threads' news, as the user sees it and as the agent reads it. */
export function coordinationUpdate(notes: CoordinationNote[]): { text: string; prompt: string } {
  const text = notes.map((note) => note.text).join("\n");
  return {
    text,
    prompt: `${text}\n\nThese are updates from threads working under you, not a message from the user. Decide what, if anything, the user needs to hear: outcomes, decisions waiting on them, and real blockers. Say nothing about progress. Start a thread for any follow-up work.`,
  };
}

/**
 * The activity lists with each coordinator standing for its threads: they are drawn under it rather
 * than in a list of their own, and it ranks by whichever of them wants the user most.
 */
export function coordinationSections(threads: Thread[], busy: Set<string>, blocked: Set<string>): ActivitySections {
  const members = coordinatedThreadIds(threads);
  if (!members.size && !threads.some((thread) => thread.decisions?.length)) return activitySections(threads, busy, blocked);
  const leads = threads.filter((thread) => isCoordinator(thread));
  const ranked = new Set(busy);
  const asking = new Set(blocked);
  const attention = new Set<string>();
  for (const lead of leads) {
    const coordination = [lead, ...coordinatedThreads(threads, lead.id)];
    if (coordination.some((thread) => blocked.has(thread.id) || openDecisions(thread).length)) asking.add(lead.id);
    if (coordination.some((thread) => busy.has(thread.id))) ranked.add(lead.id);
    if (coordination.some((thread) => thread !== lead && wantsAttention(thread))) attention.add(lead.id);
  }
  for (const thread of threads) if (!members.has(thread.id) && thread.role !== "coordinator" && openDecisions(thread).length) asking.add(thread.id);
  const listed = threads.filter((thread) => !members.has(thread.id));
  const sections = activitySections(listed, ranked, asking);
  if (!attention.size) return sections;
  /** A coordinator a finished thread is waiting behind leads as that thread would have. */
  const promoted = sections.threads.filter((thread) => attention.has(thread.id) && thread.snoozedUntil === undefined);
  if (!promoted.length) return sections;
  const moved = new Set(promoted.map((thread) => thread.id));
  return {
    priority: [...sections.priority, ...promoted],
    running: sections.running,
    threads: sections.threads.filter((thread) => !moved.has(thread.id)),
  };
}

/** Where a thread under a coordinator stands, in the words its card shows. */
export type CoordinatedThreadStatus = "approval" | "asking" | "working" | "blocked" | "done" | "failed" | "finished" | "idle";

export type CoordinatedThreadView = {
  thread: Thread;
  status: CoordinatedThreadStatus;
  summary: string | null;
};

export type CoordinationDecisionView = {
  thread: Thread;
  decision: Decision;
};

/** What the open thread shows: a coordinator its threads and open decisions, a thread its coordinator and brief. */
export type CoordinationView = {
  members: CoordinatedThreadView[];
  decisions: CoordinationDecisionView[];
  lead: Thread | null;
  brief: ThreadBrief | null;
  /** A thread under a coordinator with a decision of its own waiting on the user. */
  asking: boolean;
};

const NO_COORDINATION: CoordinationView = { members: [], decisions: [], lead: null, brief: null, asking: false };

export function coordinatedThreadStatus(thread: Thread, busy: Set<string>, blocked: Set<string>): CoordinatedThreadView {
  const question = openDecisions(thread)[0]?.question;
  if (blocked.has(thread.id)) return { thread, status: "approval", summary: null };
  if (question) return { thread, status: "asking", summary: question };
  if (busy.has(thread.id)) return { thread, status: "working", summary: thread.report?.state === "working" ? thread.report.summary : null };
  if (thread.report && thread.report.state !== "working") return { thread, status: thread.report.state, summary: thread.report.summary };
  if (thread.outcome === "failed") return { thread, status: "failed", summary: null };
  /** A thread that ended its turn without reporting has still finished it, which says more than idle. */
  if (thread.outcome === "finished") return { thread, status: "finished", summary: null };
  return { thread, status: "idle", summary: null };
}

export function coordinationView(threads: readonly Thread[], thread: Thread | undefined, busy: Set<string>, blocked: Set<string>): CoordinationView {
  if (!thread) return NO_COORDINATION;
  if (isCoordinator(thread)) {
    const members = coordinatedThreads(threads, thread.id).map((member) => coordinatedThreadStatus(member, busy, blocked));
    const decisions = coordinationDecisions(threads, thread.id);
    return members.length || decisions.length ? { ...NO_COORDINATION, members, decisions, brief: thread.brief ?? null } : NO_COORDINATION;
  }
  const lead = coordinatorOf(threads, thread) ?? null;
  /** A thread that left its coordinator with a decision still open is where that decision is answered now. */
  const decisions = lead ? [] : openDecisions(thread).map((decision) => ({ thread, decision }));
  if (!lead && !thread.brief && !decisions.length) return NO_COORDINATION;
  return { ...NO_COORDINATION, lead, decisions, brief: thread.brief ?? null, asking: Boolean(lead && openDecisions(thread).length) };
}
