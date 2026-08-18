import type { AutomationDraft, AutomationPatch } from "../domain/automation.js";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../domain/run.js";
import type { RunAttachment, TaskDropTarget } from "../domain/task.js";

/**
 * Every interaction the application supports, named as data. The UI dispatches these instead of
 * mutating state, so any other caller — a tool, a script, a test — can drive the same behaviour
 * through the same door. Anything that reaches {@link AppCommand} from outside the window has to be
 * validated at that boundary first, the way `isRunCommand` guards the run channel.
 */
export type AppCommand = TaskCommand | ProjectCommand | RunControlCommand | SideChatCommand | AutomationCommand | ViewCommand;

/** Commands that carry no `taskId` act on the task the user is looking at, read from `currentId`. */
export type TaskCommand =
  | { type: "task.new"; projectId?: string }
  | { type: "task.select"; taskId: string }
  | { type: "task.archive"; taskId: string }
  | { type: "task.restore"; taskId: string }
  | { type: "task.clear-archive" }
  | { type: "task.rename"; taskId: string; title: string }
  | { type: "task.move"; taskId: string; target: TaskDropTarget }
  /** Without a `taskId` the setting also becomes the draft the next new task starts from. */
  | { type: "task.set-policy"; taskId?: string; policy: ExecutionPolicy }
  | { type: "task.set-model"; taskId?: string; model: AgentModel }
  | { type: "task.set-effort"; taskId?: string; effort: AgentEffort }
  /**
   * While a run is going the message is queued instead; `steer` pushes it into that run straight away.
   * `text` sends that message instead of the composer draft and leaves the draft alone: only the
   * composer's own send falls back to the current task, so a send carrying `text` and no `taskId`
   * always starts a new task, in `projectId`.
   */
  | { type: "task.send"; taskId?: string; projectId?: string; text?: string; attachments?: RunAttachment[]; steer?: boolean }
  | { type: "task.steer-queued"; taskId?: string; messageId: string }
  | { type: "task.drop-queued"; taskId?: string; messageId: string };

export type ProjectCommand =
  | { type: "project.open" }
  | { type: "project.remove"; projectId: string };

export type RunControlCommand =
  | { type: "run.cancel"; taskId?: string }
  | { type: "run.decide"; allow: boolean };

/** A side chat forks the current task's thread and is discarded when it closes. */
export type SideChatCommand =
  | { type: "side-chat.open"; chatId: string }
  | { type: "side-chat.close"; chatId: string }
  | { type: "side-chat.set-prompt"; chatId: string; prompt: string }
  | { type: "side-chat.send"; chatId: string }
  | { type: "side-chat.cancel"; chatId: string };

export type AutomationCommand =
  | { type: "automation.save"; taskId?: string; draft: Omit<AutomationDraft, "taskId"> }
  | { type: "automation.update"; taskId?: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId?: string }
  | { type: "automation.run-now"; taskId?: string };

/** Presentation state. Nothing here reaches the agent process; only `view.set-session-panel-open` outlives the window. */
export type ViewCommand =
  | { type: "view.set-prompt"; prompt: string }
  | { type: "view.toggle-project"; projectId: string }
  | { type: "view.set-projects-open"; open: boolean }
  | { type: "view.set-recents-open"; open: boolean }
  | { type: "view.set-session-panel-open"; open: boolean }
  | { type: "view.set-menu"; menu: string | null }
  | { type: "view.set-focused"; focused: boolean }
  | { type: "view.dismiss-computer-use-setup" }
  | { type: "view.refresh-environment" };
