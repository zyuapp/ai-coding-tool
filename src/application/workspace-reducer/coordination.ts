/** Coordinators and their threads: who works under whom, what they report, and what waits on the user. */
import { drainQueue, queuedFor, resolveWorkspaceEffect, stoppingProcess, withPending, withUnsent } from "./run-queue.js";
import { reduceSending } from "./sending.js";
import { released, remoteNews } from "./coordination-remote.js";
import { withProposalFailure } from "./proposals.js";
import { declined, now, recorded, rejected, settled, targetId } from "./shared.js";
import { DECISIONS_FULL, NO_COORDINATOR, NO_MEMORY, OUTSIDE_COORDINATION } from "./errors.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { canResolve, checkoutAnswer, coordinatedThreadStatus, coordinationMembers, coordinationRole, coordinatorRoster, coordinatorWork, coordinationUpdate, decisionHeadline, nextSteps, unheardWork, waitingLine, withNewsQuieted, type CoordinatorRoster } from "../coordination.js";
import { activityChanges, threadActivity, threadChanges, type ThreadChange } from "../thread-activity.js";
import { cancelPause, heldByLimit } from "../limit-pauses.js";
import { withFactsHeard } from "../member-facts.js";
import { announced } from "../notices.js";
import { withoutLapsedStops, withStopAll } from "../outstanding-stops.js";
import { updateThread } from "../thread-run-state.js";
import { threadBusy } from "../run-record.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { canJoinCoordinator, coordinatorOf, decisionsFull, isCoordinator, MAX_ANSWER, nextStepOf, openDecisions, remoteLeadOf, reopenedIfStuck, threadModelOf, undelegable, withAnswer, withDecision, withMemoryChange, worksUnderCoordinator, type CoordinationNote, type MemoryChange } from "../../domain/coordination.js";
import { defaultEffortFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../../domain/agent-engine.js";
import type { Thread } from "../../domain/thread.js";
import { dismissed } from "../../domain/attention.js";

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
      const sent = reduceSending(state, { type: "task.send", taskId: thread.id, text: `The user decided "${decision.question}": ${answer}`, steer: true }, {}, { answers: decision.id });
      return sent.result?.ok === false ? sent : { ...sent, state: answered(sent.state) };
    }

    /**
     * A next step is the user's own word to the thread, sent as any message of theirs is, but one its
     * coordinator offered, so the turn it starts is news for that coordinator. One the thread's card no
     * longer offers, as once it has started working, is refused and nothing is sent.
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
      return reduceSending(state, { type: "task.send", taskId: thread.id, text: nextStepOf(input.step).text }, {}, { step: true });
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
    case "coordination.remembered":
      return remembered(state, input.taskId, input.change, true);

    /**
     * Progress is not news: only a thread that is blocked, done or failed leaves its coordinator a
     * note, which it hears with the rest when the thread's turn ends. One that cannot go on is the
     * user's to hear about at once. A thread under a coordinator on another computer only records
     * where it stands: that computer reads it here, and hears and announces it there.
     */
    case "coordination.reported": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = coordinatorOf(state.threads, thread);
      if (!thread || !lead && !remoteLeadOf(thread)) return declined(state, NO_COORDINATOR);
      const at = now();
      const reported = updateThread(state, thread.id, (item) => reopenedIfStuck({ ...item, report: { state: input.state, summary: input.summary, at } }));
      if (!lead) return recorded(settled(reported));
      const report = { state: input.state, summary: input.summary, at };
      return recorded(withFactsHeard(reported, lead, thread, [{ kind: "reported", report, runId: state.activeRuns[thread.id]?.runId }], at));
    }

    /**
     * The user is told at once; the coordinator hears it with the rest when the thread's turn ends. A
     * thread under a coordinator on another computer only records it, for that computer to raise. A
     * thread with as many waiting as it may raises no more, and its tool call is told why.
     */
    case "coordination.decision-raised": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = thread && (isCoordinator(thread) ? thread : coordinatorOf(state.threads, thread));
      if (!thread || !lead && !remoteLeadOf(thread)) return declined(state, OUTSIDE_COORDINATION);
      if (decisionsFull(thread)) return declined(state, DECISIONS_FULL);
      const at = now();
      const decision = {
        id: input.decisionId ?? crypto.randomUUID(),
        question: input.request.question,
        ...(input.request.context ? { context: input.request.context } : {}),
        options: input.request.options,
        raisedAt: at,
      };
      const raised = updateThread(state, thread.id, (item) => withDecision(item, decision));
      if (!lead) return recorded(settled(raised));
      if (lead === thread) return recorded(settled(raised, announced(raised, lead, decisionHeadline(decision), "decision")));
      return recorded(withFactsHeard(raised, lead, thread, [{ kind: "raised", decision, runId: state.activeRuns[thread.id]?.runId }], at));
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
  /**
   * What it stops on paired computers, and each start it catches on its way to one, the coordinator
   * keeps, so a start is stopped whenever it lands and both are heard quietly, after a restart here too.
   * Stopping a workflow or subagent can make the agent take a turn of its own to answer it, which ends quietly too.
   */
  const outstanding = withStopAll(state, lead.id, {
    cancelled,
    hushed: sessionWork.map((work) => work.taskId),
    elsewhere,
    landing: landing.map((proposal) => ({ id: proposal.id, computer: proposal.place.computer!.id })),
  }, now());
  let next = settled(outstanding.state, [...cancelled.map((run): WorkspaceEffect => ({ type: "send-run-command", command: { type: "cancel", taskId: run.taskId, runId: run.runId } })), ...outstanding.effects]);
  for (const { taskId, processIds } of sessionWork) {
    for (const processId of processIds) next = followedBy(next, stoppingProcess(next.state, taskId, processId));
  }
  for (const { id } of threads) next = followedBy(next, cancelPause(next.state, id));
  for (const start of starts) {
    const { taskId, coordination } = start;
    const without = withUnsent(next.state, start);
    next = { ...next, state: coordination?.proposalId ? withProposalFailure(without, lead.id, coordination.proposalId, undefined) : without };
    /** What the user queued behind it goes back to its composer, as any stop hands it back. */
    if (taskId && !next.state.activeRuns[taskId]) next = followedBy(next, drainQueue(next.state, taskId, "hand-back"));
  }
  return next;
}

function followedBy(first: WorkspaceTransition, then: WorkspaceTransition): WorkspaceTransition {
  return { state: then.state, effects: [...first.effects, ...then.effects] };
}

/**
 * Only a coordinator keeps a memory; a change that alters nothing writes nothing. The coordinator's
 * own change, which its session hears as it makes it, is answered rather than refused to the user.
 */
function remembered(state: WorkspaceState, taskId: string, change: MemoryChange, heard: boolean): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === taskId);
  if (!lead || !isCoordinator(lead)) return heard ? declined(state, NO_MEMORY) : settled(state);
  const at = now();
  const changed = withMemoryChange(lead, change, at, { heard });
  if ("error" in changed) return heard ? declined(state, changed.error) : rejected(state, changed.error);
  const made = changed.thread === lead ? settled(state) : settled(updateThread(state, lead.id, () => ({ ...changed.thread, updatedAt: at })));
  return heard ? recorded(made, changed.noteId) : made;
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
  const said = [...remote.effects, ...released(previous, state, threads), ...roleChanges(previous, state, threads)];
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
 * The agent process is told of each thread whose coordination role an input changed, so a session
 * built for what the thread was, holding tools the thread no longer has, is let go.
 * A thread's role is read from it and its coordinator, so the threads under a changed one are read too.
 */
function roleChanges(previous: WorkspaceState, next: WorkspaceState, threads: readonly ThreadChange[]): WorkspaceEffect[] {
  const shaped = new Set(threads.flatMap(({ id, before, after }) => before && after && (before.role !== after.role || before.archivedAt !== after.archivedAt
    || before.parentId !== after.parentId || before.remoteLead !== after.remoteLead) ? [id] : []));
  if (!shaped.size) return [];
  const read = new Set([...shaped, ...next.threads.flatMap((thread) => thread.parentId !== undefined && shaped.has(thread.parentId) ? [thread.id] : [])]);
  return [...read].flatMap((id): WorkspaceEffect[] => {
    const before = previous.threads.find((thread) => thread.id === id);
    const after = next.threads.find((thread) => thread.id === id);
    if (!before || !after) return [];
    const role = coordinationRole(next.threads, after);
    if (coordinationRole(previous.threads, before) === role) return [];
    return [{ type: "send-run-command", command: { type: "role", taskId: id, ...(role ? { coordinationRole: role } : {}) } }];
  });
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
function wakingNews(state: WorkspaceState, lead: Thread, roster: CoordinatorRoster, unheard: ReadonlySet<string>): CoordinationNote[] {
  const notes = (lead.coordinationNotes ?? []).filter((note) => !note.quiet);
  if (!notes.some((note) => note.runId)) return notes;
  const members = new Map(roster.members.map((member) => [member.thread.id, member]));
  const going = (id: string, runId: string) => {
    if (unheard.has(id)) return true;
    const member = members.get(id);
    if (!member) return false;
    const runs = member.computer ? member.holder.activeRuns : state.activeRuns;
    return runs[id]?.runId === runId && member.working;
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
  const roster = coordinatorRoster(state, lead, threadActivity(state));
  const unheard = unheardWork(state, lead);
  const news = wakingNews(state, lead, roster, new Set(unheard.map(({ threadId }) => threadId)));
  if (!news.length) return settled(state);
  const working = roster.members.filter((member) => member.working).length + unheard.length;
  if (working && !news.some((note) => note.urgent)) return settled(state);
  const project = projectFor(state, lead);
  const waiting = waitingLine(roster.waiting, "the user");
  const update = coordinationUpdate(notes, working, waiting);
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
