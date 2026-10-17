/**
 * A coordinator and the threads it has handed work to. A thread works under a coordinator while its
 * `parentId` names a live thread whose role is coordinator; archiving the coordinator or taking its
 * role off lets every one of its threads stand on its own again, with nothing to undo.
 */
import type { Thread } from "./thread.js";
import type { AgentEffort } from "./run.js";
import { isThreadRole, type ThreadRole } from "./thread-role.js";
import { defaultEffortFor, defaultModelFor, effortForModel, engineForModel, isAgentEffort, isAgentModel, modelDelegable, modelTakesEffort, type AgentModel } from "./agent-engine.js";

/** A coordinator's run delegates and changes no files; a thread under one reports back to it. */
export type CoordinationRole = "coordinator" | "member";

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

export const COORDINATION_STATES = ["working", "blocked", "done", "failed"] as const;

export type CoordinationState = (typeof COORDINATION_STATES)[number];

/** Where a thread says its work stands, newest only. */
export type CoordinationReport = {
  state: CoordinationState;
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

/**
 * Something a coordinator has yet to hear about one of its threads. Urgent news reaches it without
 * waiting for its other threads. News written during a thread's run waits for that run to end. A
 * quiet note was waiting when the user stopped the coordinator: it is heard with the next wake but
 * never causes one.
 */
export type CoordinationNote = {
  id: string;
  threadId: string;
  text: string;
  at: number;
  urgent?: true;
  runId?: string;
  quiet?: true;
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
export const MAX_PURPOSE = 200;
export const MAX_MEMORY_NOTE = 500;
export const MAX_MEMORY_NOTES = 30;
export const MAX_PROPOSALS = 12;
export const MAX_PROPOSAL_TITLE = 120;
/**
 * How much context a coordinator's session may hold before its next run starts a fresh one. It is a
 * count rather than a share of the window, so a large window never means every wake re-reads more.
 */
export const COORDINATOR_CONTEXT_TOKENS = 80_000;

/** The groups a coordinator's Overview sorts its threads into, by what each one needs, most pressing first. */
export type OverviewGroup = "needs" | "review" | "working" | "done" | "resolved";

export const OVERVIEW_GROUPS: readonly OverviewGroup[] = ["needs", "review", "working", "done", "resolved"];

/** What folds in a coordinator's Overview: its groups of threads, and the sections below them. */
export type OverviewSection = OverviewGroup | "memory" | "usage";

const OVERVIEW_SECTIONS: readonly OverviewSection[] = [...OVERVIEW_GROUPS, "memory", "usage"];

export function isOverviewSection(value: unknown): value is OverviewSection {
  return typeof value === "string" && (OVERVIEW_SECTIONS as readonly string[]).includes(value);
}

/** How the user left one Overview section: folded or unfolded, and whether it shows every row. */
export type OverviewFold = { open?: boolean; all?: true };

export type OverviewFolds = Partial<Record<OverviewSection, OverviewFold>>;

/** One thing the user wants a coordinator, and every thread it starts, to keep in mind. */
export type MemoryNote = { id: string; text: string; at: number };

/**
 * What a coordinator keeps for the user: what it is for, and notes on how they want it to work.
 * `revision` grows with every change, so a note added by one is named `n<revision>` and no two notes
 * ever share a name. `heard` is the revision the coordinator's session last read, absent when it has
 * read none. `purposeCleared` is the revision that took the purpose off, kept until one is set
 * again, so a session that read the old one is told it is gone.
 */
export type CoordinatorMemory = {
  purpose?: string;
  purposeCleared?: number;
  notes: MemoryNote[];
  revision: number;
  heard?: number;
};

/** One change to a coordinator's memory. Only the user edits a note in place; a coordinator forgets and remembers. */
export type MemoryChange =
  | { kind: "purpose"; purpose: string | null }
  | { kind: "remember"; text: string }
  | { kind: "edit"; noteId: string; text: string }
  | { kind: "forget"; noteId: string };

/**
 * A thread a coordinator suggests rather than starts: what start_thread takes, and a short title that
 * only labels the suggestion.
 */
export type ProposalRequest = {
  title: string;
  prompt: string;
  brief?: ThreadBrief;
  project?: string;
  worktree?: boolean;
  worktreeId?: string;
  model?: AgentModel;
  effort?: AgentEffort;
  role?: ThreadRole;
};

/** Where a suggested thread starts: the project and checkout the coordinator's start resolved to when it was suggested. */
export type ProposalPlace = { project?: string; worktree?: boolean; worktreeId?: string };

/**
 * A thread a coordinator suggested, waiting for the user to start or dismiss it. A model and effort
 * are kept only when the coordinator named them, so a suggestion started later runs on whatever the
 * coordinator's threads run on by then. `error` says why the user's last start of it failed.
 */
export type ThreadProposal = {
  id: string;
  title: string;
  prompt: string;
  brief: ThreadBrief;
  place: ProposalPlace;
  model?: AgentModel;
  effort?: AgentEffort;
  role?: ThreadRole;
  proposedAt: number;
  error?: string;
};

/**
 * What the user can tell a thread under a coordinator to do next about its pull request, most
 * pressing first, each said to the thread in the user's own words.
 */
export const NEXT_STEPS = [
  { id: "resolve-conflicts", label: "Resolve conflicts", text: "The pull request has merge conflicts with its base branch. Resolve them and push." },
  { id: "fix-ci", label: "Fix CI", text: "The pull request's checks are failing. Find out why, fix them, and push." },
  { id: "address-comments", label: "Address comments", text: "The pull request has review comments asking for changes. Address each one, push, and reply on the pull request." },
  { id: "merge", label: "Merge it", text: "Merge the pull request." },
  { id: "create-pull-request", label: "Create PR", text: "Open a pull request for this work." },
] as const;

export type NextStep = (typeof NEXT_STEPS)[number]["id"];

export function isNextStep(value: unknown): value is NextStep {
  return NEXT_STEPS.some((step) => step.id === value);
}

export function nextStepOf(id: NextStep): (typeof NEXT_STEPS)[number] {
  return NEXT_STEPS.find((step) => step.id === id)!;
}

export function isCoordinator(thread: Thread | undefined): boolean {
  return thread?.role === "coordinator" && thread.archivedAt === undefined;
}

/**
 * Whether a coordinator's next run starts a fresh session rather than resuming one whose context has
 * grown past its budget. A native goal lives in its session, so one still running keeps it.
 */
export function wantsFreshSession(thread: Thread, goalActive: boolean): boolean {
  return isCoordinator(thread) && thread.continuation !== undefined && (thread.contextUsage?.tokens ?? 0) >= COORDINATOR_CONTEXT_TOKENS && !goalActive;
}

/** What a coordinator's threads run on unless one is started on something else. */
export type ThreadModelChoice = { model: AgentModel; effort?: AgentEffort };

/**
 * What a coordinator's threads run on: the user's choice, else what the coordinator runs on itself,
 * else its engine's default, whichever is first that a thread under a coordinator may run on. An
 * effort the model does not take moves to the nearest one it does.
 */
export function threadModelOf(lead: Thread): ThreadModelChoice {
  const chosen = lead.threadModel?.model;
  const own = lead.model ?? defaultModelFor(lead.engine);
  const model = chosen && modelDelegable(chosen) ? chosen : modelDelegable(own) ? own : defaultModelFor(lead.engine);
  if (!modelTakesEffort(model)) return { model };
  return { model, effort: effortForModel(model, lead.threadModel?.effort ?? lead.effort ?? defaultEffortFor(engineForModel(model))) };
}

/** Why a thread under a coordinator, started or chosen for, may not run on `model`. */
export function undelegable(model: AgentModel): string {
  return `Threads under a coordinator cannot run on the ${model} model. Pick another model.`;
}

/** A thread taking the coordinator role, its threads to run on what it runs on until the user picks otherwise. */
export function asCoordinator(thread: Thread): Thread {
  return { ...thread, role: "coordinator", threadModel: thread.threadModel ?? threadModelOf(thread) };
}

/** The thread itself when it is a live coordinator. */
function coordinator(thread: Thread | undefined): Thread | undefined {
  return isCoordinator(thread) ? thread : undefined;
}

/** The coordinator a thread works under, while that thread is still one. */
export function coordinatorOf(threads: readonly Thread[], thread: Thread | undefined): Thread | undefined {
  if (!thread?.parentId || thread.role === "coordinator") return undefined;
  return coordinator(threads.find((item) => item.id === thread.parentId));
}

/** The threads working under a coordinator, in the order the list holds them. */
export function coordinatedThreads(threads: readonly Thread[], leadId: string): Thread[] {
  const lead = threads.find((thread) => thread.id === leadId);
  if (!isCoordinator(lead)) return [];
  return threads.filter((thread) => thread.parentId === leadId && thread.archivedAt === undefined && thread.role !== "coordinator");
}

/** Every thread drawn under a coordinator rather than in a list of its own. */
export function coordinatedThreadIds(threads: readonly Thread[]): Set<string> {
  const leads = new Set(threads.filter(isCoordinator).map((thread) => thread.id));
  const members = new Set<string>();
  for (const thread of threads) {
    if (thread.parentId && leads.has(thread.parentId) && thread.role !== "coordinator") members.add(thread.id);
  }
  return members;
}

/** The named threads and every thread working under the coordinators among them. */
export function withCoordinated(threads: readonly Thread[], ids: Set<string>): Set<string> {
  const leads = new Set(threads.filter((thread) => ids.has(thread.id) && isCoordinator(thread)).map((thread) => thread.id));
  if (!leads.size) return ids;
  const all = new Set(ids);
  for (const thread of threads) if (thread.parentId && leads.has(thread.parentId) && thread.role !== "coordinator") all.add(thread.id);
  return all;
}

/** A thread can move under a coordinator other than itself, unless it coordinates threads of its own. */
export function canJoinCoordinator(thread: Thread, lead: Thread | undefined): lead is Thread {
  return lead !== undefined && isCoordinator(lead) && lead.id !== thread.id && thread.role !== "coordinator" && thread.archivedAt === undefined;
}

export function openDecisions(thread: Thread): Decision[] {
  return (thread.decisions ?? []).filter((decision) => decision.answer === undefined);
}

/** Every decision waiting on the user from a coordinator and its threads, oldest first. */
export function coordinationDecisions(threads: readonly Thread[], leadId: string): Array<{ thread: Thread; decision: Decision }> {
  const lead = coordinator(threads.find((thread) => thread.id === leadId));
  if (!lead) return [];
  return [lead, ...coordinatedThreads(threads, leadId)]
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

/**
 * A coordinator's memory with one change made, or why it cannot be. A change that alters nothing
 * hands the thread back as it was. `heard` says the coordinator made the change itself, so its
 * session knows of it, which counts only when that session had read everything before it.
 */
export function withMemoryChange(thread: Thread, change: MemoryChange, at: number, { heard }: { heard: boolean }): { thread: Thread; noteId?: string } | { error: string } {
  /** A coordinator with nothing in memory has, in effect, read all of it. */
  const memory: CoordinatorMemory = thread.memory ?? { notes: [], revision: 0, heard: 0 };
  const revision = memory.revision + 1;
  let { purpose, purposeCleared, notes } = memory;
  let noteId: string | undefined;
  switch (change.kind) {
    case "purpose": {
      const asked = change.purpose?.trim() ?? "";
      if (asked.length > MAX_PURPOSE) return { error: `A purpose can be at most ${MAX_PURPOSE} characters.` };
      if (asked === (purpose ?? "")) return { thread };
      purpose = asked || undefined;
      purposeCleared = purpose ? undefined : revision;
      break;
    }
    case "remember": {
      const text = noteText(change.text);
      if ("error" in text) return text;
      if (notes.length >= MAX_MEMORY_NOTES) return { error: `Memory holds at most ${MAX_MEMORY_NOTES} notes. Forget one first.` };
      noteId = `n${revision}`;
      notes = [...notes, { id: noteId, text: text.text, at }];
      break;
    }
    case "edit": {
      const note = notes.find((item) => item.id === change.noteId);
      if (!note) return { error: `No note has the ID ${change.noteId}.` };
      const text = noteText(change.text);
      if ("error" in text) return text;
      if (text.text === note.text) return { thread };
      noteId = note.id;
      notes = notes.map((item) => item === note ? { ...item, text: text.text, at } : item);
      break;
    }
    case "forget": {
      if (!notes.some((item) => item.id === change.noteId)) return { error: `No note has the ID ${change.noteId}.` };
      noteId = change.noteId;
      notes = notes.filter((item) => item.id !== change.noteId);
      break;
    }
  }
  /** A memory the session had not finished reading stays unread, whoever changed it. */
  const read = heard && memory.heard === memory.revision ? revision : memory.heard;
  const changed: CoordinatorMemory = {
    ...(purpose ? { purpose } : {}),
    ...(purposeCleared === undefined ? {} : { purposeCleared }),
    notes,
    revision,
    ...(read === undefined ? {} : { heard: read }),
  };
  return { thread: { ...thread, memory: changed }, ...(noteId ? { noteId } : {}) };
}

function noteText(value: string): { text: string } | { error: string } {
  const text = value.trim();
  if (!text) return { error: "A note needs some text." };
  if (text.length > MAX_MEMORY_NOTE) return { error: `A note can be at most ${MAX_MEMORY_NOTE} characters.` };
  return { text };
}

/** The coordinator's session has read its memory as it stands. */
export function withMemoryHeard(lead: Thread): Thread {
  const memory = lead.memory;
  return memory && memory.heard !== memory.revision ? { ...lead, memory: { ...memory, heard: memory.revision } } : lead;
}

/** The coordinator's session can no longer be trusted to hold its memory, as after its context was compacted. */
export function withMemoryUnheard(thread: Thread): Thread {
  if (thread.memory?.heard === undefined) return thread;
  const { heard: _read, ...memory } = thread.memory;
  return { ...thread, memory };
}

/** A coordinator with more suggestions waiting, as many as there is room for; the ones already waiting stay first. */
export function withProposals(lead: Thread, proposals: readonly ThreadProposal[]): Thread {
  const held = lead.proposals ?? [];
  const added = proposals.slice(0, Math.max(0, MAX_PROPOSALS - held.length));
  return added.length ? { ...lead, proposals: [...held, ...added] } : lead;
}

/** A coordinator with the named suggestions gone, started or dismissed. */
export function withoutProposals(lead: Thread, ids: ReadonlySet<string>): Thread {
  const held = lead.proposals ?? [];
  const rest = held.filter((proposal) => !ids.has(proposal.id));
  if (rest.length === held.length) return lead;
  if (rest.length) return { ...lead, proposals: rest };
  const { proposals: _gone, ...thread } = lead;
  return thread;
}

/** A suggestion with why its last start failed, or with that cleared for another try. */
export function withProposalError(lead: Thread, id: string, error: string | undefined): Thread {
  const proposal = lead.proposals?.find((item) => item.id === id);
  if (!proposal || proposal.error === error) return lead;
  const { error: _cleared, ...rest } = proposal;
  const marked: ThreadProposal = error === undefined ? rest : { ...rest, error };
  return { ...lead, proposals: lead.proposals!.map((item) => item === proposal ? marked : item) };
}

export function withCoordinationNote(lead: Thread, note: CoordinationNote): Thread {
  return { ...lead, coordinationNotes: [...lead.coordinationNotes ?? [], note].slice(-MAX_NOTES) };
}

/** Takes off the notes a run heard, leaving any that arrived after it set off. */
export function withoutCoordinationNotes(lead: Thread, heard: ReadonlySet<string>): Thread {
  const rest = (lead.coordinationNotes ?? []).filter((note) => !heard.has(note.id));
  if (rest.length) return { ...lead, coordinationNotes: rest };
  const { coordinationNotes: _delivered, ...thread } = lead;
  return thread;
}

export function deliveryLabel(delivers: Delivery): string {
  return DELIVERIES.find((delivery) => delivery.id === delivers)!.label;
}

export function isDelivery(value: unknown): value is Delivery {
  return DELIVERIES.some((delivery) => delivery.id === value);
}

export function isCoordinationState(value: unknown): value is CoordinationState {
  return COORDINATION_STATES.includes(value as CoordinationState);
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

/** Shape only: whether the model may run a coordinator's threads, and takes the effort, is decided where it is read. */
export function isThreadModelChoice(value: unknown): value is ThreadModelChoice {
  return isRecord(value) && isAgentModel(value.model) && (value.effort === undefined || isAgentEffort(value.effort));
}

function isMemoryNote(value: unknown): value is MemoryNote {
  return isRecord(value) && text(value.id, 200) && typeof value.text === "string" && finite(value.at);
}

/** Shape only, so a memory written under a longer limit still loads. */
export function isCoordinatorMemory(value: unknown): value is CoordinatorMemory {
  return isRecord(value)
    && (value.purpose === undefined || typeof value.purpose === "string")
    && (value.purposeCleared === undefined || Number.isSafeInteger(value.purposeCleared))
    && Array.isArray(value.notes) && value.notes.every(isMemoryNote)
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    && (value.heard === undefined || finite(value.heard));
}

/** A change as it arrives from outside the window, held to the limits a new one is written under. */
export function isMemoryChange(value: unknown): value is MemoryChange {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "purpose": return value.purpose === null || typeof value.purpose === "string" && value.purpose.length <= MAX_PURPOSE;
    case "remember": return text(value.text, MAX_MEMORY_NOTE);
    case "edit": return text(value.noteId, 200) && text(value.text, MAX_MEMORY_NOTE);
    case "forget": return text(value.noteId, 200);
    default: return false;
  }
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || text(value, max);
}

/** A suggestion as it arrives from a run, held to the limits a new one is written under. */
export function isProposalRequest(value: unknown): value is ProposalRequest {
  return isRecord(value) && text(value.title, MAX_PROPOSAL_TITLE) && typeof value.prompt === "string" && value.prompt.trim().length > 0
    && (value.brief === undefined || isThreadBrief(value.brief))
    && optionalText(value.project, 4_096)
    && (value.worktree === undefined || typeof value.worktree === "boolean")
    && optionalText(value.worktreeId, 200)
    && (value.model === undefined || isAgentModel(value.model))
    && (value.effort === undefined || isAgentEffort(value.effort))
    && (value.role === undefined || isThreadRole(value.role));
}

function isProposalPlace(value: unknown): value is ProposalPlace {
  return isRecord(value)
    && (value.project === undefined || typeof value.project === "string")
    && (value.worktree === undefined || typeof value.worktree === "boolean")
    && (value.worktreeId === undefined || typeof value.worktreeId === "string");
}

/** Shape only, so a suggestion written under a longer limit still loads. */
export function isThreadProposal(value: unknown): value is ThreadProposal {
  return isRecord(value) && text(value.id, 200) && typeof value.title === "string" && typeof value.prompt === "string"
    && isThreadBrief(value.brief) && isProposalPlace(value.place)
    && (value.model === undefined || isAgentModel(value.model))
    && (value.effort === undefined || isAgentEffort(value.effort))
    && (value.role === undefined || isThreadRole(value.role))
    && finite(value.proposedAt)
    && (value.error === undefined || typeof value.error === "string");
}

export function isCoordinationReport(value: unknown): value is CoordinationReport {
  return isRecord(value) && isCoordinationState(value.state) && text(value.summary, MAX_SUMMARY) && finite(value.at);
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

export function isCoordinationNote(value: unknown): value is CoordinationNote {
  return isRecord(value) && text(value.id, 200) && text(value.threadId, 200) && typeof value.text === "string" && finite(value.at)
    && (value.urgent === undefined || value.urgent === true)
    && (value.runId === undefined || text(value.runId, 200))
    && (value.quiet === undefined || value.quiet === true);
}
