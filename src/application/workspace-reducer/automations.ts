/** Scheduled ticks: what a thread arms, and what a tick makes of the run it starts. */
import { resolveWorkspaceEffect, withPending } from "./run-queue.js";
import { now, settled, targetId } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { coordinationNote } from "../coordination.js";
import { declinedTick, raisedFinding, whyTickCannotRun } from "../findings.js";
import { withNothingToReport } from "../run-testimony.js";
import { threadOnScreen } from "../thread-attention.js";
import { isWatching, sameAutomationFields, type AutomationView } from "../../domain/automation.js";
import { coordinatorOf, withCoordinationNote } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";
import { automationRunPrompt, updateThread } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";

export const AUTOMATION_INPUTS = [
  "automation.fired", "automation.notify", "automation.nothing-to-report", "automation.save", "automation.update", "automation.delete",
  "automation.run-now", "automations.changed", "view.edit-automation"
] as const;
type AutomationInput = Extract<WorkspaceInput, { type: (typeof AUTOMATION_INPUTS)[number] }>;

export function reduceAutomations(state: WorkspaceState, input: AutomationInput): WorkspaceTransition {
  switch (input.type) {
    /** The scheduler owns the cadence; the workspace decides whether this tick can actually run. */
    case "automation.fired": {
      const { fire } = input;
      const thread = state.threads.find((item) => item.id === fire.taskId);
      const project = thread ? projectFor(state, thread) : undefined;
      const refusal = whyTickCannotRun(state, fire, thread, project);
      if (refusal) return declinedTick(state, fire, thread, refusal);
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: fire.runId,
        origin: "automation",
        taskId: fire.taskId,
        ...(project ? { projectId: project.id } : {}),
        text: fire.prompt,
        prompt: automationRunPrompt(fire.prompt, fire.runNumber, fire.surfaceWhen, fire.endsWhen),
        messageOrigin: { kind: "automation", runNumber: fire.runNumber },
        attachments: [],
        ...(fire.policy ? { policy: fire.policy } : {}),
        ...(fire.quiet ? { quiet: true as const } : {}),
        ...(fire.unattended ? { unattended: true as const } : {}),
        automationId: fire.automationId,
      };
      return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, thread, project, worktreeFor(state, thread), false)]);
    }

    case "automation.notify":
      return raisedFinding(state, input);

    case "automation.nothing-to-report":
      return settled(withNothingToReport(state, input.taskId, input.checked, Date.now()));

    case "automation.save": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.save", draft: { ...input.draft, taskId } }]) : settled(state);
    }

    case "automation.update": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.update", taskId, patch: input.patch }]) : settled(state);
    }

    case "automation.delete": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(withoutAutomationEdit(state, taskId), [{ type: "automation.delete", taskId }]) : settled(state);
    }

    case "view.edit-automation": {
      if (sameAutomationFields(input.fields, input.base)) return settled(withoutAutomationEdit(state, input.taskId));
      return settled({ ...state, automationEdits: { ...state.automationEdits, [input.taskId]: { base: input.base, fields: input.fields } } });
    }

    case "automation.run-now": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.run-now", taskId }]) : settled(state);
    }

    case "automations.changed":
      return settled(withEndedWatches({ ...state, automations: input.automations }, state.automations));
  }
}

/**
 * A watch that is gone has finished, so its thread leaves Running for Priority the way a settled run
 * does, and its work reads as finished however an earlier tick ended, then. A tick still going when it
 * ended replaces this verdict with its own as it settles, and one that settles quietly returns the
 * thread to this verdict. Its coordinator hears it finished as the user sees it, here or, by the
 * moment its work ended, on the computer it works under.
 */
function withEndedWatches(state: WorkspaceState, before: readonly AutomationView[]): WorkspaceState {
  const kept = new Set(state.automations.map((automation) => automation.taskId));
  const ended = new Set(before.filter((automation) => isWatching(automation) && !kept.has(automation.taskId)).map((automation) => automation.taskId));
  if (!ended.size) return state;
  const at = now();
  const activeRuns = { ...state.activeRuns };
  const finished: Thread[] = [];
  const threads = state.threads.map((thread) => {
    if (!ended.has(thread.id) || thread.archivedAt !== undefined) return thread;
    const verdict = { outcome: "finished" as const, runEndedAs: "finished" as const, runEndedAt: at, ...(threadOnScreen(state, thread.id) ? {} : { outcomeUnread: true as const }) };
    const run = activeRuns[thread.id];
    if (run) activeRuns[thread.id] = { ...run, before: { ...run.before, ...verdict } };
    finished.push(thread);
    return { ...thread, ...verdict };
  });
  const watched = { ...state, threads, activeRuns };
  return finished.reduce((next, thread) => {
    const lead = coordinatorOf(next.threads, thread);
    return lead ? updateThread(next, lead.id, (item) => withCoordinationNote(item, coordinationNote(thread.id, `"${thread.title}" finished watching.`, at))) : next;
  }, watched);
}

/** An archived thread is unreachable, so its automation would tick forever with nowhere to run. */
export function retireAutomations(state: WorkspaceState, taskIds: Iterable<string>): WorkspaceEffect[] {
  const scheduled = new Set(state.automations.map((automation) => automation.taskId));
  return [...taskIds].filter((taskId) => scheduled.has(taskId)).map((taskId) => ({ type: "automation.delete" as const, taskId }));
}

export function ack(pending: PendingRun, started: boolean): WorkspaceEffect[] {
  return pending.automationId ? [{ type: "automation.ack", ack: { automationId: pending.automationId, runId: pending.runId, started } }] : [];
}

function withoutAutomationEdit(state: WorkspaceState, taskId: string): WorkspaceState {
  if (!(taskId in state.automationEdits)) return state;
  const { [taskId]: _dropped, ...automationEdits } = state.automationEdits;
  return { ...state, automationEdits };
}
