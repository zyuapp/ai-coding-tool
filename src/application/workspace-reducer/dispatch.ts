import { reduceTasks } from "./tasks.js";
import { reduceWorktrees } from "./worktrees.js";
import { reduceSending } from "./sending.js";
import { reduceProjectCommands } from "./projects.js";
import { reduceRuns } from "./runs.js";
import { reduceAutomations } from "./automations.js";
import { reduceSideChats } from "./side-chats.js";
import { reduceDiffs } from "./diffs.js";
import { reduceStore } from "./store.js";
import { reduceComposer } from "./composer.js";
import { reduceSettings } from "./settings.js";
import { reduceDock } from "./dock.js";
import { reduceBrowser } from "./browser.js";
import { reduceDesktop } from "./desktop.js";
import { reduceView } from "./view.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { isRemoteInput, reduceRemote } from "../remote-commands.js";
import { isEngineInput, reduceEngine } from "../engine-access.js";
import type { WorkspaceState } from "../workspace-state.js";

/** Every input {@link reduce} has not already unpacked into the several inputs it stands for. */
export function apply(state: WorkspaceState, input: Exclude<WorkspaceInput, { type: "view.shortcut" | "view.escape" | "agent.events" }>): WorkspaceTransition {
  if (isRemoteInput(input)) return reduceRemote(state, input);
  if (isEngineInput(input)) return reduceEngine(state, input);
  switch (input.type) {
    case "task.new": case "task.select": case "task.dismiss":
    case "task.dismiss-all": case "task.archive": case "task.restore":
    case "task.clear-archive": case "task.rename": case "title.suggested":
    case "task.fork": case "task.move": case "task.set-policy":
    case "task.set-model": case "task.set-effort":
      return reduceTasks(state, input);

    case "view.move-worktree": case "task.set-worktree": case "task.set-branch": case "task.checkout-branch":
    case "worktree.refresh": case "worktree.reveal": case "worktree.delete":
    case "worktree.created": case "worktree.failed": case "worktrees.loaded":
    case "worktrees.failed": case "worktree.released": case "worktree.release-failed": case "worktree.deleted":
      return reduceWorktrees(state, input);

    case "task.send": case "task.steer-queued": case "task.drop-queued":
      return reduceSending(state, input);

    case "project.open": case "project.opened": case "project.edit":
    case "project.registered": case "project.register-failed": case "project.move":
    case "view.edit-project": case "view.toggle-project": case "project.remove":
      return reduceProjectCommands(state, input);

    case "run.resolved": case "run.unresolved": case "run.cancel": case "run.compact":
    case "run.stop-process": case "run.decide": case "run.event":
    case "thread.event": case "review.open": case "review.close":
    case "review.set-step": case "review.start":
      return reduceRuns(state, input);

    case "automation.fired": case "automation.notify": case "automation.nothing-to-report":
    case "automation.save": case "automation.update": case "automation.delete":
    case "automation.run-now": case "automations.changed":
      return reduceAutomations(state, input);

    case "side-chat.open": case "side-chat.close":
      return reduceSideChats(state, input);

    case "view.refresh-environment": case "diff.toggle": case "diff.refresh":
    case "diff.set-range": case "diff.set-collapsed": case "diff.set-viewed":
    case "diff.set-split": case "diff.set-ignore-whitespace": case "diff.loaded": case "environment.updated":
      return reduceDiffs(state, input);

    case "store.loaded": case "store.absent": case "preferences.loaded":
    case "store.failed": case "action.failed":
      return reduceStore(state, input);

    case "annotation.add": case "annotation.note": case "annotation.remove":
    case "annotation.recall": case "paste.add": case "paste.remove":
    case "paste.recall": case "image.add": case "image.remove":
    case "image.recall": case "file.attach": case "file.detach":
    case "file.recall": case "view.set-prompt": case "view.reading-point":
    case "view.dismiss-action-error":
      return reduceComposer(state, input);

    case "view.set-theme": case "view.set-theme-family": case "view.set-theme-mode":
    case "view.system-scheme": case "view.set-ui-font": case "view.set-mono-font":
    case "view.set-reading-size": case "view.set-terminal-size": case "view.set-sidebar-mode":
    case "view.set-sidebar-open": case "view.focus-composer": case "view.set-shortcut":
    case "view.reset-shortcuts": case "view.capture-shortcut": case "shortcut.captured":
    case "view.inspect-subagent": case "subagent.activity.loaded": case "view.set-capture-options":
    case "view.set-chrome-browser": case "view.set-computer-use":
    case "view.set-browser-tools": case "view.set-notifications": case "view.set-session-panel-open":
    case "view.set-settings-open": case "view.set-subagent-group":
    case "view.set-section-open":
      return reduceSettings(state, input);

    case "view.close-tab": case "view.new-tab": case "view.select-dock-index":
    case "view.set-dock-open": case "view.set-dock-expanded": case "view.open-dock-panel":
    case "view.open-workflow": case "view.close-dock-panel": case "view.select-dock-tab":
      return reduceDock(state, input);

    case "browser.open": case "browser.new-tab": case "browser.decide":
    case "browser.select-tab": case "browser.close-tab": case "browser.go":
    case "browser.reload": case "browser.act": case "browser.clear-data":
    case "browser.updated":
      return reduceBrowser(state, input);

    case "file.open": case "app.open-folder": case "terminal.open":
    case "terminal.select": case "terminal.close": case "terminal.input":
    case "terminal.resize": case "terminal.updated":
      return reduceDesktop(state, input);

    case "view.set-menu": case "view.go-back": case "view.go-forward":
    case "view.set-focused": case "view.find-open": case "view.find-query":
    case "view.find-step": case "view.find-close": case "find.results":
    case "view.dock-keys": case "view.jump-open": case "view.jump-query":
    case "view.jump-step": case "view.jump-choose": case "view.jump-choose-setting":
    case "view.jump-close":
    case "view.dismiss-computer-use-setup":
      return reduceView(state, input);
  }
}
