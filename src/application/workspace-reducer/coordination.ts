/** Coordinators and their threads: who works under whom, what they report, and what waits on the user. */
import { queuedFor, resolveWorkspaceEffect, threadBusy, withPending } from "./run-queue.js";
import { reduceSending } from "./sending.js";
import { now, rejected, settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { COORDINATION_UPDATE_DETAIL, coordinationNote, coordinationUpdate, turnNote, workingMembers } from "../coordination.js";
import { heldByLimit } from "../limit-pauses.js";
import { announced } from "../notices.js";
import { updateThread } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { canJoinCoordinator, coordinatorOf, isCoordinator, MAX_ANSWER, openDecisions, withAnswer, withCoordinationNote, withDecision } from "../../domain/coordination.js";
import { resumesOnItsOwn } from "../../domain/usage-limit.js";

type CoordinationInput = Extract<WorkspaceInput, {
  type: "task.set-coordinator" | "decision.answer" | "coordination.reported" | "coordination.decision-raised";
}>;

const JOIN_REFUSED = "Only a coordinator can take threads under it, and a coordinator cannot work under another.";

export function reduceCoordination(state: WorkspaceState, input: CoordinationInput): WorkspaceTransition {
  switch (input.type) {
    case "task.set-coordinator": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread) return settled(state);
      /** The coordinator it leaves may have been holding news for it alone. */
      const former = coordinatorOf(state.threads, thread);
      const released = (next: WorkspaceState) => former ? deliverCoordinationNotes(next, former.id) : settled(next);
      if (input.coordinatorId === null) {
        if (thread.parentId === undefined) return settled(state);
        return released({ ...updateThread(state, thread.id, ({ parentId: _left, ...item }) => ({ ...item, updatedAt: now() })), openMenu: null });
      }
      const lead = state.threads.find((item) => item.id === input.coordinatorId);
      if (!canJoinCoordinator(thread, lead)) return rejected(state, JOIN_REFUSED);
      if (thread.parentId === lead.id) return settled(state);
      return released({ ...updateThread(state, thread.id, (item) => ({ ...item, parentId: lead.id, updatedAt: now() })), openMenu: null });
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
      const note = coordinationNote(thread.id, `"${thread.title}" reported ${input.state}: ${input.summary}`, at, input.state !== "done");
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
      const noted = updateThread(raised, lead.id, (item) => withCoordinationNote(item, coordinationNote(thread.id, `"${thread.title}" asked the user to decide: ${decision.question}`, at)));
      return settled(noted, announced(noted, lead, `Needs you: ${decision.question}`));
    }
  }
}

/**
 * What a settled run means for the coordinators around it. A thread's turn ending is news for its
 * coordinator, which hears it once it is free and its other threads have stopped working, or at
 * once when the news is urgent. A thread waiting out a session limit carries on by itself, so its
 * turn has not ended. A coordinator coming free hears whatever is due, unless the user just stopped it.
 */
export function settleCoordination(state: WorkspaceState, taskId: string, status: "succeeded" | "failed" | "cancelled"): WorkspaceTransition {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread) return settled(state);
  const lead = coordinatorOf(state.threads, thread);
  if (lead) {
    if (thread.limitPause && resumesOnItsOwn(thread.limitPause)) return settled(state);
    const noted = updateThread(state, lead.id, (item) => withCoordinationNote(item, turnNote(thread, status, now())));
    return deliverCoordinationNotes(noted, lead.id);
  }
  return isCoordinator(thread) && status !== "cancelled" ? deliverCoordinationNotes(state, thread.id) : settled(state);
}

/** A thread under a coordinator that stops working without ending a turn may be the last one its coordinator's news waited for. */
export function releaseCoordinator(state: WorkspaceState, taskId: string | undefined): WorkspaceTransition {
  const lead = coordinatorOf(state.threads, state.threads.find((item) => item.id === taskId));
  return lead ? deliverCoordinationNotes(state, lead.id) : settled(state);
}

/** What a restored workspace owes its coordinators: the notes that were waiting when the app last closed. */
export function deliverRestoredNotes(state: WorkspaceState): WorkspaceTransition {
  return state.threads.filter((thread) => thread.coordinationNotes?.length).reduce<WorkspaceTransition>((transition, lead) => {
    const delivered = deliverCoordinationNotes(transition.state, lead.id);
    return { state: delivered.state, effects: [...transition.effects, ...delivered.effects] };
  }, settled(state));
}

/**
 * Wakes a free coordinator with its waiting notes, all at once rather than one wake per thread. The
 * notes stay until its run actually starts. One waiting out a usage limit hears them once its resumed
 * run ends.
 */
export function deliverCoordinationNotes(state: WorkspaceState, leadId: string): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === leadId);
  const notes = lead?.coordinationNotes ?? [];
  if (!isCoordinator(lead) || !notes.length || threadBusy(state, leadId) || queuedFor(state, leadId).length || heldByLimit(state, leadId, now())) return settled(state);
  const working = workingMembers(state, leadId).length;
  if (working && !notes.some((note) => note.urgent)) return settled(state);
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
    detail: COORDINATION_UPDATE_DETAIL,
    attachments: [],
    coordination: { notes: notes.map((note) => note.id) },
  };
  return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, lead, project, worktreeFor(state, lead), false)]);
}
