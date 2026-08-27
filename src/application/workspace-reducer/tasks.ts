/** Threads themselves: making one, choosing it, and what the list can do to it. */
import { reduceWorktrees } from "./worktrees.js";
import { TAKE_KEYS, closeSideChats, disposeDocks, now, retireAutomations, settled, targetId } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { focusComposer } from "../composer-drafts.js";
import { forkedTasks } from "../task-fork.js";
import { activitySections, moveTask as moveTaskInList } from "../task-order.js";
import { pruneDeletedTasks } from "../task-pruning.js";
import { applyTask } from "../task-workspace.js";
import { DRAFT_DOCK, blockedTaskIds, busyTaskIds, projectFor, sideChatIds, worktreeById, type WorkspaceState } from "../workspace-state.js";
import { dismissableTasks, dismissed, readAttention } from "../../domain/attention.js";
import { clampTitle } from "../../domain/task.js";
import { engineHasModel } from "../../domain/agent-engine.js";

type TaskInput = Extract<WorkspaceInput, {
  type: "task.new" | "task.select" | "task.dismiss" | "task.dismiss-all" | "task.archive"
    | "task.restore" | "task.clear-archive" | "task.rename" | "title.suggested" | "task.fork"
    | "task.move" | "task.set-policy" | "task.set-model" | "task.set-effort";
}>;

export function reduceTasks(state: WorkspaceState, input: TaskInput): WorkspaceTransition {
  switch (input.type) {
    case "task.new": {
      /** A checkout names the project it was cut from, so starting in one settles both answers. */
      const worktree = worktreeById(state, input.worktreeId);
      const projectId = worktree?.projectId ?? input.projectId ?? null;
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      /** A fresh draft compares its own project, not whatever the last draft was left looking at. */
      const { [DRAFT_DOCK]: _lastDraft, ...diffs } = state.diffs;
      /** A new thread is asked for in order to type in it, so the caret goes to the empty composer. */
      return settled(focusComposer({
        ...state,
        diffs,
        currentId: null,
        draftProjectId: projectId,
        draftBranch: null,
        draftWorktree: false,
        draftWorktreeId: worktree?.id ?? null,
        actionError: null,
        lastFolder: project?.root ?? state.lastFolder,
        expandedProjects: projectId ? new Set(state.expandedProjects).add(projectId) : state.expandedProjects,
      }), TAKE_KEYS);
    }

    case "task.select": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const project = projectFor(state, task);
      return settled(readAttention({
        ...state,
        currentId: input.taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: project?.root ?? state.lastFolder,
        actionError: null,
      }, input.taskId));
    }

    case "task.dismiss": {
      const tasks = dismissed(state.tasks, new Set([input.taskId]));
      return settled(tasks === state.tasks ? state : { ...state, tasks });
    }

    case "task.dismiss-all": {
      /** Only what the button offers: the Priority rows. A thread still working has yet to show what it found. */
      const sideChats = sideChatIds(state), listed = state.tasks.filter((task) => task.archivedAt === undefined && !sideChats.has(task.id));
      const { priority } = activitySections(listed, busyTaskIds(state), blockedTaskIds(state));
      const dotted = new Set(dismissableTasks(priority).map((task) => task.id));
      return settled(dotted.size ? { ...state, tasks: dismissed(state.tasks, dotted) } : state);
    }

    /** Archiving a running task cancels its run; its checkout stays until the user removes it. */
    case "task.archive": {
      const active = state.activeRuns[input.taskId];
      return settled({
        ...state,
        tasks: state.tasks.map((task) => task.id === input.taskId ? { ...task, archivedAt: now() } : task),
        currentId: state.currentId === input.taskId ? null : state.currentId,
      }, [
        ...retireAutomations(state, [input.taskId]),
        ...(active ? [{ type: "send-run-command" as const, command: { type: "cancel" as const, taskId: active.taskId, runId: active.runId } }] : []),
      ]);
    }

    /** Restoring leaves the retired automation gone; the user re-arms it themselves. */
    case "task.restore": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task || task.archivedAt === undefined) return settled(state);
      return settled(applyTask(state, input.taskId, ({ archivedAt: _restored, ...item }) => item));
    }

    case "task.clear-archive": {
      if (state.tasks.every((task) => task.archivedAt === undefined)) return settled(state);
      const archived = state.tasks.filter((task) => task.archivedAt !== undefined), discarded = new Set(archived.map((task) => task.id));
      /** A fork of a thread that is gone has nowhere left to be shown, so it goes with it. */
      const forks = closeSideChats(state, state.sideChats.filter((chat) => discarded.has(chat.sourceTaskId)));
      const disposed = disposeDocks(forks.state, discarded);
      const tasks = disposed.state.tasks.filter((task) => !discarded.has(task.id));
      return {
        state: pruneDeletedTasks({
          ...disposed.state,
          tasks,
          currentId: tasks.some((task) => task.id === state.currentId) ? state.currentId : null,
        }, discarded),
        effects: [...forks.effects, ...disposed.effects],
      };
    }

    case "task.rename": {
      const title = clampTitle(input.title);
      if (!title || !state.tasks.some((task) => task.id === input.taskId)) return settled(state);
      return settled(applyTask(state, input.taskId, (task) => ({ ...task, title, titleByUser: true, updatedAt: now() })));
    }

    /** A name the user typed outranks a suggested one, whenever the suggestion lands. */
    case "title.suggested": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const title = clampTitle(input.title);
      if (!task || task.titleByUser || !title || title === task.title) return settled(state);
      return settled(applyTask(state, input.taskId, (item) => ({ ...item, title })));
    }

    /** The copy is opened the way any thread is opened, and asks for a checkout the way any thread asks. */
    case "task.fork": {
      const taskId = targetId(state, input.taskId);
      const source = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      if (!source || sideChatIds(state).has(source.id)) return settled(state);
      const { tasks, fork } = forkedTasks(state.tasks, source, crypto.randomUUID(), now());
      const opened = reduceTasks({ ...state, tasks, openMenu: null }, { type: "task.select", taskId: fork.id });
      if (!input.worktree) return opened;
      const located = reduceWorktrees(opened.state, { type: "task.set-worktree", taskId: fork.id, worktree: true });
      return { state: located.state, effects: [...opened.effects, ...located.effects] };
    }

    /** A drag reveals every folder so it can be dropped into, so the drop leaves the folding alone. */
    case "task.move": {
      const tasks = moveTaskInList(state.tasks, input.taskId, input.target);
      if (tasks === state.tasks) return settled(state);
      return settled({ ...state, tasks, openMenu: null });
    }

    case "task.set-policy": {
      const taskId = targetId(state, input.taskId);
      const drafted = input.taskId === undefined ? { ...state, draftPolicy: input.policy } : state;
      return settled(taskId ? applyTask(drafted, taskId, (task) => ({ ...task, executionPolicy: input.policy, updatedAt: now() })) : drafted);
    }

    case "task.set-model": {
      const taskId = targetId(state, input.taskId);
      /** A thread keeps the engine it started on, so the model must be one that engine offers too. */
      const engine = state.tasks.find((task) => task.id === taskId)?.engine;
      if (!engineHasModel(input.engine, input.model) || engine && !engineHasModel(engine, input.model)) return settled(state);
      const drafted = input.taskId === undefined ? { ...state, draftEngine: input.engine, draftModel: input.model } : state;
      return settled(taskId ? applyTask(drafted, taskId, (task) => ({ ...task, model: input.model, updatedAt: now() })) : drafted);
    }

    case "task.set-effort": {
      const taskId = targetId(state, input.taskId);
      const drafted = input.taskId === undefined ? { ...state, draftEffort: input.effort } : state;
      return settled(taskId ? applyTask(drafted, taskId, (task) => ({ ...task, effort: input.effort, updatedAt: now() })) : drafted);
    }
  }
}
