import type { ProjectEvent, RegisterProjectEffect } from "../project-commands.js";
import type { RemoteEffect, RemoteEvent } from "../remote-commands.js";
import type { ComputerEffect, ComputerEvent } from "../computer-commands.js";
import type { EngineEffect, EngineEvent } from "../engine-access.js";
import type { AppUpdateEffect, AppUpdateEvent } from "../app-updates.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { AppCommand } from "../../contracts/commands.js";
import type { WorkspaceCommandResult } from "../../contracts/workspace-result.js";
import type { ActionFailedEvent, FindResultsEvent, ShortcutEvent } from "../../contracts/workspace-view-input.js";
import type { AgentEvent, AnswerQuestionCommand, ApprovalDecisionCommand, ArchiveThreadCommand, CancelRunCommand, CreatedWorktree, LabelThreadCommand, RunEvent, StartRunCommand, SteerRunCommand, StopProcessCommand, ThreadEvent, ThreadNotice, ThreadRoleCommand } from "../../contracts/ipc.js";
import type { ViewPreferences } from "../../contracts/preferences.js";
import type { AgentEngine, AgentModel } from "../../domain/agent-engine.js";
import type { ConversationMessage } from "../../domain/conversation.js";
import type { SubagentActivity } from "../../domain/run.js";
import type { ThreadStoreData } from "../../domain/thread-storage.js";
import type { WorkspaceRecord } from "../../domain/workspace.js";
import type { CoordinationState, DecisionRequest, MemoryChange, ThreadProposal } from "../../domain/coordination.js";
import type { AttachmentEffect, AttachmentEvent } from "./composer-attachments.js";
import type { AutomationEffect, AutomationEvent } from "./automations.js";
import type { BrowserEffect, BrowserEvent } from "./browser.js";
import type { BrowserImportEffect, BrowserImportEvent } from "./browser-import.js";
import type { CliEffect, CliEvent } from "./cli.js";
import type { ComputerUseEffect, ComputerUseEvent } from "./computer-use.js";
import type { DesktopEffect, DesktopEvent } from "./desktop.js";
import type { DictationEffect, DictationEvent } from "./dictation.js";
import type { DiffEffect, DiffEvent } from "./diffs.js";
import type { FindEffect } from "./find.js";
import type { PlanUsageEffect, PlanUsageEvent } from "./plan-usage.js";
import type { PullRequestEffect, PullRequestEvent } from "./pull-requests.js";
import type { ShortcutEffect } from "./settings.js";
import type { SimulatorEffect, SimulatorEvent } from "./simulator.js";
import type { TerminalEffect, TerminalEvent } from "./terminal.js";
import type { WorktreeEffect, WorktreeEvent } from "./worktrees.js";

/** Things that happened: replies to effects, and pushes from the main process. */
export type WorkspaceEvent =
  | { type: "snoozes.elapsed"; at: number }
  /** A usage limit some paused thread is waiting on has lifted. */
  | { type: "limits.elapsed"; at: number }
  | { type: "view.closed" }
  /** Another thread waited on this one and was handed its settled turn, so its verdict has been delivered. */
  | { type: "task.result-collected"; taskId: string }
  /** `resuming` names the threads whose turn an update's restart cut off, to carry on. */
  | { type: "store.loaded"; data: ThreadStoreData; hiddenTasks?: number; resuming?: string[] }
  | { type: "store.thread-loaded"; taskId: string; messages: ConversationMessage[] }
  /** The store has nothing to hand over: a first run, with no threads to restore. */
  | { type: "store.absent" }
  | { type: "store.persisted" }
  | { type: "preferences.loaded"; preferences: ViewPreferences }
  | { type: "store.failed"; message: string }
  | ActionFailedEvent
  | import("../project-add.js").ProjectAddEvent
  | ProjectEvent
  | { type: "run.event"; event: RunEvent }
  /** Work that reports to its thread rather than to a run, which may be long over by then. */
  | { type: "thread.event"; event: ThreadEvent }
  /**
   * A frame's worth of the two above, folded in the order they arrived. A run reporting on every tool
   * call would otherwise rewrite the window between each one, redrawing views the reports never touch.
   */
  | { type: "agent.events"; events: AgentEvent[] }
  | { type: "run.resolved"; pendingId: string; workspace: WorkspaceRecord; worktree?: CreatedWorktree }
  | { type: "run.unresolved"; pendingId: string; message: string }
  | { type: "title.suggested"; taskId: string; title: string }
  /** A thread under a coordinator saying where its work stands. */
  | { type: "coordination.reported"; taskId: string; state: CoordinationState; summary: string }
  /** A thread putting a choice to the user that only they can make. `decisionId` names it, so whoever raised it can find it after. */
  | { type: "coordination.decision-raised"; taskId: string; request: DecisionRequest; decisionId?: string }
  /** A coordinator changing its own memory, which its session then knows without reading it again. */
  | { type: "coordination.remembered"; taskId: string; change: MemoryChange }
  /** A coordinator suggesting threads for the user to start, each already checked as a start of it would be. */
  | { type: "coordination.proposed"; taskId: string; proposals: ThreadProposal[] }
  /**
   * A paired computer took, or refused, a thread the user allowed it to run under a coordinator here,
   * or its answer was lost. `refused` is that computer saying it started nothing.
   */
  | { type: "proposal.settled"; taskId: string; proposalId: string; threadId?: string; message?: string; refused?: true }
  | { type: "subagent.activity.loaded"; taskId: string; subagentId: string; activity: SubagentActivity[] }
  /** What the main process says the phone bridge now is, after anything at all moved it. */
  | RemoteEvent
  | ComputerEvent
  | EngineEvent
  | AutomationEvent
  | WorktreeEvent
  | DiffEvent
  | PullRequestEvent
  | BrowserEvent
  | BrowserImportEvent
  | FindResultsEvent
  | SimulatorEvent
  | DictationEvent
  | TerminalEvent
  | AttachmentEvent
  | DesktopEvent
  | AppUpdateEvent
  | ComputerUseEvent
  | PlanUsageEvent
  | CliEvent
  | ShortcutEvent;

/** Work the reducer wants done outside itself. The renderer performs these; nothing else does. */
export type WorkspaceEffect = WorkspaceWork & {
  /**
   * Keeps a view current after the input's own work. The input completes without waiting for it or
   * taking on its result; the host still tracks it, and what it finds still lands through events.
   */
  followUp?: true;
};

type WorkspaceWork =
  | { type: "schedule-snooze-expiry"; at: number | null }
  | { type: "schedule-limit-reset"; at: number | null }
  /** Takes a toast down at `at`, unless the user closes it first. Null keeps it up, for a toast that now waits for the user. */
  | { type: "schedule-toast-dismissal"; id: number; at: number | null }
  | { type: "pick-project" }
  | import("../project-add.js").ProjectAddEffect
  | RegisterProjectEffect
  | { type: "persist-preferences"; preferences: ViewPreferences }
  | {
      type: "resolve-run-workspace";
      pendingId: string;
      picker: boolean;
      /** Where the run happens, when the reducer already knows. Carried whole so nothing downstream infers its kind. */
      workspace?: WorkspaceRecord;
      /** The project folder a picker has to match. */
      root?: string;
      createWorktree?: { projectRoot: string; carryChanges: boolean; branch?: string };
      /** Makes the branch the thread starts from, at the project's own HEAD, before anything reads it. */
      createBranch?: { workspaceId: string; branch: string };
      /** Moves the project checkout onto a branch first, for a thread that is not getting its own. */
      checkout?: { workspaceId: string; branch: string };
    }
  | { type: "start-run"; command: StartRunCommand }
  | { type: "send-run-command"; command: { type: "memory-protection"; enabled: boolean } | CancelRunCommand | AnswerQuestionCommand | ApprovalDecisionCommand | SteerRunCommand | StopProcessCommand | LabelThreadCommand | ArchiveThreadCommand | ThreadRoleCommand }
  | { type: "suggest-title"; taskId: string; engine: AgentEngine; model: AgentModel; text: string; attachments: string[] }
  | { type: "preserve-message-images"; text: string; root: string; messageId: string }
  | { type: "load-subagent-activity"; taskId: string; subagentId: string }
  | { type: "load-subagent-metadata"; taskId: string; subagentId: string; engine: AgentEngine; sessionId?: string }
  /** Nothing was left in front of the window, so ⌘W means what it always means. */
  | { type: "close-window" }
  /** Takes the keyboard off a page in the panel, which is the only way the find bar can have it. */
  | { type: "focus-window" }
  /** A finding on its way to the desktop, which is the only place a user who is elsewhere can be reached. */
  | { type: "announce-thread"; notice: ThreadNotice }
  /** A change to the phone bridge, which only the main process can actually make. */
  | RemoteEffect
  | ComputerEffect
  | EngineEffect
  | AutomationEffect
  | WorktreeEffect
  | DiffEffect
  | PullRequestEffect
  | BrowserEffect
  | BrowserImportEffect
  | FindEffect
  | SimulatorEffect
  | DictationEffect
  | TerminalEffect
  | AttachmentEffect
  | DesktopEffect
  | AppUpdateEffect
  | ComputerUseEffect
  | PlanUsageEffect
  | CliEffect
  | ShortcutEffect;

export type WorkspaceInput = AppCommand | WorkspaceEvent;

export type WorkspaceTransition = {
  state: WorkspaceState;
  effects: WorkspaceEffect[];
  result?: WorkspaceCommandResult;
};
