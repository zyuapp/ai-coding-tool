/** Threads themselves: making one, choosing it, and what the list can do to it. */
import { reduceWorktrees } from "./worktrees.js";
import { TAKE_KEYS, closeSideChats, disposeDocks, focusDockTab, now, retireAutomations, settled, showDockTab, targetId } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { focusComposer } from "../composer-drafts.js";
import { forkedThreads } from "../thread-fork.js";
import { activitySections, moveThread as moveThreadInList } from "../thread-order.js";
import { pruneDeletedThreads } from "../thread-pruning.js";
import { updateThread } from "../thread-run-state.js";
import { projectFor, worktreeById } from "../thread-location.js";
import { DRAFT_DOCK, blockedThreadIds, busyThreadIds, sideChatIds, type WorkspaceState } from "../workspace-state.js";
import { dismissableThreads, dismissed, readAttention } from "../../domain/attention.js";
import { clampTitle, type Thread } from "../../domain/thread.js";
import { defaultModelFor, effortForModel, engineHasModel, modelHasEffort } from "../../domain/agent-engine.js";

type ThreadCommandInput = Extract<WorkspaceInput, {
  type: "task.new" | "task.select" | "task.dismiss" | "task.dismiss-all" | "task.archive"
    | "task.restore" | "task.clear-archive" | "task.rename" | "title.suggested" | "task.fork"
    | "task.move" | "task.set-policy" | "task.set-model" | "task.set-effort";
}>;

/** Offers the title to the engine's own record of the thread; an engine that keeps none ignores it. */
function labelThread(taskId: string, title: string): WorkspaceEffect {
  return { type: "send-run-command", command: { type: "label", taskId, title } };
}

/** Puts the user on a thread: what it holds becomes read, and the app follows it to its folder. */
function landOnThread(state: WorkspaceState, taskId: string): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  return readAttention({
    ...state,
    currentId: taskId,
    draftProjectId: thread?.projectId ?? null,
    lastFolder: project?.root ?? state.lastFolder,
    actionError: null,
  }, taskId);
}

/** Priority as the sidebar draws it. A side chat has no row of its own, so it is not one of them. */
function priorityThreads(state: WorkspaceState): Thread[] {
  const sideChats = sideChatIds(state);
  const listed = state.threads.filter((thread) => thread.archivedAt === undefined && !sideChats.has(thread.id));
  return activitySections(listed, busyThreadIds(state), blockedThreadIds(state)).priority;
}

/** The row Priority moves on to once this one leaves it: the one below, or the one above when it was last. */
function priorityNeighbour(state: WorkspaceState, taskId: string): string | undefined {
  const priority = priorityThreads(state);
  const index = priority.findIndex((thread) => thread.id === taskId);
  if (index === -1) return undefined;
  return (priority[index + 1] ?? priority[index - 1])?.id;
}

export function reduceThreadCommands(state: WorkspaceState, input: ThreadCommandInput): WorkspaceTransition {
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

    /** A side chat is a tab within its source thread, so landing on one lands on that thread first. */
    case "task.select": {
      const chat = state.sideChats.find((item) => item.id === input.taskId);
      const taskId = chat?.sourceThreadId ?? input.taskId;
      const landed = landOnThread(state, taskId);
      if (!chat) return settled(landed);
      const shown = showDockTab(readAttention(landed, chat.id), taskId, chat.id);
      return focusDockTab(shown, taskId, chat.id);
    }

    case "task.dismiss": {
      const threads = dismissed(state.threads, new Set([input.taskId]));
      if (threads === state.threads) return settled(state);
      /** Filing away the thread being read moves on to the row that takes its place, so Priority can be worked down without going back to the list. */
      const successor = state.sidebarMode === "activity" && state.currentId === input.taskId
        ? priorityNeighbour(state, input.taskId)
        : undefined;
      const filed = { ...state, threads };
      return settled(successor ? landOnThread(filed, successor) : filed);
    }

    case "task.dismiss-all": {
      /** Only what the button offers: the Priority rows. A thread still working has yet to show what it found. */
      const dotted = new Set(dismissableThreads(priorityThreads(state)).map((thread) => thread.id));
      return settled(dotted.size ? { ...state, threads: dismissed(state.threads, dotted) } : state);
    }

    /** Archiving a running thread cancels its run; its checkout stays until the user removes it. */
    case "task.archive": {
      const active = state.activeRuns[input.taskId];
      return settled({
        ...state,
        threads: state.threads.map((thread) => thread.id === input.taskId ? { ...thread, archivedAt: now() } : thread),
        currentId: state.currentId === input.taskId ? null : state.currentId,
      }, [
        ...retireAutomations(state, [input.taskId]),
        ...(active ? [{ type: "send-run-command" as const, command: { type: "cancel" as const, taskId: active.taskId, runId: active.runId } }] : []),
      ]);
    }

    /** Restoring leaves the retired automation gone; the user re-arms it themselves. */
    case "task.restore": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || thread.archivedAt === undefined) return settled(state);
      return settled(updateThread(state, input.taskId, ({ archivedAt: _restored, ...item }) => item));
    }

    case "task.clear-archive": {
      if (state.threads.every((thread) => thread.archivedAt === undefined)) return settled(state);
      const archived = state.threads.filter((thread) => thread.archivedAt !== undefined), discarded = new Set(archived.map((thread) => thread.id));
      /** A fork of a thread that is gone has nowhere left to be shown, so it goes with it. */
      const forks = closeSideChats(state, state.sideChats.filter((chat) => discarded.has(chat.sourceThreadId)));
      const disposed = disposeDocks(forks.state, discarded);
      const threads = disposed.state.threads.filter((thread) => !discarded.has(thread.id));
      return {
        state: pruneDeletedThreads({
          ...disposed.state,
          threads,
          currentId: threads.some((thread) => thread.id === state.currentId) ? state.currentId : null,
        }, discarded),
        effects: [...forks.effects, ...disposed.effects],
      };
    }

    case "task.rename": {
      const title = clampTitle(input.title);
      if (!title || !state.threads.some((thread) => thread.id === input.taskId)) return settled(state);
      return {
        state: updateThread(state, input.taskId, (thread) => ({ ...thread, title, titleByUser: true, updatedAt: now() })),
        effects: [labelThread(input.taskId, title)],
      };
    }

    /** A name the user typed outranks a suggested one, whenever the suggestion lands. */
    case "title.suggested": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const title = clampTitle(input.title);
      if (!thread || thread.titleByUser || !title || title === thread.title) return settled(state);
      return { state: updateThread(state, input.taskId, (item) => ({ ...item, title })), effects: [labelThread(input.taskId, title)] };
    }

    /** The copy is opened the way any thread is opened, and asks for a checkout the way any thread asks. */
    case "task.fork": {
      const taskId = targetId(state, input.taskId);
      const source = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
      if (!source || sideChatIds(state).has(source.id)) return settled(state);
      const { threads, fork } = forkedThreads(state.threads, source, crypto.randomUUID(), now());
      const opened = reduceThreadCommands({ ...state, threads, openMenu: null }, { type: "task.select", taskId: fork.id });
      if (!input.worktree) return opened;
      const located = reduceWorktrees(opened.state, { type: "task.set-worktree", taskId: fork.id, worktree: true });
      return { state: located.state, effects: [...opened.effects, ...located.effects] };
    }

    /** A drag reveals every folder so it can be dropped into, so the drop leaves the folding alone. */
    case "task.move": {
      const threads = moveThreadInList(state.threads, input.taskId, input.target);
      if (threads === state.threads) return settled(state);
      return settled({ ...state, threads, openMenu: null });
    }

    case "task.set-policy": {
      const taskId = targetId(state, input.taskId);
      const drafted = input.taskId === undefined ? { ...state, draftPolicy: input.policy } : state;
      return settled(taskId ? updateThread(drafted, taskId, (thread) => ({ ...thread, executionPolicy: input.policy, updatedAt: now() })) : drafted);
    }

    case "task.set-model": {
      const taskId = targetId(state, input.taskId);
      /** A thread keeps the engine it started on, so the model must be one that engine offers too. */
      const engine = state.threads.find((thread) => thread.id === taskId)?.engine;
      if (!engineHasModel(input.engine, input.model) || engine && !engineHasModel(engine, input.model)) return settled(state);
      /** A draft keeps its effort where the new model takes it, and drops to the nearest one below where it does not. */
      const draftEffort = effortForModel(input.model, state.draftEffort);
      const drafted = input.taskId === undefined ? { ...state, draftEngine: input.engine, draftModel: input.model, draftEffort } : state;
      return settled(taskId ? updateThread(drafted, taskId, (thread) => ({ ...thread, model: input.model, updatedAt: now() })) : drafted);
    }

    case "task.set-effort": {
      const taskId = targetId(state, input.taskId);
      const thread = state.threads.find((item) => item.id === taskId);
      /** Effort belongs to the model, so only one the target model takes can be set on it. */
      if (thread && !modelHasEffort(thread.model ?? defaultModelFor(thread.engine), input.effort)) return settled(state);
      if (!thread && !modelHasEffort(state.draftModel, input.effort)) return settled(state);
      /** The draft keeps its own model, so it takes the effort only where that model offers it. */
      const drafted = input.taskId === undefined && modelHasEffort(state.draftModel, input.effort) ? { ...state, draftEffort: input.effort } : state;
      return settled(taskId ? updateThread(drafted, taskId, (thread) => ({ ...thread, effort: input.effort, updatedAt: now() })) : drafted);
    }
  }
}
