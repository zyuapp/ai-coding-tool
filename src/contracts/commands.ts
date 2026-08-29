import type { AutomationDraft, AutomationPatch } from "../domain/automation.js";
import type { ShortcutSurface } from "../domain/shortcuts.js";
import type { BrowserAction } from "../domain/browser.js";
import type { CaptureOptions } from "../domain/capture.js";
import type { DiffRange } from "../domain/diff.js";
import type { FindTarget } from "../domain/find.js";
import type { SettingsSection } from "../domain/settings-section.js";
import type { SidebarMode, SidebarSection } from "../domain/sidebar.js";
import type { ThemeMode } from "../domain/theme.js";
import type { AgentEngine, AgentModel } from "../domain/agent-engine.js";
import type { AgentEffort, ExecutionPolicy, SubagentGroup } from "../domain/run.js";
import type { Annotation, AnnotationAnchor, AttachedFile, AttachedFileDraft, PastedText, RunAttachment, TaskDropTarget } from "../domain/task.js";
import type { ReviewTarget } from "../domain/review.js";

/**
 * Where a thread was left reading: the message held at the top of the view and how far into it the
 * view sat, or null for its foot. A session's memory only, so it is never persisted.
 */
export type ReadingPoint = { anchor: string; depth: number } | null;

/**
 * Every interaction the application supports, named as data. The UI dispatches these instead of
 * mutating state, so any other caller — a tool, a script, a test — can drive the same behaviour
 * through the same door. Anything that reaches {@link AppCommand} from outside the window has to be
 * validated at that boundary first, the way `isRunCommand` guards the run channel.
 */
export type AppCommand = TaskCommand | AnnotationCommand | PasteCommand | ImageCommand | ProjectCommand | RunControlCommand | ReviewCommand | WorktreeCommand | SideChatCommand | AutomationCommand | BrowserCommand | DiffCommand | FileCommand | ExternalAppCommand | TerminalCommand | RemoteCommand | EngineCommand | ViewCommand;

/** The diff panel. Which comparison it shows, which file is open, and which files are ticked off. */
export type DiffCommand =
  /** Opens the panel, or closes it when it is already the tab in front. */
  | { type: "diff.toggle" }
  | { type: "diff.refresh" }
  | { type: "diff.set-range"; range: DiffRange }
  /** Folds one file shut, or opens it again. Every file starts open. */
  | { type: "diff.set-collapsed"; path: string; collapsed: boolean }
  | { type: "diff.set-viewed"; path: string; viewed: boolean }
  | { type: "diff.set-split"; split: boolean }
  /** Reads the comparison again, leaving out the lines that only changed their spacing. */
  | { type: "diff.set-ignore-whitespace"; ignore: boolean };

/** Commands that carry no `taskId` act on the task the user is looking at, read from `currentId`. */
export type TaskCommand =
  /** `worktreeId` starts the thread in a checkout the project already has, rather than in the project. */
  | { type: "task.new"; projectId?: string; worktreeId?: string }
  | { type: "task.select"; taskId: string }
  | { type: "task.archive"; taskId: string }
  | { type: "task.restore"; taskId: string }
  | { type: "task.clear-archive" }
  | { type: "task.rename"; taskId: string; title: string }
  /** Takes the dot off a thread, which is the only thing that does. Opening the thread only dims it. */
  | { type: "task.dismiss"; taskId: string }
  /** The same for every dotted thread the user has already looked at, leaving the unseen ones alone. */
  | { type: "task.dismiss-all" }
  | { type: "task.move"; taskId: string; target: TaskDropTarget }
  /**
   * Copies a thread into a new one beside it, carrying its conversation and its session. The copy
   * runs nothing of its own until the user sends something; `worktree` gives it a checkout of its own.
   */
  | { type: "task.fork"; taskId?: string; worktree?: boolean }
  /** Without a `taskId` the setting also becomes the draft the next new task starts from. */
  | { type: "task.set-policy"; taskId?: string; policy: ExecutionPolicy }
  /** A thread keeps its engine; the pair only moves the draft, and a model or effort the engine lacks changes nothing. */
  | { type: "task.set-model"; taskId?: string; engine: AgentEngine; model: AgentModel }
  | { type: "task.set-effort"; taskId?: string; engine: AgentEngine; effort: AgentEffort }
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
   * always starts a new task, in `project` — its folder name, its path, or its id. `worktree` starts
   * that new task in a checkout of its own; `worktreeId` starts it in one the project already has,
   * and names the project itself, so a `project` that disagrees with it is refused. Naming one takes
   * precedence over asking for a new one. `model` and `effort` apply only to a new task and leave
   * the shared draft settings alone.
   */
  | { type: "task.send"; taskId?: string; project?: string; text?: string; attachments?: RunAttachment[]; steer?: boolean; worktree?: boolean; worktreeId?: string; model?: AgentModel; effort?: AgentEffort }
  /** Moves to the thread `delta` away in the sidebar, which is where the keyboard walks the list. */
  | { type: "task.steer-queued"; taskId?: string; messageId: string }
  | { type: "task.drop-queued"; taskId?: string; messageId: string };

/**
 * Highlights of the assistant's output waiting in a composer, kept as drafts are: per task, with the
 * chat id as the `taskId` for a side chat's composer. They ride the next send and are cleared by it.
 */
export type AnnotationCommand =
  /** Without an `anchor` the quote is a bare reference: no highlight marks it and no note is taken on it. */
  | { type: "annotation.add"; taskId?: string; quote: string; note?: string; anchor?: AnnotationAnchor }
  | { type: "annotation.note"; taskId?: string; annotationId: string; note: string }
  | { type: "annotation.remove"; taskId?: string; annotationId: string }
  | { type: "annotation.recall"; taskId?: string; annotations: Annotation[] };

/**
 * Text pasted into a composer, kept aside as a pill instead of filling the prompt. Drafted the way
 * annotations are: per task, cleared by the send that carries them.
 */
export type PasteCommand =
  | { type: "paste.add"; taskId?: string; text: string }
  | { type: "paste.remove"; taskId?: string; pasteId: string }
  | { type: "paste.recall"; taskId?: string; pastes: PastedText[] };

/**
 * An image waiting in a composer, already on disk. Drafted the way pastes are: per task, cleared by
 * the send that carries it.
 */
export type ImageCommand =
  | { type: "image.add"; taskId?: string; path: string; label: string; source?: string }
  | { type: "image.remove"; taskId?: string; imageId: string }
  /** Images offered back with a sent message, named by where the app keeps them. */
  | { type: "image.recall"; taskId?: string; paths: string[] };

export type ProjectCommand =
  | { type: "project.open" }
  /** `index` counts the folders in the sidebar with the moved one already taken out. */
  | { type: "project.move"; projectId: string; index: number }
  /**
   * Names the folder in the sidebar, points it at another directory, or both. A blank `name` takes
   * the name off, so the folder goes by its own again. A `root` that is not a folder the app can
   * open leaves everything as it was and says why.
   */
  | { type: "project.edit"; projectId: string; name?: string | null; root?: string }
  | { type: "project.remove"; projectId: string };

/** Manual worktree management. Deletion snapshots loose work before removing the directory. */
export type WorktreeCommand =
  | { type: "worktree.refresh" }
  | { type: "worktree.reveal"; root: string }
  | { type: "worktree.delete"; taskId?: string; root?: string };

export type RunControlCommand =
  | { type: "run.cancel"; taskId?: string }
  /** Compacts an idle Codex thread without adding a user message to it. */
  | { type: "run.compact"; taskId?: string }
  | { type: "run.decide"; allow: boolean; taskId?: string }
  /** Kills one process the run left running, without ending the run. */
  | { type: "run.stop-process"; taskId?: string; processId: string };

/** The native Codex review picker and the review turn it starts. */
export type ReviewCommand =
  | { type: "review.open"; taskId?: string }
  | { type: "review.close" }
  | { type: "review.set-step"; step: "targets" | "base" | "commit" | "custom" }
  | { type: "review.start"; taskId?: string; target: ReviewTarget };

/**
 * A side chat forks the current thread and is discarded when it closes. Its thread is an ordinary
 * task, so everything else it does — sending, queueing, steering, cancelling, changing its model —
 * travels on the task commands above with the chat id as the `taskId`.
 */
export type SideChatCommand =
  | { type: "side-chat.open"; chatId: string }
  | { type: "side-chat.close"; chatId: string };

export type AutomationCommand =
  /**
   * What a scheduled run found, which puts its thread in front of the user and outlives every later
   * run. A turn that is not a scheduled run raises nothing: silence is only ever earned by a schedule.
   */
  | { type: "automation.notify"; taskId: string; headline: string; detail?: string; key?: string }
  /** A scheduled run saying it looked and found nothing, which is the only thing that earns silence. */
  | { type: "automation.nothing-to-report"; taskId: string; checked: string }
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
 * A file named in a message, opened in whatever the desktop opens that kind of file with. Relative
 * paths are read against the thread's own checkout, so only files that thread can see ever open.
 */
export type FileCommand =
  | { type: "file.open"; taskId?: string; path: string; line?: number }
  /**
   * Files and folders dropped or pasted into a composer, held aside as pills. Drafted the way pastes
   * are: per task, cleared by the send that carries them.
   */
  | { type: "file.attach"; taskId?: string; files: AttachedFileDraft[] }
  | { type: "file.detach"; taskId?: string; fileId: string }
  | { type: "file.recall"; taskId?: string; files: AttachedFile[] };

/**
 * The thread's checkout, handed to another application on the machine. Only the user asks for this,
 * so it never appears in `ExternalCommand`: a run has the folder already.
 */
export type ExternalAppCommand =
  | { type: "app.open-folder"; appId: string }
  /** Asks the updater to look now, from the notice about threads a newer version wrote. */
  | { type: "app.check-for-updates" };

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
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number };

/* ── Phone bridge ─────────────────────────────────────────────────────────── */

/**
 * The desktop settings screen driving the bridge a phone reaches this Mac through. Every one of
 * these is the user's own: a phone changes threads, never the door it came in by. Not to be confused
 * with `MobileCommand` in contracts/mobile.ts, which is what a phone is allowed to send.
 */
export type RemoteCommand =
  | { type: "remote.set-enabled"; enabled: boolean }
  /** Mints the code the QR carries. Minting a second one discards the first. */
  | { type: "remote.create-pairing-code" }
  | { type: "remote.revoke-device"; deviceId: string }
  /** Asks Tailscale again whether it is installed, signed in, and what this machine is called. */
  | { type: "remote.refresh" };

/* ── End phone bridge ─────────────────────────────────────────────────────── */

/**
 * Asks which engines can take a run, or signs the user in to one that asked for it. Either way the
 * engines' status comes back as the answer.
 */
export type EngineCommand =
  /** `refresh` throws away what the app was told before, for a user who just installed or upgraded one. */
  | { type: "engine.read"; refresh?: boolean }
  | { type: "engine.sign-in"; engine: AgentEngine };

/** Presentation state. Nothing here reaches the agent process; only `view.set-session-panel-open` outlives the window. */
export type ViewCommand =
  | { type: "view.set-prompt"; taskId?: string; prompt: string }
  /**
   * Where a thread was left reading: the message held at the top of its view and how far into it,
   * or null for its foot. Reported by the transcript as its reader settles, and put back when the
   * thread is opened again.
   */
  | { type: "view.reading-point"; taskId: string; point: ReadingPoint }
  | { type: "view.dismiss-action-error" }
  /** Closes the notice about threads this build cannot read. It returns on the next launch. */
  | { type: "view.dismiss-hidden-tasks" }
  | { type: "view.toggle-project"; projectId: string }
  /** Opens the folder editor on one project, or closes whichever it was on with a null. */
  | { type: "view.edit-project"; projectId: string | null }
  /**
   * Asks the current thread to move, which opens the confirmation. A null closes it. The move only
   * happens when `task.set-worktree` follows, which the confirmation sends.
   */
  | { type: "view.move-worktree"; worktree: boolean | null }
  /** Folds one of the sidebar's lists, whichever mode draws it. */
  | { type: "view.set-section-open"; section: SidebarSection; open: boolean }
  /** Folds the sidebar's subagent list, or one status heading in the Subagents panel. */
  | { type: "view.set-subagent-group"; group: SubagentGroup; open: boolean }
  /** The theme the window paints in. An id the app does not ship is ignored. */
  | { type: "view.set-theme"; theme: string }
  /** The family to paint, on whichever ground the mode in effect asks for. */
  | { type: "view.set-theme-family"; family: string; systemDark: boolean }
  /** The ground to paint on, which "auto" hands back to the system's own appearance. */
  | { type: "view.set-theme-mode"; mode: ThemeMode; systemDark: boolean }
  /** The system changed its appearance, which only a window set to "auto" repaints for. */
  | { type: "view.system-scheme"; dark: boolean }
  /** The families the window sets type in. An id the app neither ships nor can name is ignored. */
  | { type: "view.set-ui-font"; font: string }
  | { type: "view.set-mono-font"; font: string }
  /** The two sizes that follow the user, in px, clamped to the range each one offers. */
  | { type: "view.set-reading-size"; size: number }
  | { type: "view.set-terminal-size"; size: number }
  | { type: "view.set-sidebar-mode"; mode: SidebarMode }
  | { type: "view.set-sidebar-open"; open: boolean }
  | { type: "view.set-session-panel-open"; open: boolean }
  | { type: "view.set-capture-options"; options: CaptureOptions }
  | { type: "view.set-chrome-browser"; enabled: boolean }
  | { type: "view.set-computer-use"; enabled: boolean }
  | { type: "view.set-browser-tools"; enabled: boolean }
  | { type: "view.set-notifications"; enabled: boolean }
  /** Opening a subagent's detail, which is when its activity is read out of the store. */
  | { type: "view.inspect-subagent"; taskId?: string; subagentId: string }
  /**
   * `section` opens settings on one page; without it the sheet opens where it opens. `settingId`
   * names a control on that page for the sheet to scroll to and mark.
   */
  | { type: "view.set-settings-open"; open: boolean; section?: SettingsSection; settingId?: string }
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
  /** Whether the dock takes the whole workspace. Expanding it also shows it. */
  | { type: "view.set-dock-expanded"; expanded: boolean }
  | { type: "view.open-dock-panel"; panel: string }
  | { type: "view.close-dock-panel"; panel: string }
  /** Opens the workflow panel on one workflow. The dock remembers which, so leaving and coming back lands back on it. */
  | { type: "view.open-workflow"; workflowId: string }
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
  /** Esc. What it dismisses depends on which layer is open and which surface holds the caret. */
  | { type: "view.escape" }
  /** Binds an action, or unbinds it with a null. Whoever else held the keystroke loses it. */
  | { type: "view.set-shortcut"; action: string; binding: string | null }
  | { type: "view.reset-shortcuts" }
  /** Waits for the next keystroke to bind to `action`, or stops waiting with a null. */
  | { type: "view.capture-shortcut"; action: string | null }
  | { type: "view.dismiss-computer-use-setup" }
  | { type: "view.refresh-environment" }
  /** Which dock tab the keyboard is in, with a null when it has gone back to the thread. Only find reads it. */
  | { type: "view.dock-keys"; tab: string | null }
  /**
   * Find. What is searched is whatever the keyboard is on: the page while one has the keys, else the
   * dock view holding them, else the thread being read. `target` names it outright for a caller that
   * already knows.
   */
  | { type: "view.find-open"; target?: FindTarget }
  | { type: "view.find-query"; query: string }
  /** The match after this one, or the one before it, wrapping at both ends. */
  | { type: "view.find-step"; delta: -1 | 1 }
  | { type: "view.find-close" }
  /**
   * The jump panel: the threads and settings a name matches, and the one the user lands on. It opens
   * empty, so nothing of the last search survives being closed.
   */
  | { type: "view.jump-open" }
  | { type: "view.jump-query"; query: string }
  /** The row after this one, or the one before it, wrapping at both ends. */
  | { type: "view.jump-step"; delta: -1 | 1 }
  /** Opens the thread the row names and closes the panel. */
  | { type: "view.jump-choose"; taskId: string }
  /** Opens the settings page the row names, on the control it names, and closes the panel. */
  | { type: "view.jump-choose-setting"; section: SettingsSection; settingId?: string }
  | { type: "view.jump-close" };
