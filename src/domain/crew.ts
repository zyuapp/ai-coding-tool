/**
 * A coordinator and the threads it has handed work to. A thread works under a coordinator while its
 * `parentId` names a live thread whose role is coordinator; archiving the coordinator or taking its
 * role off lets every one of its threads stand on its own again, with nothing to undo.
 */
import type { Thread } from "./thread.js";

/** A coordinator's run delegates and changes no files; a thread under one reports back to it. */
export type CrewRole = "coordinator" | "member";

/** How a thread's work lands. */
export const DELIVERIES = [
  { id: "pull-request", label: "Pull request" },
  { id: "commit", label: "Commits" },
  { id: "report", label: "Report" },
] as const;

export type Delivery = (typeof DELIVERIES)[number]["id"];

/** What a coordinator hands a thread with its first message: the user's own words, and what finishing means. */
export type ThreadBrief = {
  intent: string;
  doneWhen: string;
  delivers: Delivery;
};

export const CREW_STATES = ["working", "blocked", "done", "failed"] as const;

export type CrewState = (typeof CREW_STATES)[number];

/** Where a thread says its work stands, newest only. */
export type CrewReport = {
  state: CrewState;
  summary: string;
  at: number;
};

export type DecisionOption = {
  label: string;
  description?: string;
  recommended?: true;
};

/** A choice only the user can make. It stays open until answered, whatever the runs do meanwhile. */
export type Decision = {
  id: string;
  question: string;
  context?: string;
  options: DecisionOption[];
  raisedAt: number;
  answer?: string;
  answeredAt?: number;
};

/** Something a coordinator has yet to hear about one of its threads. */
export type CrewNote = {
  id: string;
  threadId: string;
  text: string;
  at: number;
};

export const MAX_BRIEF_FIELD = 4_000;
export const MAX_SUMMARY = 500;
export const MAX_QUESTION = 300;
export const MAX_DECISION_CONTEXT = 2_000;
export const MAX_OPTION_LABEL = 120;
export const MAX_OPTION_DESCRIPTION = 300;
export const MAX_OPTIONS = 5;
export const MAX_ANSWER = 4_000;
/** Answered decisions are history; only the newest are kept. */
const MAX_DECISIONS = 20;
const MAX_NOTES = 50;

export function isCoordinator(thread: Thread | undefined): boolean {
  return thread?.role === "coordinator" && thread.archivedAt === undefined;
}

/** The thread itself when it is a live coordinator. */
function coordinator(thread: Thread | undefined): Thread | undefined {
  return isCoordinator(thread) ? thread : undefined;
}

/** The coordinator a thread works under, while that thread is still one. */
export function crewLead(threads: readonly Thread[], thread: Thread | undefined): Thread | undefined {
  if (!thread?.parentId || thread.role === "coordinator") return undefined;
  return coordinator(threads.find((item) => item.id === thread.parentId));
}

/** The threads working under a coordinator, in the order the list holds them. */
export function crewMembers(threads: readonly Thread[], leadId: string): Thread[] {
  const lead = threads.find((thread) => thread.id === leadId);
  if (!isCoordinator(lead)) return [];
  return threads.filter((thread) => thread.parentId === leadId && thread.archivedAt === undefined && thread.role !== "coordinator");
}

/** Every thread drawn under a coordinator rather than in a list of its own. */
export function crewMemberIds(threads: readonly Thread[]): Set<string> {
  const leads = new Set(threads.filter(isCoordinator).map((thread) => thread.id));
  const members = new Set<string>();
  for (const thread of threads) {
    if (thread.parentId && leads.has(thread.parentId) && thread.role !== "coordinator") members.add(thread.id);
  }
  return members;
}

/** The named threads and every thread working under the coordinators among them. */
export function withCrews(threads: readonly Thread[], ids: Set<string>): Set<string> {
  const leads = new Set(threads.filter((thread) => ids.has(thread.id) && isCoordinator(thread)).map((thread) => thread.id));
  if (!leads.size) return ids;
  const all = new Set(ids);
  for (const thread of threads) if (thread.parentId && leads.has(thread.parentId) && thread.role !== "coordinator") all.add(thread.id);
  return all;
}

/** A thread can move under a coordinator other than itself, unless it coordinates threads of its own. */
export function canJoinCrew(thread: Thread, lead: Thread | undefined): lead is Thread {
  return lead !== undefined && isCoordinator(lead) && lead.id !== thread.id && thread.role !== "coordinator" && thread.archivedAt === undefined;
}

export function openDecisions(thread: Thread): Decision[] {
  return (thread.decisions ?? []).filter((decision) => decision.answer === undefined);
}

/** Every decision waiting on the user from a coordinator and its threads, oldest first. */
export function crewDecisions(threads: readonly Thread[], leadId: string): Array<{ thread: Thread; decision: Decision }> {
  const lead = coordinator(threads.find((thread) => thread.id === leadId));
  if (!lead) return [];
  return [lead, ...crewMembers(threads, leadId)]
    .flatMap((thread) => openDecisions(thread).map((decision) => ({ thread, decision })))
    .sort((left, right) => left.decision.raisedAt - right.decision.raisedAt);
}

export function withDecision(thread: Thread, decision: Decision): Thread {
  const kept = [...thread.decisions ?? [], decision];
  const answered = kept.filter((item) => item.answer !== undefined);
  const excess = Math.max(0, kept.length - MAX_DECISIONS);
  const dropped = new Set(answered.slice(0, excess).map((item) => item.id));
  return { ...thread, decisions: kept.filter((item) => !dropped.has(item.id)) };
}

export function withAnswer(thread: Thread, decisionId: string, answer: string, at: number): Thread {
  return {
    ...thread,
    decisions: (thread.decisions ?? []).map((decision) => decision.id === decisionId ? { ...decision, answer, answeredAt: at } : decision),
  };
}

export function withCrewNote(lead: Thread, note: CrewNote): Thread {
  return { ...lead, crewNotes: [...lead.crewNotes ?? [], note].slice(-MAX_NOTES) };
}

/** Takes off the notes a run heard, leaving any that arrived after it set off. */
export function withoutCrewNotes(lead: Thread, heard: ReadonlySet<string>): Thread {
  const rest = (lead.crewNotes ?? []).filter((note) => !heard.has(note.id));
  if (rest.length) return { ...lead, crewNotes: rest };
  const { crewNotes: _delivered, ...thread } = lead;
  return thread;
}

export function deliveryLabel(delivers: Delivery): string {
  return DELIVERIES.find((delivery) => delivery.id === delivers)!.label;
}

export function isDelivery(value: unknown): value is Delivery {
  return DELIVERIES.some((delivery) => delivery.id === value);
}

export function isCrewState(value: unknown): value is CrewState {
  return CREW_STATES.includes(value as CrewState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isThreadBrief(value: unknown): value is ThreadBrief {
  return isRecord(value) && text(value.intent, MAX_BRIEF_FIELD) && text(value.doneWhen, MAX_BRIEF_FIELD) && isDelivery(value.delivers);
}

export function isCrewReport(value: unknown): value is CrewReport {
  return isRecord(value) && isCrewState(value.state) && text(value.summary, MAX_SUMMARY) && finite(value.at);
}

export function isDecisionOption(value: unknown): value is DecisionOption {
  return isRecord(value) && text(value.label, MAX_OPTION_LABEL)
    && (value.description === undefined || text(value.description, MAX_OPTION_DESCRIPTION))
    && (value.recommended === undefined || value.recommended === true);
}

/** What a run may ask: the question, and the options it offers. The window stamps the rest. */
export type DecisionRequest = Pick<Decision, "question" | "context" | "options">;

export function isDecisionRequest(value: unknown): value is DecisionRequest {
  return isRecord(value) && text(value.question, MAX_QUESTION)
    && (value.context === undefined || text(value.context, MAX_DECISION_CONTEXT))
    && Array.isArray(value.options) && value.options.length <= MAX_OPTIONS && value.options.every(isDecisionOption);
}

export function isDecision(value: unknown): value is Decision {
  if (!isRecord(value) || !isDecisionRequest(value)) return false;
  const decision = value as Record<string, unknown>;
  return text(decision.id, 200) && finite(decision.raisedAt)
    && (decision.answer === undefined || text(decision.answer, MAX_ANSWER))
    && (decision.answeredAt === undefined || finite(decision.answeredAt));
}

export function isCrewNote(value: unknown): value is CrewNote {
  return isRecord(value) && text(value.id, 200) && text(value.threadId, 200) && typeof value.text === "string" && finite(value.at);
}
