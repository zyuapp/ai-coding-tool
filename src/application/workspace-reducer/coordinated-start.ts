/** What a run starting under a coordinator, or a coordinator's own, adds to the start every run makes. */
import { now } from "./shared.js";
import { withoutStarting } from "./proposals.js";
import { briefPrompt, coordinationNote, coordinatorPrompt } from "../coordination-messages.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { asCoordinator, isCoordinator, withCoordinationNote, withMemoryHeard, withoutCoordinationNotes, withoutProposals } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";
import { catalogOf } from "../state/engines.js";

/** A thread as its run starts under a coordinator, what it is told first, and what the run is sent. */
export type CoordinatedStart = { thread: Thread; prompt: string };

/**
 * A thread `located` in the checkout its run starts in, as coordination leaves it. A new thread a
 * coordinator starts works under it from its first run, and so does one a coordinator on another
 * computer starts here. One whose coordinator was archived or lost its role on the way still names
 * it, as the threads already under it do, so it is back under it with them. A new coordinator's
 * threads run on what it runs on itself until the user picks otherwise. A coordinator's run hears
 * everything its threads said since the last one and reads its memory whenever its session has yet
 * to. A message is more work for a thread, so one that was resolved is open again.
 */
export function coordinatedStart(state: WorkspaceState, pending: PendingRun, located: Thread, existing: Thread | undefined): CoordinatedStart {
  const lead = existing || pending.role === "coordinator" ? undefined : state.threads.find((item) => item.id === pending.coordination?.coordinatorId);
  const remoteLead = existing || pending.role === "coordinator" ? undefined : pending.coordination?.lead;
  const opened = !existing && pending.role === "coordinator" ? asCoordinator(catalogOf(state), located) : located;
  const joined = lead ? { ...opened, parentId: lead.id } : remoteLead ? { ...opened, remoteLead } : opened;
  const coordinating = isCoordinator(joined);
  const told = coordinating && joined.coordinationNotes ? withoutCoordinationNotes(joined, new Set(joined.coordinationNotes.map((note) => note.id))) : joined;
  const { resolvedAt: _reopened, ...thread } = coordinating ? withMemoryHeard(told) : told;
  /** A thread starting under a coordinator reads the brief it was handed and the memory it was started with. */
  const standing = joined !== opened ? briefPrompt(pending.coordination?.brief, pending.coordination?.memory) : briefPrompt(pending.coordination?.brief);
  const sent = `${pending.prompt}${standing ? `\n\n${standing}` : ""}`;
  /**
   * Any coordinator session that starts over history reads the seed, so one whose last session failed
   * before naming itself, or was dropped, still knows what came before and where read_thread finds it.
   */
  const seeded = coordinating && thread.continuation === undefined && (joined.messages.length > 0 || joined.historySummary !== undefined);
  return {
    thread,
    prompt: coordinating ? coordinatorPrompt(state, joined, sent, { carried: pending.coordination?.notes, fresh: seeded }) : sent,
  };
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
