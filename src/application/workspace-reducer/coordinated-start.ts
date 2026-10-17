/** What a run starting under a coordinator, or a coordinator's own, adds to the start every run makes. */
import { now } from "./shared.js";
import { withoutStarting } from "./proposals.js";
import { briefPrompt, coordinationNote, coordinatorPrompt } from "../coordination.js";
import { sessionHoldsWork } from "../thread-activity.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { createConversationMessage, type ConversationMessage } from "../../domain/conversation.js";
import { asCoordinator, canJoinCoordinator, isCoordinator, wantsFreshSession, withCoordinationNote, withMemoryHeard, withoutCoordinationNotes, withoutProposals } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";

/** A thread as its run starts under a coordinator, what it is told first, and what the run is sent. */
export type CoordinatedStart = { thread: Thread; notice: ConversationMessage[]; prompt: string; fresh: boolean };

/**
 * A thread `located` in the checkout its run starts in, as coordination leaves it. A new thread a
 * coordinator starts works under it from its first run, and so does one a coordinator on another
 * computer starts here; a new coordinator's threads run on what it runs on itself until the user
 * picks otherwise. A coordinator's run hears everything its threads said since the last one and reads
 * its memory whenever its session has yet to, and one whose session has grown past its budget starts
 * a fresh one, seeded from what this app keeps of it; a run picking up after a usage limit carries on
 * in the session it left. A message is more work for a thread, so one that was resolved is open again.
 */
export function coordinatedStart(state: WorkspaceState, pending: PendingRun, located: Thread, existing: Thread | undefined): CoordinatedStart {
  const lead = existing ? undefined : state.threads.find((item) => item.id === pending.coordination?.coordinatorId);
  const remoteLead = existing || pending.role === "coordinator" ? undefined : pending.coordination?.lead;
  const opened = !existing && pending.role === "coordinator" ? asCoordinator(located) : located;
  const joined = lead && canJoinCoordinator(opened, lead) ? { ...opened, parentId: lead.id } : remoteLead ? { ...opened, remoteLead } : opened;
  const coordinating = isCoordinator(joined);
  const fresh = !pending.warming && wantsFreshSession(joined, sessionHoldsWork(state, joined.id));
  const told = coordinating && joined.coordinationNotes ? withoutCoordinationNotes(joined, new Set(joined.coordinationNotes.map((note) => note.id))) : joined;
  const { resolvedAt: _reopened, ...open } = coordinating ? withMemoryHeard(told) : told;
  const thread = fresh ? withoutSession(open) : open;
  /** A thread starting under a coordinator reads the brief it was handed and the memory it was started with. */
  const standing = joined !== opened ? briefPrompt(pending.coordination?.brief, pending.coordination?.memory) : briefPrompt(pending.coordination?.brief);
  const sent = `${pending.prompt}${standing ? `\n\n${standing}` : ""}`;
  /**
   * Any coordinator session that starts over history reads the seed, so one whose last session failed
   * before naming itself, or was dropped, still knows what came before and where read_thread finds it.
   */
  const seeded = fresh || coordinating && thread.continuation === undefined && (joined.messages.length > 0 || joined.historySummary !== undefined);
  return {
    thread,
    notice: fresh ? [createConversationMessage("system", "Continued in a fresh session to keep this coordinator's context small.")] : [],
    prompt: coordinating ? coordinatorPrompt(state, joined, sent, { carried: pending.coordination?.notes, fresh: seeded }) : sent,
    fresh,
  };
}

/** A thread that resumes no session: its next run starts one, and its context meter starts over with it. */
function withoutSession({ continuation: _continuation, inheritedContinuation: _inherited, contextUsage: _context, ...thread }: Thread): Thread {
  return { ...thread, continuationStatus: "none" };
}

/** A suggestion the user started is `thread` now, which its coordinator hears without being woken by it. */
export function withSuggestionStarted(state: WorkspaceState, pending: PendingRun, existing: Thread | undefined, threads: Thread[], thread: Thread): Pick<WorkspaceState, "threads" | "startingProposals"> {
  const proposalId = existing ? undefined : pending.coordination?.proposalId;
  if (!proposalId) return { threads, startingProposals: state.startingProposals };
  const leadId = pending.coordination?.coordinatorId;
  return {
    threads: threads.map((item) => item.id === leadId ? suggestionHeard(item, proposalId, thread) : item),
    startingProposals: withoutStarting(state, proposalId).startingProposals,
  };
}

function suggestionHeard(lead: Thread, proposalId: string, thread: Thread): Thread {
  const proposal = lead.proposals?.find((item) => item.id === proposalId);
  const settledLead = withoutProposals(lead, new Set([proposalId]));
  if (!proposal || !isCoordinator(lead)) return settledLead;
  return withCoordinationNote(settledLead, coordinationNote(thread.id, `The user started your suggested thread "${proposal.title}" [${thread.id}].`, now(), { quiet: true }));
}
