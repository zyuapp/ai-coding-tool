/** A coordinator's suggestions, and the threads it asked for on other computers: filed, started or allowed, turned down, and settled. */
import { reduceSending } from "./sending.js";
import { now, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { coordinationNote, memoryPrompt, requestHeadline } from "../coordination.js";
import { announced } from "../notices.js";
import { updateThread } from "../thread-run-state.js";
import { newThreadSend, proposalSend } from "../thread-starts.js";
import { ledStartRefusal, titledFor, type PairedComputer } from "../computers.js";
import type { WorkspaceState } from "../workspace-state.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { coordinatorOf, isCoordinator, withCoordinationNote, withoutCaughtStart, withoutProposals, withProposalCarried, withProposalError, withProposals, type ThreadProposal } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";

type ProposalInput = Extract<WorkspaceInput, { type: "coordination.proposed" | "proposal.start" | "proposal.dismiss" | "proposal.settled" }>;

const ASKER_GONE = "The thread that asked for this no longer works under this coordinator.";

export function reduceProposals(state: WorkspaceState, input: ProposalInput): WorkspaceTransition {
  switch (input.type) {
    /**
     * Suggestions wait for the user, as many as there is room for. Nothing starts until the user starts
     * it. A thread under the coordinator asking to start one on another computer is put to the user at
     * once, as its decisions are, since no reply of the coordinator's says so; what the coordinator
     * asks for itself, its reply says.
     */
    case "coordination.proposed": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return settled(state);
      const proposed = withProposals(lead, input.proposals);
      if (proposed === lead) return settled(state);
      const filed = updateThread(state, lead.id, () => proposed);
      const held = new Set(lead.proposals?.map((proposal) => proposal.id));
      const asked = proposed.proposals!.filter((proposal) => !held.has(proposal.id) && proposal.from !== undefined);
      return settled(filed, asked.flatMap((proposal) => proposal.place.computer ? announced(filed, lead, requestHeadline(proposal, proposal.place.computer), "request") : []));
    }

    /**
     * The user starts a suggestion, or every one here not already starting, as its coordinator would
     * have started it then, or allows one on another computer in the place they picked. One that
     * cannot start keeps its row and says why.
     */
    case "proposal.start": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return settled(state);
      const waiting = targetedProposals(state, lead, input.proposalId);
      /** Start all is every start in turn; a refusal among them is the one said back. */
      let transition = settled(state);
      for (const proposal of waiting) {
        const started = proposal.place.computer ? startElsewhere(transition.state, lead.id, proposal.id, input.place) : startProposal(transition.state, lead.id, proposal.id);
        const result = started.result?.ok === false ? started.result : transition.result;
        transition = { state: started.state, effects: [...transition.effects, ...started.effects], ...(result ? { result } : {}) };
      }
      return transition;
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
      if (!lead || !isCoordinator(lead)) return settled(state);
      const declined = targetedProposals(state, lead, input.proposalId);
      if (!declined.length) return settled(state);
      const titles = declined.map((proposal) => `"${proposal.title}"`);
      const { place, carried } = declined[0]!;
      const denied = place.computer;
      const text = denied ? carried ? `The user gave up on starting ${titles[0]} on ${denied.name}. If it started there after all, you will hear from it.`
        : `The user did not allow ${titles[0]} to run on ${denied.name}.`
        : titles.length === 1 ? `The user declined the suggested thread ${titles[0]}.` : `The user declined the suggested threads ${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}.`;
      const note = coordinationNote(lead.id, text, now(), { quiet: true });
      return settled(updateThread(state, lead.id, (item) => withCoordinationNote(withoutProposals(item, new Set(declined.map((proposal) => proposal.id))), note)));
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
function proposalSettled(state: WorkspaceState, input: Extract<ProposalInput, { type: "proposal.settled" }>): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === input.taskId);
  if (input.threadId !== undefined) {
    const proposal = lead?.proposals?.find((item) => item.id === input.proposalId);
    const place = proposal?.place.computer?.id ?? lead?.caughtStarts?.[input.proposalId]?.computer;
    return proposalLanded(state, input.taskId, input.proposalId, input.threadId, state.computers.paired.find((item) => item.id === place));
  }
  if (!lead || !catching(lead, input.proposalId)) return settled(withProposalFailure(state, input.taskId, input.proposalId, input.message ?? "The thread did not start."));
  const refused = input.refused ? updateThread(state, lead.id, (item) => withoutCaughtStart(item, input.proposalId)) : state;
  return settled(withoutStarting(refused, input.proposalId));
}

/** Whether Stop all caught a coordinator's start elsewhere on its way, and it has yet to be heard landing. */
export function catching(lead: Thread | undefined, proposalId: string): boolean {
  const caught = lead?.caughtStarts?.[proposalId];
  return caught !== undefined && caught.threadId === undefined;
}

/**
 * A thread a coordinator here allowed on `computer` having landed there as `threadId`, as that
 * computer answered or as the thread itself shows up there, whichever is first heard: its card is
 * gone, and a start Stop all caught on its way is stopped as it lands. Hearing it again changes nothing.
 */
export function proposalLanded(state: WorkspaceState, leadId: string, proposalId: string, threadId: string, computer: PairedComputer | undefined): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === leadId);
  const carded = lead?.proposals?.some((item) => item.id === proposalId) === true;
  const caught = catching(lead, proposalId);
  if (!carded && !caught && !state.startingProposals.includes(proposalId)) return settled(state);
  const started = withoutStarting(carded ? updateThread(state, leadId, (item) => withoutProposals(item, new Set([proposalId]))) : state, proposalId);
  if (!caught) return settled(started);
  const cancel: AppCommand = { type: "run.cancel", taskId: threadId };
  const effects: WorkspaceEffect[] = computer && supportsComputerCommand(computer.capabilities, cancel) ? [{ type: "computer.forward", id: computer.id, inputs: [cancel] }] : [];
  /** Its end is news only to a coordinator here to hear it; one away since hears nothing of what its thread did meanwhile. */
  const landing = (item: Thread): Thread => isCoordinator(item) ? { ...item, caughtStarts: { ...item.caughtStarts, [proposalId]: { ...item.caughtStarts![proposalId]!, threadId } } } : withoutCaughtStart(item, proposalId);
  return settled(updateThread(started, leadId, landing), effects);
}

/**
 * One suggestion starting by the same rules as every start, under the coordinator that suggested it.
 * A refusal, from those rules or from the send itself, is said on the suggestion's row rather than
 * in the banner, and leaves it there to start again.
 */
function startProposal(state: WorkspaceState, leadId: string, proposalId: string): WorkspaceTransition {
  const retried = withProposalFailure(state, leadId, proposalId, undefined);
  const lead = retried.threads.find((item) => item.id === leadId)!;
  const proposal = lead.proposals!.find((item) => item.id === proposalId)!;
  const start = newThreadSend(retried, lead, proposalSend(proposal), null);
  if ("error" in start || start.elsewhere) {
    const message = "error" in start ? start.error : "Its project is no longer on this computer.";
    return settled(withProposalFailure(retried, leadId, proposalId, message), [], { ok: false, message });
  }
  const sent = reduceSending(retried, start.command, { proposalId });
  if (sent.result?.ok === false) {
    const kept = { ...sent.state, actionError: state.actionError, actionErrorPage: state.actionErrorPage };
    return { ...sent, state: withProposalFailure(kept, leadId, proposalId, sent.result.message) };
  }
  /** Only a send that set a run on its way has anything left to finish starting. */
  const going = Object.values(sent.state.pendingRuns).some((pending) => pending.coordination?.proposalId === proposalId);
  return going ? { ...sent, state: { ...sent.state, startingProposals: [...sent.state.startingProposals, proposalId] } } : sent;
}

/**
 * A thread asked for on a paired computer, allowed by the user in the project there they picked:
 * the start is carried to that computer as the coordinator would have started it here, with its
 * name, brief, the coordinator's memory as it stands, and the coordinator and suggestion it works
 * under, signed by the thread that asked. It is allowed once: nothing here lets the next one through,
 * and that computer starts a suggestion only once however often it is asked. A computer whose
 * line is down, or whose build cannot take it, is refused, as is a project it no longer holds.
 */
function startElsewhere(state: WorkspaceState, leadId: string, proposalId: string, chosen: { project: string; worktree: boolean } | undefined): WorkspaceTransition {
  const retried = withProposalFailure(state, leadId, proposalId, undefined);
  const lead = retried.threads.find((item) => item.id === leadId)!;
  const proposal = lead.proposals!.find((item) => item.id === proposalId)!;
  const refused = (message: string) => settled(withProposalFailure(retried, leadId, proposalId, message), [], { ok: false, message });
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
  const start = newThreadSend(retried, caller, proposalSend({ ...proposal, place }), computer);
  if ("error" in start) return refused(start.error);
  const { command } = start;
  const name = retried.computers.name || "another computer";
  const memory = memoryPrompt(lead.memory);
  const send = titledFor(computer, {
    type: "task.send",
    text: proposal.prompt,
    project,
    worktree: place.worktree,
    ...(command.model ? { model: command.model } : {}),
    ...(command.effort ? { effort: command.effort } : {}),
    ...(command.role ? { role: command.role } : {}),
    ...(command.brief ? { brief: command.brief } : {}),
    ...(command.title ? { title: command.title } : {}),
    ...(memory ? { memory } : {}),
    lead: { threadId: lead.id, title: lead.title, computer: name, proposalId },
    sender: { threadId: caller.id, title: caller.title, computer: name },
  });
  if (!supportsComputerCommand(computer.capabilities, send)) return refused(`Update AI Coding Tool on ${computer.name} to run threads there.`);
  return settled(
    /** Allowed again, it is the user's to start, whatever an earlier Stop all caught of it. */
    { ...updateThread(retried, leadId, (item) => withProposalCarried(withoutCaughtStart(item, proposalId), proposalId)), startingProposals: [...retried.startingProposals, proposalId] },
    [{ type: "computer.forward", id: computer.id, inputs: [send], proposal: { taskId: leadId, proposalId } }],
  );
}

/**
 * A suggestion's start failing, with why, or a new start clearing that. Either way it is no longer
 * starting, which only the thread it becomes ends otherwise.
 */
export function withProposalFailure(state: WorkspaceState, leadId: string, proposalId: string, error: string | undefined): WorkspaceState {
  const lead = state.threads.find((item) => item.id === leadId);
  const marked = lead && withProposalError(lead, proposalId, error);
  return withoutStarting(marked === lead ? state : updateThread(state, leadId, () => marked!), proposalId);
}

/** A suggestion no longer starting, whether it started, failed, or was stopped. */
export function withoutStarting(state: WorkspaceState, proposalId: string): WorkspaceState {
  return state.startingProposals.includes(proposalId) ? { ...state, startingProposals: state.startingProposals.filter((id) => id !== proposalId) } : state;
}

/**
 * The suggestions a start or a dismissal is for: the one named, or every one here when none is, as
 * each thread asked for on another computer is allowed or denied on its own. One already starting is
 * past either.
 */
function targetedProposals(state: WorkspaceState, lead: Thread, proposalId: string | undefined): ThreadProposal[] {
  return (lead.proposals ?? []).filter((proposal) => (proposalId === undefined ? !proposal.place.computer : proposal.id === proposalId) && !state.startingProposals.includes(proposal.id));
}

