/** Threads themselves: making one, choosing it, and what the list can do to it. */
import { worktreeSet } from "./worktrees.js";
import { retireAutomations } from "./automations.js";
import { TAKE_KEYS, docksDisposed, docksOf, draftReviewDroppedIn, editDock } from "./dock-tabs.js";
import { afterward, andThen, inTurn, type Step } from "./slice.js";
import { sideChatsClosed } from "./side-chats.js";
import { leadsDiscarded } from "./coordination-remote.js";
import { cancelling, fileThread } from "./run-queue.js";
import { now, targetId } from "./shared.js";
import { coordinatorAskRefusal } from "./errors.js";
import { allReadIn, dismissedIn, editThread, forkedIn, movedInListIn, removedIn, restoredIn, roleSetIn, threadsOf, unsnoozedIn, verdictCollectedIn } from "./thread-edits.js";
import { draftChoiceIn, draftRoleIn, freshDraftIn, landed, navigationOf, offThreadIn, onListedThreadIn, selected } from "./thread-select.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import type { AppCommand } from "../../contracts/commands.js";
import { composerOf, focusComposerIn } from "../composer-drafts.js";
import { computerOfThread, shownComputers } from "../computers.js";
import type { PairedComputer } from "../state/computers.js";
import { REMOTE_UNSUPPORTED, supportsComputerCommand } from "../../contracts/computer-capabilities.js";
import { coordinatorRoster, dismissedWith, ownCoordinationSections, projectActivity } from "../coordination.js";
import { offlineMessage } from "../../domain/computers.js";
import { pruned } from "../thread-pruning.js";
import { worktreeById } from "../thread-location.js";
import { changedDraft, dockFor, frontDock, type WorkspaceState } from "../workspace-state.js";
import { sideChatIds } from "../state/side-chats.js";
import { threadActivity, threadLists } from "../thread-activity.js";
import { hasUnreadAttention, wantsAttention } from "../../domain/attention.js";
import { archivePromptIn, archivePromptView, dialogsOf, forkNameIn, menuIn } from "../workspace-dialogs.js";
import { clampTitle, forkTitle, type Thread, type ThreadCore } from "../../domain/thread.js";
import { effortRoleOf } from "../../domain/coordination.js";
import { isSnoozeHours } from "../../domain/thread-snooze.js";
import { pauseCancelled } from "../limit-pauses.js";
import { capabilitiesFor, defaultModelIn, engineHasModel, modelHasEffort, threadModel, type EngineId } from "../../domain/agent-engine.js";
import type { AgentDraft } from "../../domain/agent-draft.js";
import type { AgentEffort } from "../../domain/run.js";
import { catalogOf } from "../state/engines.js";

/** Threads themselves are this feature's own: their title, role, snooze, archive and agent settings. */
type ThreadStep = Step<ThreadCore>;

export const THREAD_COMMAND_INPUTS = [
  "task.new", "task.select", "task.dismiss", "task.dismiss-all", "task.read-all", "task.result-collected", "task.archive", "task.snooze", "task.unsnooze", "snoozes.elapsed", "task.restore",
  "task.clear-archive", "task.rename", "task.set-role", "title.suggested", "task.fork", "view.fork-name", "view.archive-prompt", "task.move", "task.set-policy", "task.set-model",
  "task.set-effort", "task.set-fast-mode"
] as const;
type ThreadCommandInput = Extract<WorkspaceInput, { type: (typeof THREAD_COMMAND_INPUTS)[number] }>;

/** The name it suggests is the one a fork gets without asking, numbered among the threads on the computer holding it. */
function askForkName(state: WorkspaceState, input: Extract<ThreadCommandInput, { type: "view.fork-name" }>): ThreadStep {
  if (input.sourceId === null) return { edits: [forkNameIn(dialogsOf(state), null)] };
  const holder = computerOfThread(state, input.sourceId)?.state ?? state;
  const source = holder.threads.find((item) => item.id === input.sourceId);
  if (!source || sideChatIds(holder).has(source.id)) return {};
  const title = forkTitle(source.title, holder.threads.map((thread) => thread.title));
  return { edits: [menuIn(forkNameIn(dialogsOf(state), { taskId: source.id, worktree: input.worktree === true, title }), null)] };
}

/** Offers the title to the engine's own record of the thread; an engine that keeps none ignores it. */
function labelThread(taskId: string, title: string): WorkspaceEffect {
  return { type: "send-run-command", command: { type: "label", taskId, title } };
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
function dismissPriority(state: WorkspaceState, localOnly = false, projectId?: string): ThreadStep {
  const own = localOnly || state.computers.filter === "all" || state.computers.filter === "this";
  /** A coordinator in Priority is there for its threads too, so filing it away files them with it. */
  const rows = new Set(own ? dismissablePriority(state, projectId).map((thread) => thread.id) : []);
  const dotted = dismissedWith(state.threads, rows, threadActivity(state).blocked);
  const filed: ThreadStep = dotted.size ? { edits: [dismissedIn(threadsOf(state), dotted)] } : {};
  if (localOnly) return filed;
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
  return { ...filed, effects, ...(errors.length ? { refusal: errors.join("\n") } : {}) };
}

/** Marks the listed computers' threads read; each host owns its changes and reports them back. */
function readAll(state: WorkspaceState, localOnly = false): ThreadStep {
  const own = localOnly || state.computers.filter === "all" || state.computers.filter === "this";
  const read: ThreadStep = own ? { edits: [allReadIn(threadsOf(state))] } : {};
  if (localOnly) return read;
  const command: AppCommand = { type: "task.read-all", localOnly: true };
  const effects: WorkspaceEffect[] = [];
  const errors: string[] = [];
  for (const computer of shownComputers(state.computers)) {
    if (computer.status !== "connected" || !computer.state?.threads.some(hasUnreadAttention)) continue;
    if (supportsComputerCommand(computer.capabilities, command)) effects.push({ type: "computer.forward", id: computer.id, inputs: [command] });
    else errors.push(`${computer.name}: ${REMOTE_UNSUPPORTED}`);
  }
  return { ...read, effects, ...(errors.length ? { refusal: errors.join("\n") } : {}) };
}

/**
 * Archiving a running thread cancels its run; its checkout stays until the user removes it. Its
 * pages give up their views but keep their records, so restoring and showing one reopens it. The
 * page still on screen, through a side chat of the thread, keeps its view, and every page stays while
 * one of its side chats is still running, since that run browses them.
 */
function archiveThread(state: WorkspaceState, taskId: string): ThreadStep {
  const active = state.activeRuns[taskId];
  const dock = dockFor(state, taskId);
  const filing: ThreadStep = { edits: [editThread(threadsOf<ThreadCore>(state), taskId, () => ({ archivedAt: now() })), offThreadIn(navigationOf(state), taskId)] };
  const shown = frontDock(afterward(state, filing)).owner === taskId ? dock.tab : null;
  const browsing = state.sideChats.some((chat) => chat.sourceThreadId === taskId && state.activeRuns[chat.id]);
  const closed = new Set(browsing ? [] : dock.browserTabs.filter((tab) => tab.id !== shown).map((tab) => tab.id));
  return inTurn<ThreadCore>(state, filing, [
    /** Filing a thread away ends its work, including a wait to resume after its usage limit, which ends as filed away. */
    (archived) => pauseCancelled(archived, taskId),
    (archived) => ({
      edits: closed.size ? [editDock(docksOf(archived), taskId, { browserTabs: dock.browserTabs.map((tab) => closed.has(tab.id) && tab.loading ? { ...tab, loading: false } : tab) })] : [],
      effects: retireAutomations(state, [taskId]),
    }),
    (parked) => active ? cancelling(parked, active) : {},
    () => ({ effects: [...fileThread(state, state.threads.find((thread) => thread.id === taskId), true), ...[...closed].map((tabId): WorkspaceEffect => ({ type: "browser.close", tabId }))] }),
  ]);
}

/** Files one row away, with the threads under it, here and on the paired computers holding them. */
function dismissThread(state: WorkspaceState, taskId: string): ThreadStep {
  const filing = dismissedIn(threadsOf(state), dismissedWith(state.threads, new Set([taskId]), threadActivity(state).blocked));
  const elsewhere = dismissElsewhere(state, new Set([taskId]));
  if (filing.view.threads === state.threads && !elsewhere.effects.length && !elsewhere.errors.length) return {};
  /** Filing away the thread being read moves on to the row that takes its place, so Priority can be worked down without going back to the list. */
  const successor = state.currentId === taskId
    ? priorityNeighbour(state, taskId)
    : undefined;
  const filed: ThreadStep = { edits: [filing] };
  const landing = successor ? andThen<ThreadCore>(state, filed, (next) => landed(next, successor)) : filed;
  return { ...landing, effects: [...landing.effects ?? [], ...elsewhere.effects], ...(elsewhere.errors.length ? { refusal: elsewhere.errors.join("\n") } : {}) };
}

/**
 * The window on a fresh draft, in the checkout or project named. A checkout names the project it was
 * cut from, so starting in one settles both answers. A new thread is asked for in order to type in it,
 * so the caret goes to the empty composer.
 */
export function newThread(state: WorkspaceState, projectIdNamed?: string, worktreeId?: string): Step {
  const worktree = worktreeById(state, worktreeId);
  const projectId = worktree?.projectId ?? projectIdNamed ?? null;
  const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
  return {
    edits: [draftReviewDroppedIn(docksOf(state)), freshDraftIn(navigationOf(state), projectId, worktree?.id ?? null, project?.root), focusComposerIn(composerOf(state))],
    effects: TAKE_KEYS,
    clearsError: true,
    closesMenu: true,
  };
}

/** A refusal shown where the window shows errors that answers nothing, so the input it came with still succeeds. */
function shownNotAnswered(state: WorkspaceState, step: ThreadStep): ThreadStep {
  const { refusal, result: _result, ...shown } = step;
  return refusal === undefined ? shown : { ...shown, error: { message: refusal, page: shown.error?.page ?? state.actionErrorPage } };
}

export function reduceThreadCommands(state: WorkspaceState, input: ThreadCommandInput): ThreadStep {
  switch (input.type) {
    case "snoozes.elapsed":
      return {};

    case "task.snooze": {
      if (!isSnoozeHours(input.hours) || !priorityThreads(state).some((thread) => thread.id === input.taskId)) return {};
      const snoozedUntil = now() + input.hours * 60 * 60 * 1000;
      return { edits: [editThread(threadsOf<ThreadCore>(state), input.taskId, () => ({ snoozedUntil }))], closesMenu: true };
    }

    case "task.unsnooze":
      if (!state.threads.some((thread) => thread.id === input.taskId && thread.snoozedUntil !== undefined)) return {};
      return { edits: [unsnoozedIn(threadsOf(state), input.taskId)], closesMenu: true };

    case "task.new":
      return newThread(state, input.projectId, input.worktreeId);

    /**
     * A side chat is a tab within its source thread, and a thread under a coordinator a tab within the
     * coordinator's, so landing on either lands on the thread holding it and opens its tab there.
     */
    case "task.select":
      return selected(state, input.taskId);

    case "task.dismiss":
      return dismissThread(state, input.taskId);

    case "task.dismiss-all":
      return dismissPriority(state, input.localOnly, input.projectId);

    case "task.read-all":
      return readAll(state, input.localOnly);

    /** The verdict reached the user through the thread that waited on it; what a run found stays theirs to read. */
    case "task.result-collected": {
      if (!state.threads.some((thread) => thread.id === input.taskId && thread.outcomeUnread)) return {};
      return { edits: [verdictCollectedIn(threadsOf(state), input.taskId)] };
    }

    case "task.archive":
      return archiveThread(state, input.taskId);

    /** Restoring leaves the retired automation gone; the user re-arms it themselves. */
    case "task.restore": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread || thread.archivedAt === undefined) return {};
      return { edits: [restoredIn(threadsOf(state), input.taskId)], effects: fileThread(state, thread, false) };
    }

    case "task.clear-archive": {
      if (state.threads.every((thread) => thread.archivedAt === undefined)) return {};
      const archived = state.threads.filter((thread) => thread.archivedAt !== undefined), discarded = new Set(archived.map((thread) => thread.id));
      /** A fork of a thread that is gone has nowhere left to be shown, so it goes with it. */
      return inTurn<ThreadCore>(state, sideChatsClosed(state, state.sideChats.filter((chat) => discarded.has(chat.sourceThreadId))), [
        (forked) => docksDisposed(forked, discarded),
        (disposed) => {
          const threads = removedIn(threadsOf(disposed), discarded);
          return { edits: [threads, onListedThreadIn(navigationOf(disposed), threads.view.threads)] };
        },
        (removed) => pruned(removed, discarded),
        (cleared) => leadsDiscarded(cleared, archived),
      ]);
    }

    case "task.rename": {
      const title = clampTitle(input.title);
      if (!title || !state.threads.some((thread) => thread.id === input.taskId)) return {};
      return {
        edits: [editThread(threadsOf<ThreadCore>(state), input.taskId, () => ({ title, titleByUser: true, updatedAt: now() }))],
        effects: [labelThread(input.taskId, title)],
      };
    }

    case "task.set-role": {
      const taskId = targetId(state, input.taskId);
      const thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
      if (!thread) return input.taskId === undefined ? { edits: [draftRoleIn(navigationOf(state), input.role)] } : {};
      if ((thread.role ?? null) === input.role) return {};
      /**
       * A thread on another computer never takes a coordinator's role away, nor makes one in a worktree
       * a coordinator, as none here does; the user still can.
       */
      const refusal = input.sender && coordinatorAskRefusal(thread, input, state.creatingWorktrees.includes(thread.id));
      if (refusal) return { refusal };
      return { edits: [roleSetIn(threadsOf(state), thread.id, input.role, catalogOf(state), now)] };
    }

    /** A name the user typed outranks a suggested one, whenever the suggestion lands. */
    case "title.suggested": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const title = clampTitle(input.title);
      if (!thread || thread.titleByUser || !title || title === thread.title) return {};
      return { edits: [editThread(threadsOf<ThreadCore>(state), input.taskId, () => ({ title }))], effects: [labelThread(input.taskId, title)] };
    }

    /** The copy is opened the way any thread is opened, and asks for a checkout the way any thread asks. */
    case "task.fork": {
      const taskId = targetId(state, input.taskId);
      const source = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
      if (!source || sideChatIds(state).has(source.id)) return {};
      const forkId = crypto.randomUUID();
      const forking: ThreadStep = { edits: [forkedIn(threadsOf(state), source, forkId, now(), input.title), menuIn(forkNameIn(dialogsOf(state), null), null)] };
      const opened = andThen<ThreadCore>(state, forking, (next) => selected(next, forkId));
      if (!input.worktree) return opened;
      return andThen<ThreadCore>(state, opened, (next) => shownNotAnswered(next, worktreeSet(next, { type: "task.set-worktree", taskId: forkId, worktree: true })));
    }

    case "view.fork-name": return askForkName(state, input);

    case "view.archive-prompt":
      if (input.threadId === null) return { edits: [archivePromptIn(dialogsOf(state), null)] };
      return archivePromptView(state, input.threadId) ? { edits: [menuIn(archivePromptIn(dialogsOf(state), input.threadId), null)] } : {};

    /** A drag reveals every folder so it can be dropped into, so the drop leaves the folding alone. */
    case "task.move": {
      const threads = movedInListIn(threadsOf(state), input.taskId, input.target);
      return threads.view.threads === state.threads ? {} : { edits: [threads], closesMenu: true };
    }

    case "task.set-policy": {
      const target = settingsTarget(state, input.taskId);
      if (!capabilitiesFor(target.engine).policies.includes(input.policy)) return {};
      return withSetting(state, target, { policy: input.policy }, { executionPolicy: input.policy });
    }

    case "task.set-model": {
      const target = settingsTarget(state, input.taskId), catalog = catalogOf(state);
      const model = input.model ?? defaultModelIn(catalog, input.engine);
      /** A thread keeps the engine it started on, so the model must be one that engine offers too. */
      if (model === undefined || !engineHasModel(catalog, input.engine, model) || target.thread && !engineHasModel(catalog, target.thread.engine, model)) return {};
      /** A draft keeps its effort where the new model takes it, and drops to the nearest one below where it does not. */
      return withSetting(state, target, { engine: input.engine, model }, { model });
    }

    case "task.set-fast-mode": {
      const target = settingsTarget(state, input.taskId);
      if (target.taskId && !target.thread || !capabilitiesFor(target.engine).fastMode) return {};
      return withSetting(state, target, { fastMode: input.fastMode }, { fastMode: input.fastMode });
    }

    case "task.set-effort": {
      const target = settingsTarget(state, input.taskId);
      /** Effort belongs to the model, and to the part the thread plays, so only one the target takes can be set on it. */
      if (target.thread && !threadTakesEffort(state, target.thread, input.effort)) return {};
      const draftTakes = modelHasEffort(catalogOf(state), state.draftEngine, state.draftModel, input.effort, effortRoleOf(undefined, state.draftRole));
      if (!target.thread && !draftTakes) return {};
      /** The draft keeps its own model, so it takes the effort only where that model offers it. */
      return withSetting(state, target, draftTakes ? { effort: input.effort } : null, { effort: input.effort });
    }
  }
}

/**
 * What a setting command changes: the thread it names, or with none named the draft and the thread on
 * screen. `engine` is what that thread runs on, else the draft's.
 */
type SettingsTarget = { named: boolean; taskId: string | null; thread: Thread | undefined; engine: EngineId };

function settingsTarget(state: WorkspaceState, taskId: string | undefined): SettingsTarget {
  const target = targetId(state, taskId);
  const thread = state.threads.find((item) => item.id === target);
  return { named: taskId !== undefined, taskId: target, thread, engine: thread?.engine ?? state.draftEngine };
}

/** Writes a setting to its target; `draft` is what an unnamed one changes on the draft, or null where the draft does not take it. */
function withSetting(state: WorkspaceState, target: SettingsTarget, draft: Partial<AgentDraft> | null, setting: Pick<Partial<ThreadCore>, "executionPolicy" | "model" | "effort" | "fastMode">): ThreadStep {
  const drafting = !target.named && draft ? [draftChoiceIn(navigationOf(state), changedDraft(state, draft))] : [];
  const writing = target.taskId ? [editThread(threadsOf<ThreadCore>(state), target.taskId, () => ({ ...setting, updatedAt: now() }))] : [];
  return { edits: [...drafting, ...writing] };
}

function threadTakesEffort(state: WorkspaceState, thread: Thread, effort: AgentEffort) {
  const model = threadModel(catalogOf(state), thread);
  return model !== undefined && modelHasEffort(catalogOf(state), thread.engine, model, effort, effortRoleOf(thread, null));
}
