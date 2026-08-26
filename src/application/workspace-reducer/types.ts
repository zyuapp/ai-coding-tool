import type { ProjectEvent, RegisterProjectEffect } from "../project-commands.js";
import type { RemoteEffect, RemoteEvent } from "../remote-commands.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { AppCommand } from "../../contracts/commands.js";
import type { ApprovalDecisionCommand, AutomationAck, AutomationFire, BrowserPageEvent, CancelRunCommand, ChangedFilesResult, CreatedWorktree, DiffSummaryResult, RunEvent, StartRunCommand, SteerRunCommand, StopProcessCommand, ThreadEvent, ThreadNotice, WorktreeSnapshotResult } from "../../contracts/ipc.js";
import type { ViewPreferences } from "../../contracts/preferences.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation.js";
import type { BrowserAction } from "../../domain/browser.js";
import type { CaptureOptions } from "../../domain/capture.js";
import type { DiffRange } from "../../domain/diff.js";
import type { FindResults, FindTarget } from "../../domain/find.js";
import type { SubagentActivity } from "../../domain/run.js";
import type { ShortcutOverrides } from "../../domain/shortcuts.js";
import type { TaskStoreData } from "../../domain/task.js";
import type { TerminalUpdate } from "../../domain/terminal.js";
import type { WorkspaceRecord } from "../../domain/workspace.js";
import type { ManagedWorktree } from "../../domain/worktree.js";

/** Things that happened: replies to effects, and pushes from the main process. */
export type WorkspaceEvent =
  | { type: "store.loaded"; data: TaskStoreData }
  /** The store has nothing to hand over: a first run, with no threads to restore. */
  | { type: "store.absent" }
  | { type: "preferences.loaded"; preferences: ViewPreferences }
  | { type: "store.failed"; message: string }
  | { type: "action.failed"; message: string }
  | ProjectEvent
  | { type: "run.event"; event: RunEvent }
  /** Work that reports to its thread rather than to a run, which may be long over by then. */
  | { type: "thread.event"; event: ThreadEvent }
  | { type: "run.resolved"; pendingId: string; workspace: WorkspaceRecord; worktree?: CreatedWorktree }
  | { type: "run.unresolved"; pendingId: string; message: string }
  | { type: "automation.fired"; fire: AutomationFire }
  | { type: "automations.changed"; automations: AutomationView[] }
  | { type: "title.suggested"; taskId: string; title: string }
  | { type: "worktree.created"; taskId: string; worktree: CreatedWorktree }
  | { type: "worktree.failed"; taskId: string; message: string }
  | { type: "worktrees.loaded"; worktrees: ManagedWorktree[] }
  | { type: "worktrees.failed"; message: string; root?: string }
  | { type: "worktree.released"; taskId: string; snapshot: WorktreeSnapshotResult }
  | { type: "worktree.deleted"; worktreeId: string; root: string; snapshot: WorktreeSnapshotResult }
  | { type: "environment.updated"; workspaceId: string; taskId?: string; runId?: string; result: ChangedFilesResult }
  /** A comparison's file list, named by the dock that asked so a slow read cannot land in another. */
  | { type: "diff.loaded"; owner: string; workspaceId: string; range: DiffRange; result: DiffSummaryResult }
  /** What a page in the browser panel did. Main watches the page; the reducer keeps the record. */
  | { type: "browser.updated"; page: BrowserPageEvent }
  /** What a shell did. Its output is not here: that goes straight to the view and never becomes state. */
  | { type: "terminal.updated"; update: TerminalUpdate }
  | { type: "subagent.activity.loaded"; taskId: string; subagentId: string; activity: SubagentActivity[] }
  /** The keystroke settings were waiting for, or null when the user pressed Escape instead. */
  | { type: "shortcut.captured"; binding: string | null }
  /** What a page or a shell found, counted by whoever holds the text. `index` counts from zero. */
  | { type: "find.results"; target: FindTarget; results: FindResults }
  /** What the main process says the phone bridge now is, after anything at all moved it. */
  | RemoteEvent;

/** Work the reducer wants done outside itself. The renderer performs these; nothing else does. */
export type WorkspaceEffect =
  | { type: "pick-project" }
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
  | { type: "create-worktree"; taskId: string; projectRoot: string }
  | { type: "release-worktree"; taskId: string; worktreeId: string; root: string; title: string }
  | { type: "list-worktrees" }
  | { type: "reveal-worktree"; root: string }
  | { type: "delete-worktree"; worktreeId: string; root: string; title: string }
  | { type: "start-run"; command: StartRunCommand }
  | { type: "send-run-command"; command: CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand | StopProcessCommand }
  | { type: "refresh-environment"; workspaceId: string; taskId?: string; runId?: string }
  | { type: "read-diff"; owner: string; workspaceId: string; range: DiffRange; ignoreWhitespace: boolean }
  /** Moves a checkout onto a branch, making it at that checkout's HEAD first when `create`. */
  | { type: "checkout-branch"; workspaceId: string; branch: string; create?: boolean }
  | { type: "suggest-title"; taskId: string; text: string; attachments: string[] }
  | { type: "load-subagent-activity"; taskId: string; subagentId: string }
  | { type: "automation.save"; draft: AutomationDraft }
  | { type: "automation.update"; taskId: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId: string }
  | { type: "automation.run-now"; taskId: string }
  | { type: "automation.ack"; ack: AutomationAck }
  /** The browser panel's pages. `open` is idempotent: a tab that already has a view keeps it. */
  | { type: "browser.open"; tabId: string; url?: string }
  | { type: "browser.navigate"; tabId: string; url: string }
  | { type: "browser.history"; tabId: string; delta: -1 | 1 }
  | { type: "browser.reload"; tabId: string }
  | { type: "browser.act"; tabId: string; action: BrowserAction }
  | { type: "browser.close"; tabId: string }
  /** Which tab the panel shows. Where it shows is the panel's own to report. */
  | { type: "browser.show"; tabId: string | null }
  | { type: "browser.clear-data" }
  /** A file the desktop opens for the reader. `roots` are the checkouts to look for it in, nearest first. */
  | { type: "file.open"; roots: string[]; path: string; line: number | null }
  /** The thread's checkout, opened in another application on the machine. */
  | { type: "app.open-folder"; root: string; appId: string }
  /** The terminal panel's shells. `start` is idempotent: a terminal that already runs keeps its process. */
  | { type: "terminal.start"; terminalId: string; cwd: string }
  | { type: "terminal.write"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  /** Nothing was left in front of the window, so ⌘W means what it always means. */
  | { type: "close-window" }
  /** The keystrokes the window matches. Only main sees the ones a page in the panel swallows. */
  | { type: "apply-shortcuts"; overrides: ShortcutOverrides }
  | { type: "apply-capture-options"; options: CaptureOptions }
  /** While settings wait for a keystroke, main hands every one of them over instead of acting. */
  | { type: "capture-shortcut"; capturing: boolean }
  /**
   * Find, in the things that hold their own text. The transcript needs no effect: the timeline reads
   * the match out of state and reveals it, folds and virtual rows and all.
   */
  | { type: "find-in-page"; tabId: string; query: string; forward: boolean; findNext: boolean }
  | { type: "stop-find-in-page"; tabId: string }
  | { type: "focus-browser"; tabId: string }
  | { type: "find-in-terminal"; terminalId: string; query: string; forward: boolean }
  | { type: "stop-find-in-terminal"; terminalId: string }
  /** Takes the keyboard off a page in the panel, which is the only way the find bar can have it. */
  | { type: "focus-window" }
  /** A finding on its way to the desktop, which is the only place a user who is elsewhere can be reached. */
  | { type: "announce-thread"; notice: ThreadNotice }
  /** A change to the phone bridge, which only the main process can actually make. */
  | RemoteEffect;

export type WorkspaceInput = AppCommand | WorkspaceEvent;

export type WorkspaceTransition = { state: WorkspaceState; effects: WorkspaceEffect[] };
