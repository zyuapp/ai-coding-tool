/** Coordinators and their threads: who works under whom, what they report, and what waits on the user. */
import { drainQueue, queuedFor, resolveWorkspaceEffect, threadBusy, withPending, withoutPending } from "./run-queue.js";
import { reduceSending } from "./sending.js";
import { now, rejected, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { canResolve, checkoutAnswer, coordinatedThreadStatus, coordinationMembers, coordinationNote, coordinatorWork, coordinationUpdate, memberWorking, memoryPrompt, nextSteps, remotelyLedThreads, turnNote, workingMembers } from "../coordination.js";
import { activityChanges, threadActivity, threadChanges, type ThreadChange } from "../thread-activity.js";
import { cancelPause, heldByLimit } from "../limit-pauses.js";
import { announced } from "../notices.js";
import { settledHeadline } from "../run-testimony.js";
import { updateThread } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import { newThreadSend, proposalSend } from "../thread-starts.js";
import { ledStartRefusal, remoteWorkingIds, type PairedComputer } from "../computers.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { canJoinCoordinator, coordinatorOf, isCoordinator, MAX_ANSWER, nextStepOf, openDecisions, remoteLeadOf, threadModelOf, undelegable, withAnswer, withCoordinationNote, withDecision, withMemoryChange, withoutProposals, withProposalError, withProposals, withRemoteHeard, worksUnderCoordinator, type CoordinationNote, type MemoryChange, type ThreadProposal } from "../../domain/coordination.js";
import { defaultEffortFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../../domain/agent-engine.js";
import { threadCreatedAt, type Thread } from "../../domain/thread.js";
import { dismissed } from "../../domain/attention.js";
import { resumesOnItsOwn } from "../../domain/usage-limit.js";

type CoordinationInput = Extract<WorkspaceInput, {
  type: "task.set-coordinator" | "task.resolve" | "task.reopen" | "decision.answer" | "coordination.set-thread-model" | "coordination.set-muted" | "coordination.stop-all" | "coordination.reported" | "coordination.decision-raised"
    | "memory.set-purpose" | "memory.add" | "memory.edit" | "memory.forget" | "coordination.remembered" | "coordination.next-step"
    | "coordination.proposed" | "proposal.start" | "proposal.dismiss" | "proposal.settled";
}>;

const STEP_GONE = "That step is no longer offered.";

const ASKER_GONE = "The thread that asked for this no longer works under this coordinator.";

const JOIN_REFUSED = "Only a coordinator can take threads under it, and a coordinator cannot work under another.";

export function reduceCoordination(state: WorkspaceState, input: CoordinationInput): WorkspaceTransition {
  switch (input.type) {
    case "task.set-coordinator": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread) return settled(state);
      /**
       * Resolved only means anything under the coordinator that saw the work settle, so a move leaves
       * it behind, and a thread moved out leaves a coordinator on another computer as well as one here.
       */
      if (input.coordinatorId === null) {
        if (thread.parentId === undefined && thread.remoteLead === undefined) return settled(state);
        return settled({ ...updateThread(state, thread.id, ({ parentId: _left, remoteLead: _released, resolvedAt: _settled, ...item }) => ({ ...item, updatedAt: now() })), openMenu: null });
      }
      const lead = state.threads.find((item) => item.id === input.coordinatorId);
      if (!canJoinCoordinator(thread, lead)) return rejected(state, JOIN_REFUSED);
      if (thread.parentId === lead.id && thread.remoteLead === undefined) return settled(state);
      return settled({ ...updateThread(state, thread.id, ({ resolvedAt: _settled, remoteLead: _left, ...item }) => ({ ...item, parentId: lead.id, updatedAt: now() })), openMenu: null });
    }

    /**
     * Resolving files away what the thread's last run and its findings had to say, so a thread with
     * nothing left to do never holds its coordinator's row up in the list.
     */
    case "task.resolve": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || !worksUnderCoordinator(state.threads, thread) || thread.resolvedAt !== undefined) return settled(state);
      const { working, blocked } = threadActivity(state);
      if (!canResolve(coordinatedThreadStatus(thread, working, blocked).status)) return rejected(state, "Finish or answer what this thread is waiting on first.");
      const resolved = updateThread(state, thread.id, (item) => ({ ...item, resolvedAt: now(), updatedAt: now() }));
      return settled({ ...resolved, threads: dismissed(resolved.threads, new Set([thread.id])) });
    }

    case "task.reopen": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || !worksUnderCoordinator(state.threads, thread) || thread.resolvedAt === undefined) return settled(state);
      return settled(updateThread(state, thread.id, ({ resolvedAt: _reopened, ...item }) => ({ ...item, updatedAt: now() })));
    }

    /** The answer is recorded, then said to the thread that asked, steered into a run already going. */
    case "decision.answer": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const decision = thread && openDecisions(thread).find((item) => item.id === input.decisionId);
      const answer = input.answer.trim();
      if (!thread || !decision || !answer) return settled(state);
      if (answer.length > MAX_ANSWER) return rejected(state, `An answer can be at most ${MAX_ANSWER.toLocaleString()} characters.`);
      const answered = (next: WorkspaceState) => updateThread(next, thread.id, (item) => withAnswer(item, decision.id, answer, now()));
      if (thread.archivedAt !== undefined) return settled(answered(state));
      /** A decision only closes once its answer is on its way, so one that could not be sent can be answered again. */
      const sent = reduceSending(state, { type: "task.send", taskId: thread.id, text: `The user decided "${decision.question}": ${answer}`, steer: true });
      return sent.result?.ok === false ? sent : { ...sent, state: answered(sent.state) };
    }

    /**
     * A next step is the user's own word to the thread, sent as any message of theirs is. One the
     * thread's card no longer offers, as once it has started working, is refused and nothing is sent.
     */
    case "coordination.next-step": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = coordinatorOf(state.threads, thread);
      /**
       * Only a thread its coordinator's views draw has a card to take a step from, so an archived one
       * has none. One under a coordinator on another computer is drawn there and decided here.
       */
      const drawn = lead ? coordinationMembers(state, lead.id).some((member) => member.thread === thread) : Boolean(remoteLeadOf(thread) && thread!.archivedAt === undefined);
      if (!thread || !drawn) return rejected(state, STEP_GONE);
      const { working, blocked } = threadActivity(state);
      const { status } = coordinatedThreadStatus(thread, working, blocked);
      if (!nextSteps(thread, status, checkoutAnswer(state, thread)).includes(input.step)) return rejected(state, STEP_GONE);
      return reduceSending(state, { type: "task.send", taskId: thread.id, text: nextStepOf(input.step).text });
    }

    case "coordination.set-thread-model": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return rejected(state, "Only a coordinator chooses what its threads run on.");
      if (!modelDelegable(input.model)) return rejected(state, undelegable(input.model));
      /** An effort the model lacks, or none, keeps the depth the threads run at as near as that model allows. */
      const effort = input.effort && modelHasEffort(input.model, input.effort)
        ? input.effort
        : effortForModel(input.model, threadModelOf(lead).effort ?? defaultEffortFor(engineForModel(input.model)));
      const threadModel = modelTakesEffort(input.model) ? { model: input.model, effort } : { model: input.model };
      if (lead.threadModel?.model === threadModel.model && lead.threadModel.effort === threadModel.effort) return settled(state);
      return settled(updateThread(state, lead.id, (item) => ({ ...item, threadModel, updatedAt: now() })));
    }

    /** Muting is the user's word on a coordinator's notices; it marks nothing in the sidebar. */
    case "coordination.set-muted": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead) || (lead.muted === true) === input.muted) return settled(state);
      return settled(updateThread(state, lead.id, ({ muted: _was, ...item }) => ({ ...item, ...(input.muted ? { muted: true as const } : {}), updatedAt: now() })));
    }

    case "coordination.stop-all":
      return stopAll(state, input.taskId);

    /** The user's own edits, which the coordinator's session has yet to read. */
    case "memory.set-purpose":
      return remembered(state, input.taskId, { kind: "purpose", purpose: input.purpose }, false);
    case "memory.add":
      return remembered(state, input.taskId, { kind: "remember", text: input.text }, false);
    case "memory.edit":
      return remembered(state, input.taskId, { kind: "edit", noteId: input.noteId, text: input.text }, false);
    case "memory.forget":
      return remembered(state, input.taskId, { kind: "forget", noteId: input.noteId }, false);

    /** The coordinator's own change. Its tool call answers a refusal, so the user's banner never shows one. */
    case "coordination.remembered": {
      const changed = remembered(state, input.taskId, input.change, true);
      return changed.result?.ok === false ? settled(state) : changed;
    }

    /** Suggestions wait for the user, as many as there is room for. Nothing starts until the user starts it. */
    case "coordination.proposed": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return settled(state);
      const proposed = withProposals(lead, input.proposals);
      return proposed === lead ? settled(state) : settled(updateThread(state, lead.id, () => proposed));
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
     * for on another computer being allowed or denied on its own.
     */
    case "proposal.dismiss": {
      const lead = state.threads.find((item) => item.id === input.taskId);
      if (!lead || !isCoordinator(lead)) return settled(state);
      const declined = targetedProposals(state, lead, input.proposalId);
      if (!declined.length) return settled(state);
      const titles = declined.map((proposal) => `"${proposal.title}"`);
      const denied = declined[0]!.place.computer;
      const text = denied ? `The user did not allow ${titles[0]} to run on ${denied.name}.`
        : titles.length === 1 ? `The user declined the suggested thread ${titles[0]}.` : `The user declined the suggested threads ${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}.`;
      const note = coordinationNote(lead.id, text, now(), { quiet: true });
      return settled(updateThread(state, lead.id, (item) => withCoordinationNote(withoutProposals(item, new Set(declined.map((proposal) => proposal.id))), note)));
    }

    /**
     * A thread a coordinator on another computer started has its start allowed there, and is a thread
     * on that computer now, which tells the coordinator so itself once the thread shows up there.
     */
    case "proposal.settled": {
      if (input.threadId === undefined) return settled(withProposalFailure(state, input.taskId, input.proposalId, input.message ?? "The thread did not start."));
      const started = withoutStarting(state, input.proposalId);
      const lead = started.threads.find((item) => item.id === input.taskId);
      return settled(lead?.proposals ? updateThread(started, lead.id, (item) => withoutProposals(item, new Set([input.proposalId]))) : started);
    }

    /**
     * Progress is not news: only a thread that is blocked, done or failed leaves its coordinator a
     * note, which it hears with the rest when the thread's turn ends. One that cannot go on is the
     * user's to hear about at once. A thread under a coordinator on another computer only records
     * where it stands: that computer reads it here, and hears and announces it there.
     */
    case "coordination.reported": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = coordinatorOf(state.threads, thread);
      if (!thread || !lead && !remoteLeadOf(thread)) return settled(state);
      const at = now();
      const reported = updateThread(state, thread.id, (item) => ({ ...item, report: { state: input.state, summary: input.summary, at } }));
      if (!lead || input.state === "working") return settled(reported);
      const note = coordinationNote(thread.id, `"${thread.title}" reported ${input.state}: ${input.summary}`, at, { urgent: input.state !== "done", runId: state.activeRuns[thread.id]?.runId });
      const noted = updateThread(reported, lead.id, (item) => withCoordinationNote(item, note));
      if (input.state === "done") return settled(noted);
      return settled(noted, announced(noted, thread, `${input.state === "blocked" ? "Blocked" : "Failed"}: ${input.summary}`, "blocked"));
    }

    /**
     * The user is told at once; the coordinator hears it with the rest when the thread's turn ends. A
     * thread under a coordinator on another computer only records it, for that computer to raise.
     */
    case "coordination.decision-raised": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = thread && (isCoordinator(thread) ? thread : coordinatorOf(state.threads, thread));
      if (!thread || !lead && !remoteLeadOf(thread)) return settled(state);
      const at = now();
      const decision = {
        id: crypto.randomUUID(),
        question: input.request.question,
        ...(input.request.context ? { context: input.request.context } : {}),
        options: input.request.options,
        raisedAt: at,
      };
      const raised = updateThread(state, thread.id, (item) => withDecision(item, decision));
      if (!lead) return settled(raised);
      if (lead === thread) return settled(raised, announced(raised, lead, `Needs you: ${decision.question}`, "decision"));
      const asked = coordinationNote(thread.id, `"${thread.title}" asked the user to decide: ${decision.question}`, at, { runId: state.activeRuns[thread.id]?.runId });
      const noted = updateThread(raised, lead.id, (item) => withCoordinationNote(item, asked));
      return settled(noted, announced(noted, lead, `Needs you: ${decision.question}`, "decision"));
    }
  }
}

/**
 * Stops a coordinator and every thread under it: each run is cancelled, each wait on a usage limit
 * ends, and each run still on its way, the coordinator's wake and its threads' starts included, is
 * dropped, handing back what was queued behind it. The runs it cancels end quietly, so nothing it
 * stopped wakes the coordinator to carry on; scheduled ticks are the user's to stop one by one. A
 * thread under it on another computer is stopped there, by a computer whose build can.
 */
function stopAll(state: WorkspaceState, leadId: string): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === leadId);
  if (!lead || !isCoordinator(lead)) return settled(state);
  const { threads, starts, elsewhere } = coordinatorWork(state, lead);
  const cancelled = threads.flatMap(({ id }) => state.activeRuns[id] ?? []);
  const remote = remoteStops(elsewhere);
  /** A run that never said it ended leaves its id behind, so only runs still going, here or on a paired computer, are kept. */
  const going = new Set([state, ...state.computers.paired.flatMap((computer) => computer.state ?? [])].flatMap((held) => Object.values(held.activeRuns).map((run) => run.runId)));
  const quietStops = [...state.quietStops.filter((runId) => going.has(runId)), ...cancelled.map((run) => run.runId), ...remote.runIds];
  let next = settled({ ...state, quietStops }, [...cancelled.map((run): WorkspaceEffect => ({ type: "send-run-command", command: { type: "cancel", taskId: run.taskId, runId: run.runId } })), ...remote.effects]);
  for (const { id } of threads) next = followedBy(next, cancelPause(next.state, id));
  for (const { id, taskId, coordination } of starts) {
    const without = withoutPending(next.state, id);
    next = { ...next, state: coordination?.proposalId ? withProposalFailure(without, lead.id, coordination.proposalId, undefined) : without };
    /** What was queued behind it goes back to its composer, as any stop hands it back. */
    if (taskId && !next.state.activeRuns[taskId]) next = followedBy(next, drainQueue(next.state, taskId, "cancelled"));
  }
  return next;
}

/**
 * What stops the work of a coordinator's threads on paired computers: one batch for each computer,
 * with only what its build takes, and the runs it ends, so their ends are heard quietly here.
 */
function remoteStops(work: ReturnType<typeof coordinatorWork>["elsewhere"]): { effects: WorkspaceEffect[]; runIds: string[] } {
  const batches = new Map<string, { computer: PairedComputer; inputs: AppCommand[] }>();
  const runIds: string[] = [];
  for (const { thread, computer, runId } of work) {
    const batch = batches.get(computer.id) ?? { computer, inputs: [] };
    const cancel: AppCommand = { type: "run.cancel", taskId: thread.id };
    if (runId && supportsComputerCommand(computer.capabilities, cancel)) {
      batch.inputs.push(cancel);
      runIds.push(runId);
    }
    const lifted: AppCommand = { type: "limit.cancel", taskId: thread.id };
    if (thread.limitPause && supportsComputerCommand(computer.capabilities, lifted)) batch.inputs.push(lifted);
    batches.set(computer.id, batch);
  }
  const effects = [...batches.values()].flatMap(({ computer, inputs }): WorkspaceEffect[] => inputs.length ? [{ type: "computer.forward", id: computer.id, inputs }] : []);
  return { effects, runIds };
}

function followedBy(first: WorkspaceTransition, then: WorkspaceTransition): WorkspaceTransition {
  return { state: then.state, effects: [...first.effects, ...then.effects] };
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
 * brief, the coordinator's memory as it stands, and the coordinator it works under, signed by the
 * thread that asked. It is allowed once; nothing here lets the next one through. A computer whose
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
  const send: AppCommand = {
    type: "task.send",
    text: proposal.prompt,
    project,
    worktree: place.worktree,
    ...(command.model ? { model: command.model } : {}),
    ...(command.effort ? { effort: command.effort } : {}),
    ...(command.role ? { role: command.role } : {}),
    ...(command.brief ? { brief: command.brief } : {}),
    ...(memory ? { memory } : {}),
    lead: { threadId: lead.id, title: lead.title, computer: name },
    sender: { threadId: caller.id, title: caller.title, computer: name },
  };
  if (!supportsComputerCommand(computer.capabilities, send)) return refused(`Update AI Coding Tool on ${computer.name} to run threads there.`);
  return settled(
    { ...retried, startingProposals: [...retried.startingProposals, proposalId] },
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

/** Only a coordinator keeps a memory; a change that alters nothing writes nothing. */
function remembered(state: WorkspaceState, taskId: string, change: MemoryChange, heard: boolean): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === taskId);
  if (!lead || !isCoordinator(lead)) return settled(state);
  const at = now();
  const changed = withMemoryChange(lead, change, at, { heard });
  if ("error" in changed) return rejected(state, changed.error);
  if (changed.thread === lead) return settled(state);
  return settled(updateThread(state, lead.id, () => ({ ...changed.thread, updatedAt: at })));
}

/**
 * A thread's turn ending is news for its coordinator. A thread waiting out a session limit carries on
 * by itself, so its turn has not ended.
 */
export function noteTurnEnded(state: WorkspaceState, taskId: string, status: "succeeded" | "failed" | "cancelled", runId: string): WorkspaceState {
  /** A run Stop all cancelled is heard, but never wakes its coordinator by itself. */
  const quiet = state.quietStops.includes(runId);
  const ended = quiet ? { ...state, quietStops: state.quietStops.filter((id) => id !== runId) } : state;
  const thread = ended.threads.find((item) => item.id === taskId);
  const lead = coordinatorOf(ended.threads, thread);
  if (!thread || !lead || (thread.limitPause && resumesOnItsOwn(thread.limitPause))) return ended;
  return updateThread(ended, lead.id, (item) => withCoordinationNote(item, turnNote(thread, status, now(), { quiet })));
}

/**
 * The one place a coordinator is woken. After every input, each coordinator the input could have
 * touched, through itself, its threads or who works under it, hears its news if it is due. A
 * coordinator the input stopped keeps what it holds quiet, so only news that arrives later wakes it.
 */
export function reconcileCoordination(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  /** Quieted first, since a stop may only have asked for runs to end and changed nothing else yet. */
  const stopped = stoppedBy(previous, input);
  const quiet = stopped ? quieted(transition.state, stopped) : transition.state;
  /** What paired computers say of the threads coordinators here started there is news like any thread's. */
  const remote = remoteNews(previous, quiet);
  let state = remote.state;
  const threads = threadChanges(previous.threads, state.threads);
  const touched = activityChanges(previous, state, threads);
  for (const { id, before, after } of threads) {
    if (!before || !after || before.parentId !== after.parentId || before.role !== after.role || before.archivedAt !== after.archivedAt || before.coordinationNotes !== after.coordinationNotes) touched.add(id);
  }
  for (const id of remote.leads) touched.add(id);
  const said = [...remote.effects, ...released(previous, state, threads)];
  if (!touched.size) return state === transition.state && !said.length ? transition : { ...transition, state, effects: [...transition.effects, ...said] };
  const effects = [...transition.effects, ...said];
  for (const leadId of coordinatorsOf(previous, state, touched)) {
    const delivered = deliverCoordinationNotes(state, leadId);
    state = delivered.state;
    effects.push(...delivered.effects);
  }
  return { ...transition, state, effects };
}

/**
 * The coordinator the user just stopped, filed away, or whose run could not start, so its news is
 * not pressed on it again at once.
 */
function stoppedBy(previous: WorkspaceState, input: WorkspaceInput): string | undefined {
  if (input.type === "task.archive" || input.type === "coordination.stop-all") return input.taskId;
  if (input.type === "run.event" && input.event.type === "run.status" && input.event.status === "cancelled") {
    return previous.activeRuns[input.event.taskId]?.runId === input.event.runId ? input.event.taskId : undefined;
  }
  if (input.type === "run.unresolved") return previous.pendingRuns[input.pendingId]?.taskId;
  if (input.type === "limit.cancel") return previous.threads.find((thread) => thread.id === input.taskId)?.limitPause ? input.taskId : undefined;
  return undefined;
}

/** Quiets the coordinator's held news, archived or not, so restoring it wakes nothing by itself. */
function quieted(state: WorkspaceState, leadId: string): WorkspaceState {
  const lead = state.threads.find((thread) => thread.id === leadId);
  if (lead?.role !== "coordinator" || !lead.coordinationNotes?.some((note) => !note.quiet)) return state;
  return updateThread(state, leadId, (thread) => ({ ...thread, coordinationNotes: thread.coordinationNotes!.map((note) => note.quiet ? note : { ...note, quiet: true as const }) }));
}

/** Each touched thread that is a coordinator, and the coordinator each one worked under before or after. */
function coordinatorsOf(previous: WorkspaceState, next: WorkspaceState, touched: ReadonlySet<string>): Set<string> {
  const leads = new Set<string>();
  for (const state of [previous, next]) {
    for (const thread of state.threads) {
      if (!touched.has(thread.id)) continue;
      if (isCoordinator(thread)) leads.add(thread.id);
      else if (thread.parentId) leads.add(thread.parentId);
    }
  }
  return leads;
}

/**
 * The news that wakes a coordinator: notes not quiet, and not written during a run of one of its
 * threads that is still working, here or on the computer that holds it. A run waiting for the user's
 * approval no longer counts as working.
 */
function wakingNews(state: WorkspaceState, lead: Thread): CoordinationNote[] {
  const notes = (lead.coordinationNotes ?? []).filter((note) => !note.quiet);
  if (!notes.some((note) => note.runId)) return notes;
  const members = new Map(coordinationMembers(state, lead.id).map((member) => [member.thread.id, member]));
  const going = (id: string, runId: string) => {
    const member = members.get(id);
    if (!member) return false;
    const runs = member.computer ? member.holder.activeRuns : state.activeRuns;
    return runs[id]?.runId === runId && memberWorking(state, member);
  };
  return notes.filter((note) => !note.runId || !going(note.threadId, note.runId));
}

/** What a coordinator here hears of its threads on paired computers, and the coordinators that may now be due a wake. */
type RemoteNews = { state: WorkspaceState; effects: WorkspaceEffect[]; leads: Set<string> };

/**
 * What paired computers' states say of the threads coordinators here started there, read against
 * how far each coordinator has heard each thread, so news from while a line was down is caught up
 * once it is back rather than lost. Only a computer whose threads, runs or line moved is read, and
 * of its threads only those a coordinator elsewhere started. A thread whose work stopped or started
 * there may free or hold its coordinator's wake, so that coordinator is looked at again too.
 */
function remoteNews(previous: WorkspaceState, next: WorkspaceState): RemoteNews {
  const news: RemoteNews = { state: next, effects: [], leads: new Set() };
  if (previous.computers.paired === next.computers.paired) return news;
  const before = new Map(previous.computers.paired.map((computer) => [computer.id, computer]));
  for (const computer of next.computers.paired) {
    const was = before.get(computer.id);
    before.delete(computer.id);
    const holder = computer.state;
    const prior = was?.state ?? null;
    if (!holder || prior && was!.status === computer.status && prior.threads === holder.threads && prior.activeRuns === holder.activeRuns) continue;
    const members = remotelyLedThreads(holder.threads);
    const earlier = prior ? remotelyLedThreads(prior.threads) : [];
    if (!members.length && !earlier.length) continue;
    const working = remoteWorkingIds(computer, holder);
    const workedBefore = was && prior ? remoteWorkingIds(was, prior) : new Set<string>();
    const kept = new Set(members.map((thread) => thread.id));
    /** A thread that left, or stopped being one of a coordinator's, may have been what held its coordinator's news. */
    for (const thread of earlier) if (!kept.has(thread.id) && workedBefore.has(thread.id)) news.leads.add(thread.remoteLead!.threadId);
    for (const member of members) {
      const lead = news.state.threads.find((thread) => thread.id === member.remoteLead!.threadId);
      if (!lead || !isCoordinator(lead)) continue;
      if (working.has(member.id) !== workedBefore.has(member.id)) news.leads.add(lead.id);
      const heard = memberNews(news.state, lead, member, computer, holder, prior);
      if (heard.state !== news.state) news.leads.add(lead.id);
      news.state = heard.state;
      news.effects.push(...heard.effects);
    }
  }
  /** A computer no longer paired takes its threads' work with it. */
  for (const gone of before.values()) {
    if (!gone.state) continue;
    const working = remoteWorkingIds(gone, gone.state);
    for (const thread of remotelyLedThreads(gone.state.threads)) if (working.has(thread.id)) news.leads.add(thread.remoteLead!.threadId);
  }
  return news;
}

/**
 * What a coordinator hears of one of its threads on a paired computer since it last heard of it, on
 * that computer's clock: that it showed up there, quietly, then each decision it raised, the report
 * it made, and its turn ending, as a thread here would have been heard. What the user would have been
 * told of a thread here is told of it here, under the coordinator's notices, and what that computer
 * carries of the same is dropped: what its scheduled runs found, and its turns ending and waiting on
 * the user as a thread here is heard, for a run someone started. A run Stop all asked to end is heard
 * quietly.
 */
function memberNews(state: WorkspaceState, lead: Thread, member: Thread, computer: PairedComputer, holder: WorkspaceState, prior: WorkspaceState | null): { state: WorkspaceState; effects: WorkspaceEffect[] } {
  const heard = lead.remoteHeard?.[member.id];
  const since = heard ?? 0;
  const at = now();
  const notes: CoordinationNote[] = [];
  const effects: WorkspaceEffect[] = [];
  let newest = heard ?? threadCreatedAt(member);
  let { quietStops } = state;
  const run = holder.activeRuns[member.id];
  const ran = prior?.activeRuns[member.id];
  if (heard === undefined) notes.push(coordinationNote(member.id, `"${member.title}" started on ${computer.name}.`, at, { quiet: true }));
  for (const decision of openDecisions(member)) {
    if (decision.raisedAt <= since) continue;
    notes.push(coordinationNote(member.id, `"${member.title}" asked the user to decide: ${decision.question}`, at, { runId: run?.runId }));
    effects.push(...announced(state, lead, `Needs you: ${decision.question}`, "decision"));
    newest = Math.max(newest, decision.raisedAt);
  }
  const report = member.report;
  if (report && report.at > since && report.state !== "working") {
    notes.push(coordinationNote(member.id, `"${member.title}" reported ${report.state}: ${report.summary}`, at, { urgent: report.state !== "done", runId: run?.runId }));
    if (report.state !== "done") effects.push(...announced(state, member, `${report.state === "blocked" ? "Blocked" : "Failed"}: ${report.summary}`, "blocked"));
    newest = Math.max(newest, report.at);
  }
  for (const finding of member.findings ?? []) {
    if (finding.at <= since) continue;
    effects.push(...announced(state, member, finding.headline, "finding"));
    newest = Math.max(newest, finding.at);
  }
  /** A thread waiting out a session limit carries on by itself, so its turn has not ended. */
  const ended = member.runEndedAt !== undefined && member.runEndedAt > since && !run && !(member.limitPause && resumesOnItsOwn(member.limitPause));
  if (ended) {
    const quiet = ran !== undefined && quietStops.includes(ran.runId);
    if (quiet) quietStops = quietStops.filter((runId) => runId !== ran.runId);
    const status = quiet || member.outcome === "stopped" ? "cancelled" : member.outcome === "failed" ? "failed" : "succeeded";
    notes.push(turnNote(member, status, at, { quiet }));
    /**
     * Said as a run here would say it: a failure in the words that computer left on the thread, and a
     * finish only for a run someone started, so one this computer never saw go speaks only if it failed.
     */
    const surfacing = status === "failed" ? "failed" : status === "succeeded" && ran && ran.origin !== "automation" ? "attended" : null;
    const failure = member.messages.at(-1);
    const headline = settledHeadline(surfacing, failure?.kind === "system" && failure.tone === "error" ? failure.text : undefined);
    if (headline) effects.push(...announced(state, member, headline, surfacing === "failed" ? "failed" : "finished"));
    newest = Math.max(newest, member.runEndedAt!);
  }
  /** Waiting on the user is said as it starts, as it is of a thread here. */
  if (run?.origin === "composer" && computer.status === "connected") {
    const approval = run.status === "awaiting-approval" ? holder.approvals[run.runId] : undefined;
    if (approval && (ran?.runId !== run.runId || ran.status !== "awaiting-approval")) effects.push(...announced(state, member, `Waiting for your permission to use ${approval.toolName}`, "waiting"));
    const question = run.questions?.[0];
    if (question && !(ran?.runId === run.runId && ran.questions?.length)) effects.push(...announced(state, member, question.question, "waiting"));
  }
  if (!notes.length && newest === heard) return { state: quietStops === state.quietStops ? state : { ...state, quietStops }, effects };
  const led = new Set(coordinationMembers(state, lead.id).flatMap(({ thread, computer: there }) => there ? [thread.id] : []));
  const told = notes.reduce(withCoordinationNote, withRemoteHeard(lead, member.id, newest, led));
  return { state: updateThread({ ...state, quietStops }, lead.id, () => told), effects };
}

/**
 * Each thread on a paired computer still working under a thread here that is no longer a live
 * coordinator is let go there, as this computer's own threads stand on their own once their
 * coordinator goes. It is read off what each computer says it holds, so one that was away, or whose
 * state comes in only after its line is back, is told once it says so, and what could not be carried
 * is tried again the next time its threads move.
 */
function released(previous: WorkspaceState, state: WorkspaceState, threads: readonly ThreadChange[]): WorkspaceEffect[] {
  const ended = threads.some(({ before, after }) => isCoordinator(before) && !isCoordinator(after));
  if (!ended && previous.computers.paired === state.computers.paired) return [];
  const before = new Map(previous.computers.paired.map((computer) => [computer.id, computer]));
  const effects: WorkspaceEffect[] = [];
  for (const computer of state.computers.paired) {
    if (computer.status !== "connected" || !computer.state) continue;
    const was = before.get(computer.id);
    if (!ended && was?.status === "connected" && was.state?.threads === computer.state.threads) continue;
    const inputs = remotelyLedThreads(computer.state.threads).flatMap((thread): AppCommand[] => {
      const lead = state.threads.find((item) => item.id === thread.remoteLead!.threadId);
      return lead && !isCoordinator(lead) ? [{ type: "task.set-coordinator", taskId: thread.id, coordinatorId: null }] : [];
    }).filter((command) => supportsComputerCommand(computer.capabilities, command));
    if (inputs.length) effects.push({ type: "computer.forward", id: computer.id, inputs, silent: true });
  }
  return effects;
}

/**
 * Wakes a free coordinator with all its waiting notes at once, once none of its threads is working
 * or the news cannot wait. The notes stay until its run actually starts. One waiting out a usage
 * limit hears them once its resumed run ends.
 */
function deliverCoordinationNotes(state: WorkspaceState, leadId: string): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === leadId);
  const notes = lead?.coordinationNotes ?? [];
  if (!lead || !isCoordinator(lead) || !notes.length || threadBusy(state, leadId) || queuedFor(state, leadId).length || heldByLimit(state, leadId, now())) return settled(state);
  const news = wakingNews(state, lead);
  if (!news.length) return settled(state);
  const working = workingMembers(state, leadId).length;
  if (working && !news.some((note) => note.urgent)) return settled(state);
  const project = projectFor(state, lead);
  const update = coordinationUpdate(notes, working);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    taskId: leadId,
    ...(project ? { projectId: project.id } : {}),
    text: update.text,
    prompt: update.prompt,
    messageOrigin: { kind: "coordination" },
    attachments: [],
    coordination: { notes: notes.map((note) => note.id) },
  };
  return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, lead, project, worktreeFor(state, lead), false)]);
}
