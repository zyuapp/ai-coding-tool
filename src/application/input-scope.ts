import { escapeCommands, shortcutCommands, type WorkspaceInput } from "./workspace-reducer.js";
import { findTargetFor, type WorkspaceState } from "./workspace-state.js";

/** The find bar is one bar whatever it searches, so its inputs follow each other. */
const FIND_KEY = "view:find";

export type InputScope = {
  /** The input with the thread on screen named wherever the command can name it. */
  input: WorkspaceInput;
  /** Earlier pending inputs sharing any of these run first. Thread ids, plus a key per shared view. */
  keys: Set<string>;
  /** Set when the input acts on the thread on screen without naming it: it only runs while that thread stays there. */
  screen?: string;
};

/**
 * What an input must follow before it may run, read from the state it arrived in. Selection follows
 * nothing, so it lands at once and later commands for the thread on screen name the thread it landed on.
 */
export function inputScope(state: WorkspaceState, input: WorkspaceInput): InputScope {
  const named = withNamedThread(state, input);
  const keys = new Set<string>();
  const screen = collect(state, named, keys) && state.currentId !== null;
  return screen ? { input: named, keys, screen: state.currentId! } : { input: named, keys };
}

/** Names the current thread in a command that would otherwise act on whatever thread is current when it runs. */
export function withNamedThread(state: WorkspaceState, input: WorkspaceInput): WorkspaceInput {
  const current = state.currentId;
  if (current === null || state.computers.active !== null) return input;
  switch (input.type) {
    case "view.set-prompt":
      return input.taskId === undefined ? { ...input, taskId: current } : input;
    case "task.send":
      if (input.text !== undefined) return input;
      return input.taskId === undefined && isThread(state, current) ? { ...input, taskId: current } : input;
    case "task.fork": case "task.set-worktree": case "task.move-worktree": case "run.compact": case "run.cancel":
    case "review.start": case "worktree.delete":
      return input.taskId === undefined && isThread(state, current) ? { ...input, taskId: current } : input;
    case "view.find-open":
      return input.target ? input : { ...input, target: state.find?.target ?? findTargetFor(state, "any") };
    default:
      return input;
  }
}

function isThread(state: WorkspaceState, taskId: string) {
  return state.threads.some((thread) => thread.id === taskId);
}

/** Adds the keys an input follows, and says whether it acts on the thread on screen without naming it. */
function collect(state: WorkspaceState, input: WorkspaceInput, keys: Set<string>): boolean {
  switch (input.type) {
    case "task.select": case "worktree.open-thread": case "view.jump-choose":
      return false;
    case "agent.events":
      for (const event of input.events) if ("taskId" in event) keys.add(event.taskId);
      return false;
    case "run.event":
      keys.add(input.event.taskId);
      return false;
    case "thread.event":
      if ("taskId" in input.event) keys.add(input.event.taskId);
      return false;
    case "view.find-open": case "view.find-query": case "view.find-step": case "view.find-close": {
      keys.add(FIND_KEY);
      const target = input.type === "view.find-open" ? input.target : state.find?.target;
      if (target?.kind === "thread" && target.taskId) keys.add(target.taskId);
      return false;
    }
    case "side-chat.open": case "view.move-worktree":
      if (state.currentId) keys.add(state.currentId);
      return true;
    case "view.shortcut": case "view.escape": {
      const commands = input.type === "view.shortcut" ? shortcutCommands(state, input.action, input.surface) : escapeCommands(state);
      let screen = false;
      for (const command of commands) {
        const named = withNamedThread(state, command);
        if (collect(state, named, keys) || named !== command) screen = true;
      }
      return screen;
    }
  }
  const taskId = (input as { taskId?: unknown }).taskId;
  if (typeof taskId === "string") keys.add(taskId);
  return false;
}
