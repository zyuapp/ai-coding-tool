/** Coordinators and their threads: who works under whom, what they report, and what waits on the user. */
import { answersInTime, drainQueue, queuedFor, resolveWorkspaceEffect, stoppingProcess, threadBusy, withPending, withUnsent } from "./run-queue.js";
import { reduceSending } from "./sending.js";
import { released, remoteNews, withoutLapsedStops } from "./coordination-remote.js";
import { withProposalFailure } from "./proposals.js";
import { now, rejected, settled, targetId } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { canResolve, checkoutAnswer, coordinatedThreadStatus, coordinationMembers, coordinatorWork, coordinationUpdate, decisionHeadline, decisionNote, memberWorking, nextSteps, reportHeadline, reportNote, unheardWork, withNewsQuieted, withTurnHeard, workingMembers } from "../coordination.js";
import { activityChanges, threadActivity, threadChanges } from "../thread-activity.js";
import { cancelPause, heldByLimit } from "../limit-pauses.js";
import { announced } from "../notices.js";
import { updateThread, type ActiveRun } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PairedComputer } from "../computers.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import type { AppCommand } from "../../contracts/commands.js";
import { canJoinCoordinator, coordinatorOf, decisionsFull, endsAsStopped, isCoordinator, MAX_ANSWER, nextStepOf, openDecisions, remoteLeadOf, reopenedIfStuck, threadModelOf, undelegable, withAnswer, withCoordinationNote, withDecision, withMemoryChange, worksUnderCoordinator, type CoordinationNote, type MemoryChange } from "../../domain/coordination.js";
import { defaultEffortFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../../domain/agent-engine.js";
import type { CaughtStart, RemoteStop, Thread } from "../../domain/thread.js";
import { dismissed } from "../../domain/attention.js";
import { resumesOnItsOwn } from "../../domain/usage-limit.js";
import { runOutcome } from "../../domain/thread-run.js";

type CoordinationInput = Extract<WorkspaceInput, {
  type: "task.set-coordinator" | "task.set-lead-away" | "task.resolve" | "task.reopen" | "decision.answer" | "coordination.set-thread-model" | "coordination.set-muted" | "coordination.stop-all" | "coordination.reported" | "coordination.decision-raised"
    | "memory.set-purpose" | "memory.add" | "memory.edit" | "memory.forget" | "coordination.remembered" | "coordination.next-step";
}>;

const STEP_GONE = "That step is no longer offered.";

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
     * A thread keeps the coordinator elsewhere it works under while that one is away, as a thread here
     * keeps its own, and what it settled under it, so it is back as it was once that coordinator is.
     */
    case "task.set-lead-away": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const held = thread?.parentId === undefined ? thread?.remoteLead : undefined;
      if (!held || (held.away === true) === input.away) return settled(state);
      const { away: _was, ...lead } = held;
      return settled(updateThread(state, input.taskId, (item) => ({ ...item, remoteLead: input.away ? { ...lead, away: true } : { ...lead, backAt: now() }, updatedAt: now() })));
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
      /**
       * A decision only closes once its answer is on its way, so one that could not be sent can be
       * answered again. The message says what it answers, queued behind a run or starting one, so
       * the decision opens again if it never goes.
       */
      const sent = reduceSending(state, { type: "task.send", taskId: thread.id, text: `The user decided "${decision.question}": ${answer}`, steer: true }, {}, decision.id);
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
      const reported = updateThread(state, thread.id, (item) => reopenedIfStuck({ ...item, report: { state: input.state, summary: input.summary, at } }));
      if (!lead || input.state === "working") return settled(reported);
      const report = { state: input.state, summary: input.summary, at };
      const noted = updateThread(reported, lead.id, (item) => withCoordinationNote(item, reportNote(thread, report, at, state.activeRuns[thread.id]?.runId)));
      if (input.state === "done") return settled(noted);
      return settled(noted, announced(noted, thread, reportHeadline(report), "blocked"));
    }

    /**
     * The user is told at once; the coordinator hears it with the rest when the thread's turn ends. A
     * thread under a coordinator on another computer only records it, for that computer to raise. A
     * thread with as many waiting as it may raises no more, which its tool call was already told.
     */
    case "coordination.decision-raised": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = thread && (isCoordinator(thread) ? thread : coordinatorOf(state.threads, thread));
      if (!thread || !lead && !remoteLeadOf(thread) || decisionsFull(thread)) return settled(state);
      const at = now();
      const decision = {
        id: input.decisionId ?? crypto.randomUUID(),
        question: input.request.question,
        ...(input.request.context ? { context: input.request.context } : {}),
        options: input.request.options,
        raisedAt: at,
      };
      const raised = updateThread(state, thread.id, (item) => withDecision(item, decision));
      if (!lead) return settled(raised);
      if (lead === thread) return settled(raised, announced(raised, lead, decisionHeadline(decision), "decision"));
      const noted = updateThread(raised, lead.id, (item) => withCoordinationNote(item, decisionNote(thread, decision, at, state.activeRuns[thread.id]?.runId)));
      return settled(noted, announced(noted, lead, decisionHeadline(decision), "decision"));
    }
  }
}

/**
 * Stops a coordinator and every thread under it: each run is cancelled, each workflow and subagent
 * that would outlive it is stopped, each wait on a usage limit ends, and the coordinator's wake and
 * each start of a new thread under it are dropped, handing back what the user queued. A start already
 * carried to a paired computer cannot be called back, so it is stopped there as it lands. The runs it
 * cancels end quietly, so nothing it stopped wakes the coordinator to carry on; scheduled ticks are
 * the user's to stop one by one. A thread under it on another computer is stopped there, by a
 * computer whose build can.
 */
function stopAll(state: WorkspaceState, leadId: string): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === leadId);
  if (!lead || !isCoordinator(lead)) return settled(state);
  const { threads, starts, sessionWork, elsewhere, landing } = coordinatorWork(state, lead);
  const cancelled = threads.flatMap(({ id }) => state.activeRuns[id] ?? []);
  const remote = remoteStops(elsewhere, now());
  /** A run that never said it ended leaves its id behind, so only runs still going are kept. */
  const going = new Set(Object.values(state.activeRuns).map((run) => run.runId));
  const quietStops = [...state.quietStops.filter((runId) => going.has(runId)), ...cancelled.map((run) => run.runId)];
  /**
   * What it stops on paired computers, and each start it catches on its way to one, the coordinator
   * keeps, so a start is stopped whenever it lands and both are heard quietly, after a restart here too.
   */
  const caught = Object.fromEntries(landing.map((proposal): [string, CaughtStart] => [proposal.id, { computer: proposal.place.computer!.id }]));
  const stopping = Object.keys(remote.stops).length || landing.length ? updateThread(state, lead.id, (item) => ({
    ...item,
    ...Object.keys(remote.stops).length ? { remoteStops: { ...item.remoteStops, ...remote.stops } } : {},
    ...landing.length ? { caughtStarts: { ...item.caughtStarts, ...caught } } : {},
  })) : state;
  /** Stopping a workflow or subagent can make the agent take a turn of its own to answer it, which ends quietly too. */
  const hushed = new Set(sessionWork.map((work) => work.taskId));
  const at = now();
  const quietSessions = [
    ...state.quietSessions.filter((session) => !hushed.has(session.taskId) && answersInTime(session, at) && state.threads.some((thread) => thread.id === session.taskId)),
    ...[...hushed].map((taskId) => ({ taskId, at })),
  ];
  let next = settled({ ...stopping, quietStops, quietSessions }, [...cancelled.map((run): WorkspaceEffect => ({ type: "send-run-command", command: { type: "cancel", taskId: run.taskId, runId: run.runId } })), ...remote.effects]);
  for (const { taskId, processIds } of sessionWork) {
    for (const processId of processIds) next = followedBy(next, stoppingProcess(next.state, taskId, processId));
  }
  for (const { id } of threads) next = followedBy(next, cancelPause(next.state, id));
  for (const start of starts) {
    const { taskId, coordination } = start;
    const without = withUnsent(next.state, start);
    next = { ...next, state: coordination?.proposalId ? withProposalFailure(without, lead.id, coordination.proposalId, undefined) : without };
    /** What the user queued behind it goes back to its composer, as any stop hands it back. */
    if (taskId && !next.state.activeRuns[taskId]) next = followedBy(next, drainQueue(next.state, taskId, "cancelled"));
  }
  return next;
}

/**
 * What stops the work of a coordinator's threads on paired computers: one batch for each computer,
 * with only what its build takes, and the runs and the waits to carry on after a session limit it
 * ends, so their ends are heard quietly here.
 */
function remoteStops(work: ReturnType<typeof coordinatorWork>["elsewhere"], at: number): { effects: WorkspaceEffect[]; stops: Record<string, RemoteStop> } {
  const batches = new Map<string, { computer: PairedComputer; inputs: AppCommand[] }>();
  const stops: Record<string, RemoteStop> = {};
  for (const { thread, computer, runId, processIds } of work) {
    const batch = batches.get(computer.id) ?? { computer, inputs: [] };
    const cancel: AppCommand = { type: "run.cancel", taskId: thread.id };
    if (runId && supportsComputerCommand(computer.capabilities, cancel)) {
      batch.inputs.push(cancel);
      stops[thread.id] = { computer: computer.id, runId };
    }
    const lifted: AppCommand = { type: "limit.cancel", taskId: thread.id };
    if (thread.limitPause && supportsComputerCommand(computer.capabilities, lifted)) {
      batch.inputs.push(lifted);
      if (resumesOnItsOwn(thread.limitPause)) stops[thread.id] ??= { computer: computer.id };
    }
    /** Only what that computer's build can stop is counted as its work, so each goes, and the agent's answer to it there ends quietly, as one here does. */
    batch.inputs.push(...processIds.map((processId): AppCommand => ({ type: "run.stop-process", taskId: thread.id, processId })));
    if (processIds.length) stops[thread.id] = { ...stops[thread.id] ?? { computer: computer.id }, answer: { at } };
    batches.set(computer.id, batch);
  }
  const effects = [...batches.values()].flatMap(({ computer, inputs }): WorkspaceEffect[] => inputs.length ? [{ type: "computer.forward", id: computer.id, inputs }] : []);
  return { effects, stops };
}

function followedBy(first: WorkspaceTransition, then: WorkspaceTransition): WorkspaceTransition {
  return { state: then.state, effects: [...first.effects, ...then.effects] };
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
 * by itself, so its turn has not ended unless the user keeps it from carrying on.
 */
export function noteTurnEnded(state: WorkspaceState, taskId: string, status: "succeeded" | "failed" | "cancelled", run: Pick<ActiveRun, "runId" | "answersStop">): WorkspaceState {
  /**
   * A run Stop all cancelled is heard, but never wakes its coordinator by itself once it has stopped,
   * as one on a paired computer is; nor does the turn the agent opened itself to answer the stop.
   */
  const stopped = state.quietStops.includes(run.runId);
  const quiet = run.answersStop === true || stopped && endsAsStopped(runOutcome(status) ?? undefined);
  const ended = stopped ? { ...state, quietStops: state.quietStops.filter((id) => id !== run.runId) } : state;
  const thread = ended.threads.find((item) => item.id === taskId);
  if (!thread || (thread.limitPause && resumesOnItsOwn(thread.limitPause))) return ended;
  return withTurnHeard(ended, thread, status, now(), { quiet });
}

/**
 * The one place a coordinator is woken. After every input, each coordinator the input could have
 * touched, through itself, its threads or who works under it, hears its news if it is due. A
 * coordinator the input stopped keeps what it holds quiet, so only news that arrives later wakes it.
 */
export function reconcileCoordination(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  /** Quieted first, since a stop may only have asked for runs to end and changed nothing else yet. */
  const stopped = stoppedBy(previous, input);
  const quiet = stopped ? withNewsQuieted(transition.state, stopped) : transition.state;
  /** What paired computers say of the threads coordinators here started there is news like any thread's. */
  const remote = remoteNews(previous, quiet);
  const threads = threadChanges(previous.threads, remote.state.threads);
  let state = withoutLapsedStops(remote.state, threads);
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
 * The coordinator the user just stopped, filed away, took the role off, or whose run could not
 * start, so its news is not pressed on it again at once.
 */
function stoppedBy(previous: WorkspaceState, input: WorkspaceInput): string | undefined {
  if (input.type === "task.archive" || input.type === "coordination.stop-all") return input.taskId;
  if (input.type === "task.set-role" && input.role !== "coordinator") {
    const taskId = targetId(previous, input.taskId);
    const lead = previous.threads.find((thread) => thread.id === taskId);
    return lead?.role === "coordinator" ? lead.id : undefined;
  }
  if (input.type === "run.event" && input.event.type === "run.status" && input.event.status === "cancelled") {
    return previous.activeRuns[input.event.taskId]?.runId === input.event.runId ? input.event.taskId : undefined;
  }
  if (input.type === "run.unresolved") return previous.pendingRuns[input.pendingId]?.taskId;
  if (input.type === "limit.cancel") return previous.threads.find((thread) => thread.id === input.taskId)?.limitPause ? input.taskId : undefined;
  return undefined;
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
 * threads that is still working, here or on the computer that holds it, as that computer last said.
 * A run waiting for the user's approval no longer counts as working.
 */
function wakingNews(state: WorkspaceState, lead: Thread): CoordinationNote[] {
  const notes = (lead.coordinationNotes ?? []).filter((note) => !note.quiet);
  if (!notes.some((note) => note.runId)) return notes;
  const members = new Map(coordinationMembers(state, lead.id).map((member) => [member.thread.id, member]));
  const unheard = new Set(unheardWork(state, lead).map(({ threadId }) => threadId));
  const going = (id: string, runId: string) => {
    if (unheard.has(id)) return true;
    const member = members.get(id);
    if (!member) return false;
    const runs = member.computer ? member.holder.activeRuns : state.activeRuns;
    return runs[id]?.runId === runId && memberWorking(state, member);
  };
  return notes.filter((note) => !note.runId || !going(note.threadId, note.runId));
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
  const working = workingMembers(state, lead);
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
