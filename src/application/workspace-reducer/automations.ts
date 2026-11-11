/** Scheduled ticks: what a thread arms, and what a tick makes of the run it starts. */
import { pendingStep, resolveWorkspaceEffect } from "./run-queue.js";
import { runsOf, watchesEndedBeforeIn } from "./run-edits.js";
import { now, targetId } from "./shared.js";
import { afterward, type SliceTransition, type Step } from "./slice.js";
import { finishedIn, notedIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import { coordinationNote } from "../coordination-messages.js";
import { declinedTick, raisedFinding, whyTickCannotRun } from "../findings.js";
import { nothingToReport } from "../run-testimony.js";
import { threadOnScreen } from "../thread-attention.js";
import { isWatching, sameAutomationFields, type AutomationView } from "../../domain/automation.js";
import { coordinatorOf } from "../../domain/coordination.js";
import type { FindingsThread } from "../../domain/finding.js";
import type { Thread } from "../../domain/thread.js";
import { automationRunPrompt, finishedVerdict, type FinishedVerdict } from "../thread-run-state.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";
import type { AutomationsState } from "../state/automations.js";
import type { AutomationAck, AutomationFire } from "../../contracts/ipc.js";
import type { AutomationDraft, AutomationPatch } from "../../domain/automation.js";

export const AUTOMATION_INPUTS = [
  "automation.save", "automation.update", "automation.delete", "automation.run-now", "view.edit-automation",
  "automation.fired", "automation.notify", "automation.nothing-to-report", "automations.changed"
] as const;
type AutomationInput = Extract<WorkspaceInput, { type: (typeof AUTOMATION_INPUTS)[number] }>;

/** What schedules keep is the automations' own; on threads, what their runs found. */
type AutomationTransition = SliceTransition<AutomationsState, FindingsThread>;

export type AutomationEvent =
  | { type: "automation.fired"; fire: AutomationFire }
  | { type: "automations.changed"; automations: AutomationView[] };

export type AutomationEffect =
  | { type: "automation.save"; draft: AutomationDraft }
  | { type: "automation.update"; taskId: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId: string }
  | { type: "automation.run-now"; taskId: string }
  | { type: "automation.ack"; ack: AutomationAck };

export function reduceAutomations(state: WorkspaceState, input: AutomationInput): AutomationTransition {
  switch (input.type) {
    case "automation.save": {
      const taskId = targetId(state, input.taskId);
      return taskId ? { effects: [{ type: "automation.save", draft: { ...input.draft, taskId } }] } : {};
    }

    case "automation.update": {
      const taskId = targetId(state, input.taskId);
      return taskId ? { effects: [{ type: "automation.update", taskId, patch: input.patch }] } : {};
    }

    case "automation.delete": {
      const taskId = targetId(state, input.taskId);
      return taskId ? { ...withoutAutomationEdit(state, taskId), effects: [{ type: "automation.delete", taskId }] } : {};
    }

    case "view.edit-automation": {
      if (sameAutomationFields(input.fields, input.base)) return withoutAutomationEdit(state, input.taskId);
      return { patch: { automationEdits: { ...state.automationEdits, [input.taskId]: { base: input.base, fields: input.fields } } } };
    }

    case "automation.run-now": {
      const taskId = targetId(state, input.taskId);
      return taskId ? { effects: [{ type: "automation.run-now", taskId }] } : {};
    }

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
      return { ...pendingStep(state, pending), effects: [resolveWorkspaceEffect(pending.id, thread, project, worktreeFor(state, thread), false)] };
    }

    case "automation.notify":
      return raisedFinding(state, input);

    case "automation.nothing-to-report":
      return nothingToReport(state, input.taskId, input.checked, Date.now());

    case "automations.changed": {
      const patch = { automations: input.automations };
      return { patch, ...endedWatches(afterward(state, { patch }), state.automations) };
    }
  }
}

/**
 * A watch that is gone has finished, so its thread leaves Running for Priority the way a settled run
 * does, and its work reads as finished however an earlier tick ended, then. A tick still going when it
 * ended replaces this verdict with its own as it settles, and one that settles quietly returns the
 * thread to this verdict. Its coordinator hears it finished as the user sees it, here or, by the
 * moment its work ended, on the computer it works under.
 */
function endedWatches(state: WorkspaceState, before: readonly AutomationView[]): Step {
  const kept = new Set(state.automations.map((automation) => automation.taskId));
  const ended = new Set(before.filter((automation) => isWatching(automation) && !kept.has(automation.taskId)).map((automation) => automation.taskId));
  if (!ended.size) return {};
  const at = now();
  const verdicts = new Map<string, FinishedVerdict>();
  const finished: Thread[] = [];
  for (const thread of state.threads) {
    if (!ended.has(thread.id) || thread.archivedAt !== undefined) continue;
    verdicts.set(thread.id, finishedVerdict(at, threadOnScreen(state, thread.id)));
    finished.push(thread);
  }
  const runs = watchesEndedBeforeIn(runsOf(state), verdicts);
  let threads = finishedIn(threadsOf(state), verdicts);
  for (const thread of finished) {
    const lead = coordinatorOf(threads.view.threads, thread);
    if (lead) threads = notedIn(threads, lead.id, coordinationNote(thread.id, `"${thread.title}" finished watching.`, at));
  }
  return { edits: [threads, runs] };
}

/** An archived thread is unreachable, so its automation would tick forever with nowhere to run. */
export function retireAutomations(state: WorkspaceState, taskIds: Iterable<string>): WorkspaceEffect[] {
  const scheduled = new Set(state.automations.map((automation) => automation.taskId));
  return [...taskIds].filter((taskId) => scheduled.has(taskId)).map((taskId) => ({ type: "automation.delete" as const, taskId }));
}

export function ack(pending: PendingRun, started: boolean): WorkspaceEffect[] {
  return pending.automationId ? [{ type: "automation.ack", ack: { automationId: pending.automationId, runId: pending.runId, started } }] : [];
}

function withoutAutomationEdit(state: WorkspaceState, taskId: string): AutomationTransition {
  if (!(taskId in state.automationEdits)) return {};
  const { [taskId]: _dropped, ...automationEdits } = state.automationEdits;
  return { patch: { automationEdits } };
}
