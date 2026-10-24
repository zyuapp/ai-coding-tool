/** Threads themselves: making one, choosing it, and what the list can do to it. */
import { reduceWorktrees } from "./worktrees.js";
import { retireAutomations } from "./automations.js";
import { TAKE_KEYS, disposeDocks, focusDockTab, showDockTab } from "./dock-tabs.js";
import { refreshThreadEnvironment } from "./environment.js";
import { closeSideChats } from "./side-chats.js";
import { discardedLeads } from "./coordination-remote.js";
import { cancellingRun, fileThread } from "./run-queue.js";
import { followUps, now, rejected, settled, targetId } from "./shared.js";
import { COORDINATOR_ROLE_ERROR, WORKTREE_COORDINATOR_ROLE_ERROR } from "./errors.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { AppCommand } from "../../contracts/commands.js";
import { focusComposer } from "../composer-drafts.js";
import { shownComputers, type PairedComputer } from "../computers.js";
import { REMOTE_UNSUPPORTED, supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import { forkedThreads } from "../thread-fork.js";
import { moveThread as moveThreadInList } from "../thread-order.js";
import { coordinatorRoster, dismissedWith, ownCoordinationSections, projectActivity } from "../coordination.js";
import { offlineMessage } from "../../domain/computers.js";
import { pruneDeletedThreads } from "../thread-pruning.js";
import { updateThread } from "../thread-run-state.js";
import { projectFor, worktreeById } from "../thread-location.js";
import { DRAFT_DOCK, dockFor, frontDock, sideChatIds, withDock, type WorkspaceState } from "../workspace-state.js";
import { threadActivity, threadLists } from "../thread-activity.js";
import { dismissed, readAttention, wantsAttention } from "../../domain/attention.js";
import { readRow } from "../thread-attention.js";
import { clampTitle, type Thread } from "../../domain/thread.js";
import { asCoordinator, coordinatorOf, effortRoleOf } from "../../domain/coordination.js";
import { isSnoozeHours, withoutSnooze } from "../../domain/thread-snooze.js";
import { cancelPause } from "../limit-pauses.js";
import { capabilitiesFor, defaultModelFor, effortForModel, engineHasModel, modelHasEffort } from "../../domain/agent-engine.js";

type ThreadCommandInput = Extract<WorkspaceInput, {
  type: "task.new" | "task.select" | "task.dismiss" | "task.dismiss-all" | "task.archive" | "task.snooze" | "task.unsnooze" | "snoozes.elapsed"
    | "task.restore" | "task.clear-archive" | "task.rename" | "task.set-role" | "title.suggested" | "task.fork"
    | "task.move" | "task.set-policy" | "task.set-model" | "task.set-effort" | "task.set-fast-mode";
}>;

/** Offers the title to the engine's own record of the thread; an engine that keeps none ignores it. */
function labelThread(taskId: string, title: string): WorkspaceEffect {
  return { type: "send-run-command", command: { type: "label", taskId, title } };
}

/** Puts the user on a thread: what it holds becomes read, and the app follows it to its folder. */
function landOnThread(state: WorkspaceState, taskId: string): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  return readRow({
    ...state,
    currentId: taskId,
    draftProjectId: thread?.projectId ?? null,
    lastFolder: project?.root ?? state.lastFolder,
    actionError: null,
  }, taskId);
}

/**
 * Priority as the sidebar draws it, narrowed to one project when `projectId` names one. A side chat
 * has no row of its own, so it is not one of them. A coordinator here stands for its threads on paired
 * computers too, read as their computer last said, as the sidebar ranks it.
 */
function priorityThreads(state: WorkspaceState, projectId?: string): Thread[] {
  const { sections, threads } = ownCoordinationSections(state, threadLists(state).visibleThreads, threadActivity(state), shownComputers(state.computers));
  return projectId ? projectActivity(sections, threads, projectId).priority : sections.priority;
}

/**
 * The rows of Priority Dismiss all files away, by the rule each row's own Dismiss follows, a
 * coordinator's read with every thread under it, here or on a paired computer.
 */
function dismissablePriority(state: WorkspaceState, projectId?: string): Thread[] {
  const here = threadActivity(state);
  const shown = shownComputers(state.computers);
  return priorityThreads(state, projectId).filter((row) => coordinatorRoster(state, row, here, shown).dismissable);
}

/**
 * A coordinator here filed away with threads under it on the paired computers the sidebar shows asks
 * each of those computers to file away its own, which only it can, by the rule the row's own Dismiss
 * reads: none waiting on an approval, and only those with something to file away. A computer that is
 * out of reach, or whose build cannot take it, says so.
 */
function dismissElsewhere(state: WorkspaceState, rows: ReadonlySet<string>): { effects: WorkspaceEffect[]; errors: string[] } {
  const inputs = new Map<string, { computer: PairedComputer; inputs: AppCommand[] }>();
  const here = threadActivity(state);
  const shown = shownComputers(state.computers);
  for (const row of rows) {
    const lead = state.threads.find((thread) => thread.id === row);
    if (!lead) continue;
    for (const { thread, computer } of coordinatorRoster(state, lead, here, shown).filed) {
      if (!computer || !wantsAttention(thread)) continue;
      const held = inputs.get(computer.id) ?? { computer, inputs: [] };
      held.inputs.push({ type: "task.dismiss", taskId: thread.id });
      inputs.set(computer.id, held);
    }
  }
  const effects: WorkspaceEffect[] = [];
  const errors: string[] = [];
  for (const { computer, inputs: commands } of inputs.values()) {
    if (computer.status !== "connected") errors.push(offlineMessage(computer));
    else if (!commands.every((command) => supportsComputerCommand(computer.capabilities, command))) errors.push(`${computer.name}: ${REMOTE_UNSUPPORTED}`);
    else effects.push({ type: "computer.forward", id: computer.id, inputs: commands });
  }
  return { effects, errors };
}

/** The row Priority moves on to once this one leaves it: the one below, or the one above when it was last. */
function priorityNeighbour(state: WorkspaceState, taskId: string): string | undefined {
  /** Only a project of this computer's narrows its rows; a filter the sidebar ignores is ignored here too. */
  const narrowed = state.activityProject !== null && state.projects.some((project) => project.id === state.activityProject && !project.unlisted);
  const priority = priorityThreads(state, narrowed ? state.activityProject! : undefined);
  const index = priority.findIndex((thread) => thread.id === taskId);
  if (index === -1) return undefined;
  return (priority[index + 1] ?? priority[index - 1])?.id;
}

/**
 * Dismisses the listed computers' Priority, or only one project's rows of it; each host owns its
 * changes and reports them back.
 */
function dismissPriority(state: WorkspaceState, localOnly = false, projectId?: string): WorkspaceTransition {
  const own = localOnly || state.computers.filter === "all" || state.computers.filter === "this";
  /** A coordinator in Priority is there for its threads too, so filing it away files them with it. */
  const rows = new Set(own ? dismissablePriority(state, projectId).map((thread) => thread.id) : []);
  const dotted = dismissedWith(state.threads, rows, threadActivity(state).blocked);
  const next = dotted.size ? { ...state, threads: dismissed(state.threads, dotted) } : state;
  if (localOnly) return settled(next);
  const { effects, errors } = dismissElsewhere(state, rows);
  for (const computer of shownComputers(state.computers)) {
    if (computer.status !== "connected" || !computer.state || !dismissablePriority(computer.state, projectId).length) continue;
    const scoped: AppCommand = { type: "task.dismiss-all", localOnly: true, ...(projectId ? { projectId } : {}) };
    /** Older hosts already dismiss only their own threads and do not know the scope field, but nothing narrower holds without the project. */
    const command: AppCommand = projectId || supportsComputerCommand(computer.capabilities, scoped) ? scoped : { type: "task.dismiss-all" };
    if (!supportsComputerCommand(computer.capabilities, command)) {
      errors.push(`${computer.name}: ${REMOTE_UNSUPPORTED}`);
      continue;
    }
    effects.push({ type: "computer.forward", id: computer.id, inputs: [command] });
  }
  return errors.length ? rejected(next, errors.join("\n"), effects) : settled(next, effects);
}

/**
 * Archiving a running thread cancels its run; its checkout stays until the user removes it. Its
 * pages give up their views but keep their records, so restoring and showing one reopens it. The
 * page still on screen, through a side chat of the thread, keeps its view, and every page stays while
 * one of its side chats is still running, since that run browses them.
 */
function archiveThread(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const active = state.activeRuns[taskId];
  /** Filing a thread away ends its work, including a wait to resume after its usage limit, which ends as filed away. */
  const unpaused = cancelPause({
    ...state,
    threads: state.threads.map((thread) => thread.id === taskId ? { ...thread, archivedAt: now() } : thread),
    currentId: state.currentId === taskId ? null : state.currentId,
  }, taskId);
  const archived = unpaused.state;
  const dock = dockFor(state, taskId);
  const shown = frontDock(archived).owner === taskId ? dock.tab : null;
  const browsing = state.sideChats.some((chat) => chat.sourceThreadId === taskId && state.activeRuns[chat.id]);
  const closed = new Set(browsing ? [] : dock.browserTabs.filter((tab) => tab.id !== shown).map((tab) => tab.id));
  const parked = closed.size
    ? withDock(archived, taskId, { browserTabs: dock.browserTabs.map((tab) => closed.has(tab.id) && tab.loading ? { ...tab, loading: false } : tab) })
    : archived;
  const stopping = active ? cancellingRun(parked, active) : settled(parked);
  return settled(stopping.state, [
    ...unpaused.effects,
    ...retireAutomations(state, [taskId]),
    ...stopping.effects,
    ...fileThread(state, state.threads.find((thread) => thread.id === taskId), true),
    ...[...closed].map((tabId): WorkspaceEffect => ({ type: "browser.close", tabId })),
  ]);
}

export function reduceThreadCommands(state: WorkspaceState, input: ThreadCommandInput): WorkspaceTransition {
  switch (input.type) {
    case "snoozes.elapsed":
      return settled(state);

    case "task.snooze": {
      if (!isSnoozeHours(input.hours) || !priorityThreads(state).some((thread) => thread.id === input.taskId)) return settled(state);
      const snoozedUntil = now() + input.hours * 60 * 60 * 1000;
      return settled({ ...updateThread(state, input.taskId, (thread) => ({ ...thread, snoozedUntil })), openMenu: null });
    }

    case "task.unsnooze":
      if (!state.threads.some((thread) => thread.id === input.taskId && thread.snoozedUntil !== undefined)) return settled(state);
      return settled({ ...updateThread(state, input.taskId, withoutSnooze), openMenu: null });

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
        draftRole: null,
        actionError: null,
        lastFolder: project?.root ?? state.lastFolder,
        expandedProjects: projectId ? new Set(state.expandedProjects).add(projectId) : state.expandedProjects,
      }), TAKE_KEYS);
    }

    /**
     * A side chat is a tab within its source thread, and a thread under a coordinator a tab within the
     * coordinator's, so landing on either lands on the thread holding it and opens its tab there.
     */
    case "task.select": {
      const chat = state.sideChats.find((item) => item.id === input.taskId);
      const lead = chat ? undefined : coordinatorOf(state.threads, state.threads.find((item) => item.id === input.taskId));
      const taskId = chat?.sourceThreadId ?? lead?.id ?? input.taskId;
      const landed = landOnThread(state, taskId);
      if (taskId === input.taskId) return settled(landed);
      const tabs = dockFor(landed, taskId).threadTabs;
      const opened = lead && !tabs.includes(input.taskId) ? withDock(landed, taskId, { threadTabs: [...tabs, input.taskId] }) : landed;
      const shown = showDockTab(readAttention(opened, input.taskId), taskId, input.taskId);
      const focused = focusDockTab(shown, taskId, input.taskId);
      return lead ? { ...focused, effects: [...focused.effects, ...followUps(refreshThreadEnvironment(focused.state, input.taskId))] } : focused;
    }

    case "task.dismiss": {
      const threads = dismissed(state.threads, dismissedWith(state.threads, new Set([input.taskId]), threadActivity(state).blocked));
      const elsewhere = dismissElsewhere(state, new Set([input.taskId]));
      if (threads === state.threads && !elsewhere.effects.length && !elsewhere.errors.length) return settled(state);
      /** Filing away the thread being read moves on to the row that takes its place, so Priority can be worked down without going back to the list. */
      const successor = state.sidebarMode === "activity" && state.currentId === input.taskId
        ? priorityNeighbour(state, input.taskId)
        : undefined;
      const filed = threads === state.threads ? state : { ...state, threads };
      const landed = successor ? landOnThread(filed, successor) : filed;
      return elsewhere.errors.length ? rejected(landed, elsewhere.errors.join("\n"), elsewhere.effects) : settled(landed, elsewhere.effects);
    }

    case "task.dismiss-all":
      return dismissPriority(state, input.localOnly, input.projectId);

    case "task.archive":
      return archiveThread(state, input.taskId);

    /** Restoring leaves the retired automation gone; the user re-arms it themselves. */
    case "task.restore": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || thread.archivedAt === undefined) return settled(state);
      return settled(updateThread(state, input.taskId, ({ archivedAt: _restored, ...item }) => item), fileThread(state, thread, false));
    }

    case "task.clear-archive": {
      if (state.threads.every((thread) => thread.archivedAt === undefined)) return settled(state);
      const archived = state.threads.filter((thread) => thread.archivedAt !== undefined), discarded = new Set(archived.map((thread) => thread.id));
      /** A fork of a thread that is gone has nowhere left to be shown, so it goes with it. */
      const forks = closeSideChats(state, state.sideChats.filter((chat) => discarded.has(chat.sourceThreadId)));
      const disposed = disposeDocks(forks.state, discarded);
      const threads = disposed.state.threads.filter((thread) => !discarded.has(thread.id));
      const cleared = discardedLeads(pruneDeletedThreads({
        ...disposed.state,
        threads,
        currentId: threads.some((thread) => thread.id === state.currentId) ? state.currentId : null,
      }, discarded), archived);
      return { state: cleared.state, effects: [...forks.effects, ...disposed.effects, ...cleared.effects] };
    }

    case "task.rename": {
      const title = clampTitle(input.title);
      if (!title || !state.threads.some((thread) => thread.id === input.taskId)) return settled(state);
      return {
        state: updateThread(state, input.taskId, (thread) => ({ ...thread, title, titleByUser: true, updatedAt: now() })),
        effects: [labelThread(input.taskId, title)],
      };
    }

    case "task.set-role": {
      const taskId = targetId(state, input.taskId);
      const thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
      if (!thread) return settled(input.taskId === undefined ? { ...state, draftRole: input.role } : state);
      if ((thread.role ?? null) === input.role) return settled(state);
      /**
       * A thread on another computer never takes a coordinator's role away, nor makes one in a worktree
       * a coordinator, as none here does; the user still can.
       */
      if (input.sender && thread.role === "coordinator") return rejected(state, COORDINATOR_ROLE_ERROR);
      if (input.sender && input.role === "coordinator" && (thread.worktreeId !== undefined || state.creatingWorktrees.includes(thread.id))) return rejected(state, WORKTREE_COORDINATOR_ROLE_ERROR);
      /**
       * A thread becoming a coordinator starts its threads on what it runs on itself, until the user
       * picks otherwise; one that stops being one forgets the choice, the threads it suggested and
       * its mute, so the next time is fresh.
       */
      return settled(updateThread(state, thread.id, ({ role: _previous, threadModel: _choice, proposals: _suggested, muted: _muted, ...item }) => {
        if (input.role === "coordinator") return { ...asCoordinator(item), updatedAt: now() };
        return { ...item, ...(input.role ? { role: input.role } : {}), updatedAt: now() };
      }));
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
      const draftEffort = effortForModel(input.model, state.draftEffort, effortRoleOf(undefined, state.draftRole));
      const drafted = input.taskId === undefined ? { ...state, draftEngine: input.engine, draftModel: input.model, draftEffort } : state;
      return settled(taskId ? updateThread(drafted, taskId, (thread) => ({ ...thread, model: input.model, updatedAt: now() })) : drafted);
    }

    case "task.set-fast-mode": {
      const taskId = targetId(state, input.taskId);
      const thread = state.threads.find((item) => item.id === taskId);
      if (taskId && !thread || !capabilitiesFor(thread?.engine ?? state.draftEngine).fastMode) return settled(state);
      const drafted = input.taskId === undefined ? { ...state, draftFastMode: input.fastMode } : state;
      return settled(taskId ? updateThread(drafted, taskId, (item) => ({ ...item, fastMode: input.fastMode, updatedAt: now() })) : drafted);
    }

    case "task.set-effort": {
      const taskId = targetId(state, input.taskId);
      const thread = state.threads.find((item) => item.id === taskId);
      /** Effort belongs to the model, and to the part the thread plays, so only one the target takes can be set on it. */
      if (thread && !modelHasEffort(thread.model ?? defaultModelFor(thread.engine), input.effort, effortRoleOf(thread, null))) return settled(state);
      const draftTakes = modelHasEffort(state.draftModel, input.effort, effortRoleOf(undefined, state.draftRole));
      if (!thread && !draftTakes) return settled(state);
      /** The draft keeps its own model, so it takes the effort only where that model offers it. */
      const drafted = input.taskId === undefined && draftTakes ? { ...state, draftEffort: input.effort } : state;
      return settled(taskId ? updateThread(drafted, taskId, (thread) => ({ ...thread, effort: input.effort, updatedAt: now() })) : drafted);
    }
  }
}
