/** A coordinator's suggestions, and the threads it asked for on other computers: filed, started or allowed, turned down, and settled. */
import { reduceSending } from "./sending.js";
import { proposalSettledIn, proposalStartingIn, runsOf } from "./run-edits.js";
import { now } from "./shared.js";
import { afterward, andThen, applied, failed, type SliceTransition, type Step } from "./slice.js";
import { editThread, threadsOf } from "./thread-edits.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { coordinationNote, memoryPrompt, requestHeadline } from "../coordination-messages.js";
import { announced } from "../notices.js";
import { caughtStartComputer, catchesStart, withoutCaughtStart, withStartLanded } from "../outstanding-stops.js";
import { newThreadSend, proposalSend } from "../thread-starts.js";
import { ledStartRefusal, sendFor } from "../computers.js";
import type { PairedComputer } from "../state/computers.js";
import type { WorkspaceState } from "../workspace-state.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { coordinatorOf, isCoordinator, withCoordinationNote, withoutProposals, withProposalCarried, withProposalError, withProposals, type CoordinationThread, type ThreadProposal } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";

export const PROPOSAL_INPUTS = ["coordination.proposed", "proposal.dismiss", "proposal.start", "proposal.settled"] as const;
type ProposalInput = Extract<WorkspaceInput, { type: (typeof PROPOSAL_INPUTS)[number] }>;

/** What a suggestion changes: coordination's own thread fields, and which suggestions the runs have starting. */
type ProposalStep = Step<CoordinationThread>;

const ASKER_GONE = "The thread that asked for this no longer works under this coordinator.";

export function reduceProposals(state: WorkspaceState, input: ProposalInput): SliceTransition<Record<never, never>, CoordinationThread> {
  if (input.type === "proposal.start" || input.type === "proposal.settled") return proposalStarts(state, input);
  switch (input.type) {
    /**
     * Suggestions wait for the user, as many as there is room for. Nothing starts until the user starts
     * it. A thread under the coordinator asking to start one on another computer is put to the user at
     * once, as its decisions are, since no reply of the coordinator's says so; what the coordinator
     * asks for itself, its reply says.
     */
    case "coordination.proposed": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return {};
      const proposed = withProposals(lead, input.proposals);
      if (proposed === lead) return {};
      const filed = editThread(threadsOf<CoordinationThread>(state), lead.id, () => ({ proposals: proposed.proposals }));
      const held = new Set(lead.proposals?.map((proposal) => proposal.id));
      const asked = proposed.proposals!.filter((proposal) => !held.has(proposal.id) && proposal.from !== undefined);
      const after = afterward(state, { edits: [filed] });
      return { edits: [filed], effects: asked.flatMap((proposal) => proposal.place.computer ? announced(after, lead, requestHeadline(proposal, proposal.place.computer), "request") : []) };
    }

    /**
     * What the user turned down is gone, and its coordinator hears so with its next wake. One already
     * starting is past turning down; dismissing them all means the suggestions here, each thread asked
     * for on another computer being allowed or denied on its own. One elsewhere that was allowed and
     * carried there may have started with its answer lost, so it is given up on rather than denied;
     * one refused here before it ever went is denied, as it never left.
     */
    case "proposal.dismiss": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return {};
      const declined = targetedProposals(state, lead, input);
      if (!declined.length) return {};
      const titles = declined.map((proposal) => `"${proposal.title}"`);
      const { place, carried } = declined[0]!;
      const denied = place.computer;
      const text = denied ? carried ? `The user gave up on starting ${titles[0]} on ${denied.name}. If it started there after all, you will hear from it.`
        : `The user did not allow ${titles[0]} to run on ${denied.name}.`
        : titles.length === 1 ? `The user declined the suggested thread ${titles[0]}.` : `The user declined the suggested threads ${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}.`;
      const note = coordinationNote(lead.id, text, now(), { quiet: true });
      return { edits: [editThread(threadsOf<CoordinationThread>(state), lead.id, (item) => {
        const told = withCoordinationNote(withoutProposals(item, new Set(declined.map((proposal) => proposal.id))), note);
        return { proposals: told.proposals, coordinationNotes: told.coordinationNotes };
      })] };
    }
  }
}

function proposalStarts(state: WorkspaceState, input: Extract<ProposalInput, { type: "proposal.start" | "proposal.settled" }>): ProposalStep {
  switch (input.type) {
    /**
     * The user starts a suggestion, or every one here not already starting, as its coordinator would
     * have started it then, or allows one on another computer in the place they picked. One that
     * cannot start keeps its row and says why.
     */
    case "proposal.start": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return {};
      const waiting = targetedProposals(state, lead, input);
      /** Start all is every start in turn; a refusal among them is the one said back. */
      let step: ProposalStep = {};
      for (const proposal of waiting) {
        let started: ProposalStep = {};
        const { result: _joined, ...joined } = andThen(state, step, (next) => (started = proposal.place.computer ? startElsewhere(next, lead.id, proposal.id, input.place) : startProposal(next, lead.id, proposal.id)));
        const result = started.result?.ok === false ? started.result : step.result;
        step = result ? { ...joined, result } : joined;
      }
      return step;
    }

    case "proposal.settled":
      return proposalSettled(state, input);
  }
}

/**
 * A thread a coordinator here allowed on another computer starting there, or failing to, which is a
 * thread on that computer now that tells the coordinator so itself once it shows up there. A start
 * whose answer was lost settles all the same once its thread shows up there; one Stop all caught on
 * its way has nothing left to say, and is let go only once that computer said it started nothing,
 * since one whose answer was lost may still land, and is stopped then. Any other waits to be allowed again.
 */
function proposalSettled(state: WorkspaceState, input: Extract<ProposalInput, { type: "proposal.settled" }>): ProposalStep {
  const lead = state.threads.find((item) => item.id === input.taskId);
  if (input.threadId !== undefined) {
    const proposal = lead?.proposals?.find((item) => item.id === input.proposalId);
    const place = proposal?.place.computer?.id ?? caughtStartComputer(lead, input.proposalId);
    return landedStep(state, input.taskId, input.proposalId, { id: input.threadId }, state.computers.paired.find((item) => item.id === place));
  }
  if (!lead || !catchesStart(lead, input.proposalId)) return proposalFailure(state, input.taskId, input.proposalId, input.message ?? "The thread did not start.");
  const refused = input.refused ? [editThread(threadsOf<CoordinationThread>(state), lead.id, (item) => ({ caughtStarts: withoutCaughtStart(item, input.proposalId).caughtStarts }))] : [];
  return { edits: [...refused, proposalSettledIn(runsOf(state), input.proposalId)] };
}

/**
 * A thread a coordinator here allowed on `computer` having landed there, as that computer answered
 * or as the thread itself shows up there, whichever is first heard: its card is gone, and a start
 * Stop all caught on its way is stopped as it lands. Its run is the thread's first, so one first
 * seen past a turn of its own is past stopping: a run going there now is someone's since, and is
 * left alone. Hearing it again changes nothing.
 */
export function proposalLanded(state: WorkspaceState, leadId: string, proposalId: string, landed: Pick<Thread, "id" | "runEndedAt">, computer: PairedComputer | undefined): WorkspaceTransition {
  return applied(state, landedStep(state, leadId, proposalId, landed, computer));
}

function landedStep(state: WorkspaceState, leadId: string, proposalId: string, landed: Pick<Thread, "id" | "runEndedAt">, computer: PairedComputer | undefined): ProposalStep {
  const threadId = landed.id;
  const lead = state.threads.find((item) => item.id === leadId);
  const carded = lead?.proposals?.some((item) => item.id === proposalId) === true;
  const caught = catchesStart(lead, proposalId);
  if (!carded && !caught && !state.startingProposals.includes(proposalId)) return {};
  const uncarded = carded ? editThread(threadsOf<CoordinationThread>(state), leadId, (item) => ({ proposals: withoutProposals(item, new Set([proposalId])).proposals })) : threadsOf<CoordinationThread>(state);
  const started = proposalSettledIn(runsOf(state), proposalId);
  if (!caught) return { edits: [uncarded, started] };
  if (landed.runEndedAt !== undefined) return { edits: [editThread(uncarded, leadId, (item) => ({ caughtStarts: withoutCaughtStart(item, proposalId).caughtStarts })), started] };
  const cancel: AppCommand = { type: "run.cancel", taskId: threadId };
  const effects: WorkspaceEffect[] = computer && supportsComputerCommand(computer.capabilities, cancel) ? [{ type: "computer.forward", id: computer.id, inputs: [cancel] }] : [];
  return { edits: [editThread(uncarded, leadId, (item) => ({ caughtStarts: withStartLanded(item, proposalId, threadId).caughtStarts })), started], effects };
}

/**
 * One suggestion starting by the same rules as every start, under the coordinator that suggested it.
 * A refusal, from those rules or from the send itself, is said on the suggestion's row rather than
 * in the banner, and leaves it there to start again.
 */
function startProposal(state: WorkspaceState, leadId: string, proposalId: string): ProposalStep {
  return andThen(state, proposalFailure(state, leadId, proposalId, undefined), (retried) => {
    const lead = retried.threads.find((item) => item.id === leadId)!;
    const proposal = lead.proposals!.find((item) => item.id === proposalId)!;
    const send = proposalSend(proposal);
    const start = "error" in send ? send : newThreadSend(retried, lead, send, null);
    if ("error" in start || start.elsewhere) {
      const message = "error" in start ? start.error : "Its project is no longer on this computer.";
      return { ...proposalFailure(retried, leadId, proposalId, message), result: { ok: false, message } };
    }
    const sent = reduceSending(retried, start.command, { proposalId });
    if (failed(sent)) {
      /** What the send refused is said on the row, so the banner keeps what it showed. */
      const message = sent.refusal ?? (sent.result as Extract<typeof sent.result, { ok: false }>).message;
      const { refusal: _refused, error: _shown, clearsError: _cleared, ...kept } = sent;
      return andThen(retried, kept, (next) => ({ ...proposalFailure(next, leadId, proposalId, message), result: { ok: false, message } }));
    }
    /** Only a send that set a run on its way has anything left to finish starting. */
    const going = Object.values(afterward(retried, sent).pendingRuns).some((pending) => pending.coordination?.proposalId === proposalId);
    return going ? andThen(retried, sent, (next) => ({ edits: [proposalStartingIn(runsOf(next), proposalId)] })) : sent;
  });
}

/**
 * A thread asked for on a paired computer, allowed by the user in the project there they picked:
 * the start is carried to that computer as the coordinator would have started it here, with its
 * name, brief, the coordinator's memory as it stands, and the coordinator and suggestion it works
 * under, signed by the thread that asked. It is allowed once: nothing here lets the next one through,
 * and that computer starts a suggestion only once however often it is asked. A computer whose
 * line is down, or whose build cannot take it, is refused, as is a project it no longer holds.
 */
function startElsewhere(state: WorkspaceState, leadId: string, proposalId: string, chosen: { project: string; worktree: boolean } | undefined): ProposalStep {
  return andThen(state, proposalFailure(state, leadId, proposalId, undefined), (retried) => allowedElsewhere(retried, leadId, proposalId, chosen));
}

function allowedElsewhere(retried: WorkspaceState, leadId: string, proposalId: string, chosen: { project: string; worktree: boolean } | undefined): ProposalStep {
  const lead = retried.threads.find((item) => item.id === leadId)!;
  const proposal = lead.proposals!.find((item) => item.id === proposalId)!;
  const refused = (message: string): ProposalStep => ({ ...proposalFailure(retried, leadId, proposalId, message), result: { ok: false, message } });
  const computer = retried.computers.paired.find((item) => item.id === proposal.place.computer!.id);
  const refusal = ledStartRefusal(computer);
  if (refusal || !computer) return refused(refusal ?? "That computer is no longer paired.");
  const project = chosen?.project ?? proposal.place.project;
  if (!project || !computer.state?.projects.some((item) => item.id === project)) return refused(`That folder is no longer on ${computer.name}.`);
  const place = { ...proposal.place, project, worktree: chosen?.worktree ?? proposal.place.worktree === true };
  /** A thread under the coordinator that asked starts it as itself, so it runs as that thread's own start would have. */
  const asker = proposal.from ? retried.threads.find((item) => item.id === proposal.from && coordinatorOf(retried.threads, item) === lead) : undefined;
  if (proposal.from && !asker) return refused(ASKER_GONE);
  const caller = asker ?? lead;
  const asked = proposalSend({ ...proposal, place });
  const start = "error" in asked ? asked : newThreadSend(retried, caller, asked, computer);
  if ("error" in start) return refused(start.error);
  const { command } = start;
  const name = retried.computers.name || "another computer";
  const memory = memoryPrompt(lead.memory);
  const send = sendFor(computer, {
    type: "task.send",
    text: proposal.prompt,
    project,
    worktree: place.worktree,
    ...(command.model ? { model: command.model } : {}),
    ...(command.engine ? { engine: command.engine } : {}),
    ...(command.effort ? { effort: command.effort } : {}),
    ...(command.role ? { role: command.role } : {}),
    ...(command.brief ? { brief: command.brief } : {}),
    ...(command.title ? { title: command.title } : {}),
    ...(memory ? { memory } : {}),
    lead: { threadId: lead.id, title: lead.title, computer: name, proposalId },
    sender: { threadId: caller.id, title: caller.title, computer: name },
  });
  if (!supportsComputerCommand(computer.capabilities, send)) return refused(`Update AI Coding Tool on ${computer.name} to run threads there.`);
  /** Allowed again, it is the user's to start, whatever an earlier Stop all caught of it. */
  const carried = editThread(threadsOf<CoordinationThread>(retried), leadId, (item) => {
    const allowed = withProposalCarried(withoutCaughtStart(item, proposalId), proposalId);
    return { proposals: allowed.proposals, caughtStarts: allowed.caughtStarts };
  });
  return {
    edits: [carried, proposalStartingIn(runsOf(retried), proposalId)],
    effects: [{ type: "computer.forward", id: computer.id, inputs: [send], proposal: { taskId: leadId, proposalId } }],
  };
}

/**
 * A suggestion's start failing, with why, or a new start clearing that. Either way it is no longer
 * starting, which only the thread it becomes ends otherwise.
 */
export function withProposalFailure(state: WorkspaceState, leadId: string, proposalId: string, error: string | undefined): WorkspaceState {
  return afterward(state, proposalFailure(state, leadId, proposalId, error));
}

/** {@link withProposalFailure}, as the edits it makes. */
export function proposalFailure(state: WorkspaceState, leadId: string, proposalId: string, error: string | undefined): ProposalStep {
  const lead = state.threads.find((item) => item.id === leadId);
  const marked = lead && withProposalError(lead, proposalId, error);
  const settledIn = proposalSettledIn(runsOf(state), proposalId);
  return { edits: marked === lead ? [settledIn] : [editThread(threadsOf<CoordinationThread>(state), leadId, () => ({ proposals: marked!.proposals })), settledIn] };
}

/** A suggestion no longer starting, whether it started, failed, or was stopped. */
export function withoutStarting(state: WorkspaceState, proposalId: string): WorkspaceState {
  return afterward(state, { edits: [proposalSettledIn(runsOf(state), proposalId)] });
}

/**
 * The suggestions a start or a dismissal is for: the one named, else those of `proposalIds` here, as
 * Start all and Dismiss all name the ones on screen, else every one here, as each thread asked for on
 * another computer is allowed or denied on its own. One already starting is past either.
 */
function targetedProposals(state: WorkspaceState, lead: Thread, { proposalId, proposalIds }: { proposalId?: string; proposalIds?: string[] }): ThreadProposal[] {
  const named = proposalIds && new Set(proposalIds);
  return (lead.proposals ?? []).filter((proposal) => (proposalId !== undefined ? proposal.id === proposalId : !proposal.place.computer && (!named || named.has(proposal.id))) && !state.startingProposals.includes(proposal.id));
}

