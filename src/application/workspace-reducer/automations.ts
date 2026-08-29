/** Scheduled ticks: what a thread arms, and what a tick makes of the run it starts. */
import { resolveWorkspaceEffect, settled, targetId, withPending } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { declinedTick, raisedFinding, whyTickCannotRun } from "../findings.js";
import { withNothingToReport } from "../run-testimony.js";
import { automationRunLabel, automationRunPrompt } from "../task-workspace.js";
import { projectFor, worktreeFor } from "../thread-location.js";
import type { PendingRun, WorkspaceState } from "../workspace-state.js";

type AutomationInput = Extract<WorkspaceInput, {
  type: "automation.fired" | "automation.notify" | "automation.nothing-to-report" | "automation.save" | "automation.update"
    | "automation.delete" | "automation.run-now" | "automations.changed";
}>;

export function reduceAutomations(state: WorkspaceState, input: AutomationInput): WorkspaceTransition {
  switch (input.type) {
    /** The scheduler owns the cadence; the workspace decides whether this tick can actually run. */
    case "automation.fired": {
      const { fire } = input;
      const task = state.tasks.find((item) => item.id === fire.taskId);
      const project = task ? projectFor(state, task) : undefined;
      const refusal = whyTickCannotRun(state, fire, task, project);
      if (refusal) return declinedTick(state, fire, task, refusal);
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: fire.runId,
        origin: "automation",
        taskId: fire.taskId,
        ...(project ? { projectId: project.id } : {}),
        text: fire.prompt,
        prompt: automationRunPrompt(fire.prompt, fire.runNumber, fire.surfaceWhen),
        detail: automationRunLabel(fire.runNumber),
        attachments: [],
        ...(fire.policy ? { policy: fire.policy } : {}),
        ...(fire.quiet ? { quiet: true as const } : {}),
        ...(fire.unattended ? { unattended: true as const } : {}),
        automationId: fire.automationId,
      };
      return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, task, project, worktreeFor(state, task), false)]);
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
      return taskId ? settled(state, [{ type: "automation.delete", taskId }]) : settled(state);
    }

    case "automation.run-now": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.run-now", taskId }]) : settled(state);
    }

    case "automations.changed":
      return settled({ ...state, automations: input.automations });
  }
}
