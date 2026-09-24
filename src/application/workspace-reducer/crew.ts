/** Coordinators and their threads: who works under whom, what they report, and what waits on the user. */
import { queuedFor, resolveWorkspaceEffect, threadBusy, withPending } from "./run-queue.js";
import { reduceSending } from "./sending.js";
import { now, rejected, settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { CREW_UPDATE_DETAIL, crewUpdate, turnNote } from "../crew.js";
import { announced } from "../notices.js";
import { updateThread } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import { canJoinCrew, crewLead, isCoordinator, openDecisions, withAnswer, withCrewNote, withDecision } from "../../domain/crew.js";

type CrewInput = Extract<WorkspaceInput, {
  type: "task.set-coordinator" | "decision.answer" | "view.set-crew-open" | "crew.reported" | "crew.decision-raised";
}>;

const JOIN_REFUSED = "Only a coordinator can take threads under it, and a coordinator cannot work under another.";

export function reduceCrew(state: WorkspaceState, input: CrewInput): WorkspaceTransition {
  switch (input.type) {
    case "task.set-coordinator": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread) return settled(state);
      if (input.coordinatorId === null) {
        if (thread.parentId === undefined) return settled(state);
        return settled({ ...updateThread(state, thread.id, ({ parentId: _left, ...item }) => ({ ...item, updatedAt: now() })), openMenu: null });
      }
      const lead = state.threads.find((item) => item.id === input.coordinatorId);
      if (!canJoinCrew(thread, lead)) return rejected(state, JOIN_REFUSED);
      if (thread.parentId === lead.id) return settled(state);
      return settled({ ...updateThread(state, thread.id, (item) => ({ ...item, parentId: lead.id, updatedAt: now() })), openMenu: null });
    }

    /** The answer is recorded, then said to the thread that asked, which queues it behind a run already going. */
    case "decision.answer": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const decision = thread && openDecisions(thread).find((item) => item.id === input.decisionId);
      const answer = input.answer.trim();
      if (!thread || !decision || !answer) return settled(state);
      const answered = updateThread(state, thread.id, (item) => withAnswer(item, decision.id, answer, now()));
      if (thread.archivedAt !== undefined) return settled(answered);
      return reduceSending(answered, { type: "task.send", taskId: thread.id, text: `The user decided "${decision.question}": ${answer}` });
    }

    case "view.set-crew-open": {
      const closed = !input.open;
      if (state.closedCrews.has(input.taskId) === closed) return settled(state);
      const closedCrews = new Set(state.closedCrews);
      if (closed) closedCrews.add(input.taskId);
      else closedCrews.delete(input.taskId);
      return settled({ ...state, closedCrews });
    }

    /** Progress is not news: only a thread that is blocked, done or failed leaves its coordinator a note. */
    case "crew.reported": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = crewLead(state.threads, thread);
      if (!thread || !lead) return settled(state);
      const at = now();
      const reported = updateThread(state, thread.id, (item) => ({ ...item, report: { state: input.state, summary: input.summary, at } }));
      if (input.state === "working") return settled(reported);
      return settled(updateThread(reported, lead.id, (item) => withCrewNote(item, { threadId: thread.id, text: `"${thread.title}" reported ${input.state}: ${input.summary}`, at })));
    }

    /** The user is told at once; the coordinator hears it with the rest when the thread's turn ends. */
    case "crew.decision-raised": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const lead = thread && (isCoordinator(thread) ? thread : crewLead(state.threads, thread));
      if (!thread || !lead) return settled(state);
      const at = now();
      const decision = {
        id: crypto.randomUUID(),
        question: input.request.question,
        ...(input.request.context ? { context: input.request.context } : {}),
        options: input.request.options,
        raisedAt: at,
      };
      let next = updateThread(state, thread.id, (item) => withDecision(item, decision));
      if (lead !== thread) next = updateThread(next, lead.id, (item) => withCrewNote(item, { threadId: thread.id, text: `"${thread.title}" asked the user to decide: ${decision.question}`, at }));
      return settled(next, announced(next, lead, `Needs you: ${decision.question}`));
    }
  }
}

/**
 * What a settled run means for the coordinators around it. A thread's turn ending is news for its
 * coordinator, which hears it at once if it is free. A coordinator coming free hears whatever
 * arrived while it was busy, unless the user just stopped it.
 */
export function settleCrew(state: WorkspaceState, taskId: string, status: "succeeded" | "failed" | "cancelled"): WorkspaceTransition {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread) return settled(state);
  const lead = crewLead(state.threads, thread);
  if (lead) {
    const noted = updateThread(state, lead.id, (item) => withCrewNote(item, turnNote(thread, status, now())));
    return deliverCrewNotes(noted, lead.id);
  }
  return isCoordinator(thread) && status !== "cancelled" ? deliverCrewNotes(state, thread.id) : settled(state);
}

/** Wakes a free coordinator with its waiting notes. The notes stay until its run actually starts. */
export function deliverCrewNotes(state: WorkspaceState, leadId: string): WorkspaceTransition {
  const lead = state.threads.find((item) => item.id === leadId);
  const notes = lead?.crewNotes ?? [];
  if (!isCoordinator(lead) || !notes.length || threadBusy(state, leadId) || queuedFor(state, leadId).length) return settled(state);
  const project = projectFor(state, lead);
  const update = crewUpdate(notes);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    taskId: leadId,
    ...(project ? { projectId: project.id } : {}),
    text: update.text,
    prompt: update.prompt,
    detail: CREW_UPDATE_DETAIL,
    attachments: [],
    crew: { notes: notes.length },
  };
  return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, lead, project, worktreeFor(state, lead), false)]);
}
