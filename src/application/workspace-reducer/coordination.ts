/** Coordinators and their threads: who works under whom, what they report, and what waits on the user. */
import { queuedFor, resolveWorkspaceEffect, threadBusy, withPending } from "./run-queue.js";
import { reduceSending } from "./sending.js";
import { now, rejected, settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { canResolve, checkoutAnswer, coordinatedThreadStatus, coordinationMembers, coordinationNote, coordinationUpdate, nextSteps, turnNote, workingMembers } from "../coordination.js";
import { activityChanges, threadActivity, threadChanges } from "../thread-activity.js";
import { heldByLimit } from "../limit-pauses.js";
import { announced } from "../notices.js";
import { updateThread } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { canJoinCoordinator, coordinatorOf, isCoordinator, MAX_ANSWER, nextStepOf, openDecisions, threadModelOf, undelegable, withAnswer, withCoordinationNote, withDecision, withMemoryChange, type CoordinationNote, type MemoryChange } from "../../domain/coordination.js";
import { defaultEffortFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../../domain/agent-engine.js";
import type { Thread } from "../../domain/thread.js";
import { dismissed } from "../../domain/attention.js";
import { resumesOnItsOwn } from "../../domain/usage-limit.js";

type CoordinationInput = Extract<WorkspaceInput, {
  type: "task.set-coordinator" | "task.resolve" | "task.reopen" | "decision.answer" | "coordination.set-thread-model" | "coordination.reported" | "coordination.decision-raised"
    | "memory.set-purpose" | "memory.add" | "memory.edit" | "memory.forget" | "coordination.remembered" | "coordination.next-step";
}>;

const STEP_GONE = "That step is no longer offered.";

const JOIN_REFUSED = "Only a coordinator can take threads under it, and a coordinator cannot work under another.";

export function reduceCoordination(state: WorkspaceState, input: CoordinationInput): WorkspaceTransition {
  switch (input.type) {
    case "task.set-coordinator": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread) return settled(state);
      /** Resolved only means anything under the coordinator that saw the work settle, so a move leaves it behind. */
      if (input.coordinatorId === null) {
        if (thread.parentId === undefined) return settled(state);
        return settled({ ...updateThread(state, thread.id, ({ parentId: _left, resolvedAt: _settled, ...item }) => ({ ...item, updatedAt: now() })), openMenu: null });
      }
      const lead = state.threads.find((item) => item.id === input.coordinatorId);
      if (!canJoinCoordinator(thread, lead)) return rejected(state, JOIN_REFUSED);
      if (thread.parentId === lead.id) return settled(state);
      return settled({ ...updateThread(state, thread.id, ({ resolvedAt: _settled, ...item }) => ({ ...item, parentId: lead.id, updatedAt: now() })), openMenu: null });
    }

    /**
     * Resolving files away what the thread's last run and its findings had to say, so a thread with
     * nothing left to do never holds its coordinator's row up in the list.
     */
    case "task.resolve": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || !coordinatorOf(state.threads, thread) || thread.resolvedAt !== undefined) return settled(state);
      const { working, blocked } = threadActivity(state);
      if (!canResolve(coordinatedThreadStatus(thread, working, blocked).status)) return rejected(state, "Finish or answer what this thread is waiting on first.");
      const resolved = updateThread(state, thread.id, (item) => ({ ...item, resolvedAt: now(), updatedAt: now() }));
      return settled({ ...resolved, threads: dismissed(resolved.threads, new Set([thread.id])) });
    }

    case "task.reopen": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || !coordinatorOf(state.threads, thread) || thread.resolvedAt === undefined) return settled(state);
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
      if (!thread || !coordinatorOf(state.threads, thread)) return rejected(state, STEP_GONE);
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
     * note, which it hears with the rest when the thread's turn ends.
     */
    case "coordination.reported": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = coordinatorOf(state.threads, thread);
      if (!thread || !lead) return settled(state);
      const at = now();
      const reported = updateThread(state, thread.id, (item) => ({ ...item, report: { state: input.state, summary: input.summary, at } }));
      if (input.state === "working") return settled(reported);
      const note = coordinationNote(thread.id, `"${thread.title}" reported ${input.state}: ${input.summary}`, at, input.state !== "done", state.activeRuns[thread.id]?.runId);
      return settled(updateThread(reported, lead.id, (item) => withCoordinationNote(item, note)));
    }

    /** The user is told at once; the coordinator hears it with the rest when the thread's turn ends. */
    case "coordination.decision-raised": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = thread && (isCoordinator(thread) ? thread : coordinatorOf(state.threads, thread));
      if (!thread || !lead) return settled(state);
      const at = now();
      const decision = {
        id: crypto.randomUUID(),
        question: input.request.question,
        ...(input.request.context ? { context: input.request.context } : {}),
        options: input.request.options,
        raisedAt: at,
      };
      const raised = updateThread(state, thread.id, (item) => withDecision(item, decision));
      if (lead === thread) return settled(raised, announced(raised, lead, `Needs you: ${decision.question}`));
      const asked = coordinationNote(thread.id, `"${thread.title}" asked the user to decide: ${decision.question}`, at, false, state.activeRuns[thread.id]?.runId);
      const noted = updateThread(raised, lead.id, (item) => withCoordinationNote(item, asked));
      return settled(noted, announced(noted, lead, `Needs you: ${decision.question}`));
    }
  }
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
export function noteTurnEnded(state: WorkspaceState, taskId: string, status: "succeeded" | "failed" | "cancelled"): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  const lead = coordinatorOf(state.threads, thread);
  if (!thread || !lead || (thread.limitPause && resumesOnItsOwn(thread.limitPause))) return state;
  return updateThread(state, lead.id, (item) => withCoordinationNote(item, turnNote(thread, status, now())));
}

/**
 * The one place a coordinator is woken. After every input, each coordinator the input could have
 * touched, through itself, its threads or who works under it, hears its news if it is due. A
 * coordinator the input stopped keeps what it holds quiet, so only news that arrives later wakes it.
 */
export function reconcileCoordination(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  const threads = threadChanges(previous.threads, transition.state.threads);
  const touched = activityChanges(previous, transition.state, threads);
  for (const { id, before, after } of threads) {
    if (!before || !after || before.parentId !== after.parentId || before.role !== after.role || before.archivedAt !== after.archivedAt || before.coordinationNotes !== after.coordinationNotes) touched.add(id);
  }
  if (!touched.size) return transition;
  const stopped = stoppedBy(previous, input);
  let state = stopped ? quieted(transition.state, stopped) : transition.state;
  const effects = [...transition.effects];
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
  if (input.type === "task.archive") return input.taskId;
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
 * threads that is still working. A run waiting for the user's approval no longer counts as working.
 */
function wakingNews(state: WorkspaceState, lead: Thread): CoordinationNote[] {
  const notes = (lead.coordinationNotes ?? []).filter((note) => !note.quiet);
  if (!notes.some((note) => note.runId)) return notes;
  const members = new Set(coordinationMembers(state, lead.id).map(({ thread }) => thread.id));
  const { working, blocked } = threadActivity(state);
  const going = (id: string, runId: string) => members.has(id) && state.activeRuns[id]?.runId === runId && working.has(id) && !blocked.has(id);
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
