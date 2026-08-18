import type { AutomationDraft, AutomationPatch } from "../domain/automation.js";
import type { AgentModel, ExecutionPolicy } from "../domain/run.js";
import type { RunAttachment, TaskDropTarget } from "../domain/task.js";

/**
 * Every interaction the application supports, named as data. The UI dispatches these instead of
 * mutating state, so any other caller — a tool, a script, a test — can drive the same behaviour
 * through the same door. Anything that reaches {@link AppCommand} from outside the window has to be
 * validated at that boundary first, the way `isRunCommand` guards the run channel.
 */
export type AppCommand = TaskCommand | ProjectCommand | RunControlCommand | AutomationCommand | ViewCommand;

/** Commands that act on the task the user is looking at read `currentId` from state rather than taking an id. */
export type TaskCommand =
  | { type: "task.new"; projectId?: string }
  | { type: "task.select"; taskId: string }
  | { type: "task.archive"; taskId: string }
  | { type: "task.move"; taskId: string; target: TaskDropTarget }
  | { type: "task.set-policy"; policy: ExecutionPolicy }
  | { type: "task.set-model"; model: AgentModel }
  | { type: "task.send"; attachments?: RunAttachment[] };

export type ProjectCommand =
  | { type: "project.open" }
  | { type: "project.remove"; projectId: string };

export type RunControlCommand =
  | { type: "run.cancel" }
  | { type: "run.decide"; allow: boolean };

export type AutomationCommand =
  | { type: "automation.save"; draft: Omit<AutomationDraft, "taskId"> }
  | { type: "automation.update"; patch: AutomationPatch }
  | { type: "automation.delete" }
  | { type: "automation.run-now" };

/** Window-local presentation state. Nothing here outlives the window or reaches the agent process. */
export type ViewCommand =
  | { type: "view.set-prompt"; prompt: string }
  | { type: "view.toggle-project"; projectId: string }
  | { type: "view.set-projects-open"; open: boolean }
  | { type: "view.set-recents-open"; open: boolean }
  | { type: "view.set-menu"; menu: string | null }
  | { type: "view.set-focused"; focused: boolean }
  | { type: "view.dismiss-computer-use-setup" }
  | { type: "view.refresh-environment" };
