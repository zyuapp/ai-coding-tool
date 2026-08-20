import type { AutomationDraft, AutomationPatch } from "../domain/automation.js";
import type { ShortcutSurface } from "../domain/shortcuts.js";
import type { BrowserAction } from "../domain/browser.js";
import type { FindTarget } from "../domain/find.js";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../domain/run.js";
import type { RunAttachment, TaskDropTarget } from "../domain/task.js";

/**
 * Every interaction the application supports, named as data. The UI dispatches these instead of
 * mutating state, so any other caller — a tool, a script, a test — can drive the same behaviour
 * through the same door. Anything that reaches {@link AppCommand} from outside the window has to be
 * validated at that boundary first, the way `isRunCommand` guards the run channel.
 */
export type AppCommand = TaskCommand | ProjectCommand | RunControlCommand | WorktreeCommand | SideChatCommand | AutomationCommand | BrowserCommand | TerminalCommand | ViewCommand;

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
   * Asks the thread to run in its own checkout, or to come back to the project. The worktree is
   * only made on the next send; switching back commits whatever the worktree still holds.
   */
  | { type: "task.set-worktree"; taskId?: string; worktree: boolean }
  /** The branch a thread starts from. Only a thread that does not exist yet can be told. */
  | { type: "task.set-branch"; branch: string | null; create?: boolean }
  /**
   * Moves the checkout the thread works in — its worktree, or the project's — onto `branch`,
   * making it at the checkout's own HEAD first when `create`. Never forced, so uncommitted work
   * that the switch would overwrite stops it.
   */
  | { type: "task.checkout-branch"; taskId?: string; branch: string; create?: boolean }
  /**
   * While a run is going the message is queued instead; `steer` pushes it into that run straight away.
   * `text` sends that message instead of the composer draft and leaves the draft alone: only the
   * composer's own send falls back to the current task, so a send carrying `text` and no `taskId`
   * always starts a new task, in `projectId`. `worktree` starts that new task in its own checkout.
   */
  | { type: "task.send"; taskId?: string; projectId?: string; text?: string; attachments?: RunAttachment[]; steer?: boolean; worktree?: boolean }
  /** Moves to the thread `delta` away in the sidebar, which is where the keyboard walks the list. */
  | { type: "task.step"; delta: -1 | 1 }
  | { type: "task.steer-queued"; taskId?: string; messageId: string }
  | { type: "task.drop-queued"; taskId?: string; messageId: string };

export type ProjectCommand =
  | { type: "project.open" }
  | { type: "project.remove"; projectId: string };

/** Discarding a worktree takes everything uncommitted in it; only {@link TaskCommand} preserves work. */
export type WorktreeCommand =
  | { type: "worktree.delete"; taskId?: string };

export type RunControlCommand =
  | { type: "run.cancel"; taskId?: string }
  | { type: "run.decide"; allow: boolean; taskId?: string }
  /** Kills one process the run left running, without ending the run. */
  | { type: "run.stop-process"; taskId?: string; processId: string };

/**
 * A side chat forks the current thread and is discarded when it closes. Its thread is an ordinary
 * task, so everything else it does — sending, queueing, steering, cancelling, changing its model —
 * travels on the task commands above with the chat id as the `taskId`.
 */
export type SideChatCommand =
  | { type: "side-chat.open"; chatId: string }
  | { type: "side-chat.close"; chatId: string };

export type AutomationCommand =
  | { type: "automation.save"; taskId?: string; draft: Omit<AutomationDraft, "taskId"> }
  | { type: "automation.update"; taskId?: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId?: string }
  | { type: "automation.run-now"; taskId?: string };

/**
 * The browser panel, which holds one session for the whole app rather than one per project or thread.
 * A command carrying a `taskId` is a run asking; the user's own commands carry none, and visiting a
 * site is the consent that lets a run reach that origin afterwards.
 */
export type BrowserCommand =
  | { type: "browser.open"; taskId?: string; url: string; tabId?: string; newTab?: boolean }
  /** An empty tab, waiting for an address. Only the user opens one; a run always names a page. */
  | { type: "browser.new-tab" }
  | { type: "browser.close-tab"; taskId?: string; tabId: string }
  | { type: "browser.select-tab"; taskId?: string; tabId: string }
  | { type: "browser.go"; taskId?: string; tabId?: string; delta: -1 | 1 }
  | { type: "browser.reload"; taskId?: string; tabId?: string }
  | { type: "browser.act"; taskId?: string; tabId?: string; action: BrowserAction }
  /** Answers the navigation a run is waiting on. Allowing it also allows that origin from now on. */
  | { type: "browser.decide"; allow: boolean }
  /** Signs the whole app out: cookies, storage, and caches for every site. */
  | { type: "browser.clear-data" };

/**
 * The terminal panel. Every command here is the user's own: a run may read what a shell has printed
 * but never drives one, so none of these appear in `ExternalCommand`.
 */
export type TerminalCommand =
  /** A shell in the current thread's checkout, or in `cwd` when one is named. */
  | { type: "terminal.open"; cwd?: string }
  | { type: "terminal.select"; terminalId: string }
  | { type: "terminal.close"; terminalId: string }
  /** Keystrokes on their way to the shell, and the size it believes it has. Neither changes state. */
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  /** Which shell has the keyboard, with a null when it lost them. Only find reads it. */
  | { type: "terminal.focus"; terminalId: string | null };

/** Presentation state. Nothing here reaches the agent process; only `view.set-session-panel-open` outlives the window. */
export type ViewCommand =
  | { type: "view.set-prompt"; taskId?: string; prompt: string }
  | { type: "view.toggle-project"; projectId: string }
  | { type: "view.set-projects-open"; open: boolean }
  | { type: "view.set-recents-open"; open: boolean }
  | { type: "view.set-sidebar-open"; open: boolean }
  | { type: "view.set-session-panel-open"; open: boolean }
  /** Opening a subagent's detail, which is when its activity is read out of the store. */
  | { type: "view.inspect-subagent"; taskId?: string; subagentId: string }
  | { type: "view.set-settings-open"; open: boolean }
  /**
   * Closes whatever is in front, the way ⌘W does everywhere else on the desktop: settings, then the
   * page the browser panel is showing, then the dock tab, then the dock. Only with nothing left in
   * front of it does the window itself go.
   */
  | { type: "view.close-tab" }
  /**
   * ⌘W's inverse: another page while the panel shows one, another shell while it shows one, and a
   * shell when it shows neither.
   */
  | { type: "view.new-tab" }
  /** The right dock: which panels are open as tabs, and which of them is showing. */
  | { type: "view.set-dock-open"; open: boolean }
  | { type: "view.open-dock-panel"; panel: string }
  | { type: "view.close-dock-panel"; panel: string }
  | { type: "view.select-dock-tab"; tab: string }
  /** The tab in that position, counting from zero, with -1 for the last one. */
  | { type: "view.select-dock-index"; index: number }
  | { type: "view.set-menu"; menu: string | null }
  /** Moves the visit cursor without recording a visit, so the trail behind and ahead survives. */
  | { type: "view.go-back" }
  | { type: "view.go-forward" }
  | { type: "view.set-focused"; focused: boolean }
  /** Puts the caret in the composer. Components watch the token rather than being told to focus. */
  | { type: "view.focus-composer" }
  /**
   * What a keystroke asked for. The action is routed here rather than in the window, because only
   * state knows whether ⌘[ means the thread you came from or the page before this one.
   */
  | { type: "view.shortcut"; action: string; surface: ShortcutSurface }
  /** Binds an action, or unbinds it with a null. Whoever else held the keystroke loses it. */
  | { type: "view.set-shortcut"; action: string; binding: string | null }
  | { type: "view.reset-shortcuts" }
  /** Waits for the next keystroke to bind to `action`, or stops waiting with a null. */
  | { type: "view.capture-shortcut"; action: string | null }
  | { type: "view.dismiss-computer-use-setup" }
  | { type: "view.refresh-environment" }
  /**
   * Find. What is searched is whatever the keyboard is on: the page while one has the keys, else the
   * shell holding them, else the transcript. `target` names it outright for a caller that already knows.
   */
  | { type: "view.find-open"; target?: FindTarget }
  | { type: "view.find-query"; query: string }
  /** The match after this one, or the one before it, wrapping at both ends. */
  | { type: "view.find-step"; delta: -1 | 1 }
  | { type: "view.find-close" };
