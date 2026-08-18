import { promptWithAttachments, taskTitleFor } from "./attachments.js";
import { moveTask as moveTaskInList, nextSortIndex } from "./task-order.js";
import {
  applyRunEvent,
  applyTask,
  automationRunLabel,
  automationRunPrompt,
  createTaskMessage,
  withActiveRun,
  withRunStatus,
} from "./task-workspace.js";
import { projectFor, promptKey, stateFromData, viewPreferences, withPrompt, type PendingRun, type QueuedMessage, type SideChat, type WorkspaceState } from "./workspace-state.js";
import type { AppCommand } from "../contracts/commands.js";
import type {
  ApprovalDecisionCommand,
  AutomationAck,
  AutomationFire,
  CancelRunCommand,
  ChangedFilesResult,
  RunEvent,
  StartRunCommand,
  SteerRunCommand,
} from "../contracts/ipc.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../domain/automation.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type RunStatus } from "../domain/run.js";
import { clampTitle, legacyProjectId, type Task, type TaskAttention, type TaskStoreData } from "../domain/task.js";
import type { WorkspaceRecord } from "../domain/workspace.js";

/** Things that happened: replies to effects, and pushes from the main process. */
export type WorkspaceEvent =
  | { type: "store.loaded"; data: TaskStoreData }
  | { type: "preferences.loaded"; preferences: ViewPreferences }
  | { type: "store.failed"; message: string }
  | { type: "action.failed"; message: string }
  | { type: "project.opened"; workspace: WorkspaceRecord }
  | { type: "run.event"; event: RunEvent }
  | { type: "run.resolved"; pendingId: string; workspace: WorkspaceRecord }
  | { type: "run.unresolved"; pendingId: string; message: string }
  | { type: "automation.fired"; fire: AutomationFire }
  | { type: "automations.changed"; automations: AutomationView[] }
  | { type: "title.suggested"; taskId: string; title: string }
  | { type: "environment.updated"; workspaceId: string; taskId?: string; runId?: string; result: ChangedFilesResult };

/** Work the reducer wants done outside itself. The renderer performs these; nothing else does. */
export type WorkspaceEffect =
  | { type: "pick-project" }
  | { type: "persist-preferences"; preferences: ViewPreferences }
  | { type: "resolve-run-workspace"; pendingId: string; picker: boolean; workspaceId?: string; root?: string }
  | { type: "start-run"; command: StartRunCommand }
  | { type: "send-run-command"; command: CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand }
  | { type: "refresh-environment"; workspaceId: string; taskId?: string; runId?: string }
  | { type: "suggest-title"; taskId: string; text: string }
  | { type: "automation.save"; draft: AutomationDraft }
  | { type: "automation.update"; taskId: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId: string }
  | { type: "automation.run-now"; taskId: string }
  | { type: "automation.ack"; ack: AutomationAck };

export type WorkspaceInput = AppCommand | WorkspaceEvent;

export type WorkspaceTransition = { state: WorkspaceState; effects: WorkspaceEffect[] };

const REOPEN_PROJECT_ERROR = "Reopen this project folder before running a task.";
const SAME_PROJECT_ERROR = "Choose the same project folder to continue this task.";
const MISSING_PROJECT_ERROR = "This task's project is unavailable. Reopen the project folder before running it.";
const RUNNING_PROJECT_ERROR = "Stop the running tasks before removing this project.";
const BUSY_AUTOMATION_ERROR = "This task is already running. The automation will run on its next tick.";

export const WORKSPACE_ERRORS = {
  reopenProject: REOPEN_PROJECT_ERROR,
  sameProject: SAME_PROJECT_ERROR,
  busyAutomation: BUSY_AUTOMATION_ERROR,
} as const;

function now() {
  return Date.now();
}

function settled(state: WorkspaceState, effects: WorkspaceEffect[] = []): WorkspaceTransition {
  return { state, effects };
}

/** A run only earns a dot when it settles on its own; cancelling is the user's own doing. */
function attentionFor(event: RunEvent): TaskAttention | null {
  if (event.type === "approval.requested") return "approval";
  if (event.type !== "run.status") return null;
  if (event.status === "succeeded") return "finished";
  if (event.status === "failed") return "failed";
  return null;
}

function withoutAttention(state: WorkspaceState, taskId: string | null): WorkspaceState {
  if (!taskId || !state.tasks.some((task) => task.id === taskId && task.attention)) return state;
  return applyTask(state, taskId, ({ attention: _seen, ...task }) => task);
}

/** An archived task is unreachable, so its automation would tick forever with nowhere to run. */
function retireAutomations(state: WorkspaceState, taskIds: Iterable<string>): WorkspaceEffect[] {
  const scheduled = new Set(state.automations.map((automation) => automation.taskId));
  return [...taskIds].filter((taskId) => scheduled.has(taskId)).map((taskId) => ({ type: "automation.delete" as const, taskId }));
}

function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return { ...state, pendingRuns: { ...state.pendingRuns, [pending.id]: pending }, actionError: null };
}

function withoutPending(state: WorkspaceState, pendingId: string): WorkspaceState {
  const { [pendingId]: _settled, ...pendingRuns } = state.pendingRuns;
  return { ...state, pendingRuns };
}

function queuedFor(state: WorkspaceState, taskId: string): QueuedMessage[] {
  return state.queuedMessages[taskId] ?? [];
}

function withQueued(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  if (messages.length) return { ...state, queuedMessages: { ...state.queuedMessages, [taskId]: messages } };
  const { [taskId]: _drained, ...queuedMessages } = state.queuedMessages;
  return { ...state, queuedMessages };
}

function startRunCommand(task: Task, runId: string, prompt: string, workspaceId: string, policy = task.executionPolicy): StartRunCommand {
  return {
    type: "start",
    channel: "main",
    taskId: task.id,
    runId,
    prompt,
    workspaceId,
    policy,
    model: task.model ?? DEFAULT_MODEL,
    effort: task.effort ?? DEFAULT_EFFORT,
    ...(task.continuation ? { continuation: task.continuation } : {}),
  };
}

/** Records the run against the task and marks it the task's latest, so stale replies can be dropped. */
function beginRun(state: WorkspaceState, taskId: string, runId: string): WorkspaceState {
  return withRunStatus(
    withActiveRun({ ...state, actionError: null, lastRunIds: { ...state.lastRunIds, [taskId]: runId } }, taskId, { taskId, runId, sequence: 0, status: "running" }),
    taskId,
    "running",
  );
}

/** A steered message joined the run, so it leaves the queue and takes its place in the thread. */
function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  return applyTask(withQueued(state, taskId, queued.filter((message) => message.id !== messageId)), taskId, (task) => ({
    ...task,
    messages: [...task.messages, createTaskMessage("user", delivered.text, undefined, delivered.attachments)],
    updatedAt: now(),
  }));
}

/**
 * A finished run hands its queue on one message at a time, so each queued message gets its own run
 * and the ones behind it wait for that run to finish. A run the user stopped hands the whole queue
 * back to the composer instead of speaking for them.
 */
function drainQueue(state: WorkspaceState, taskId: string, status: RunStatus): WorkspaceTransition {
  const queued = queuedFor(state, taskId);
  if (!queued.length) return settled(state);
  if (status === "cancelled") {
    const text = [...queued.map((message) => message.text), state.prompts[taskId] ?? ""].filter(Boolean).join("\n\n");
    return settled(withPrompt(withQueued(state, taskId, []), taskId, text));
  }
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return settled(withQueued(state, taskId, []));
  const [next] = queued;
  const project = projectFor(state, task);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    taskId,
    ...(project ? { projectId: project.id } : {}),
    text: next.text,
    prompt: next.prompt,
    attachments: next.attachments,
    queuedIds: [next.id],
  };
  return settled(withPending(state, pending), [{
    type: "resolve-run-workspace",
    pendingId: pending.id,
    picker: Boolean(project && !project.workspaceId),
    ...(project?.workspaceId ? { workspaceId: project.workspaceId } : {}),
    ...(project ? { root: project.root } : {}),
  }]);
}

function ack(pending: PendingRun, started: boolean): WorkspaceEffect[] {
  return pending.automationId ? [{ type: "automation.ack", ack: { automationId: pending.automationId, runId: pending.runId, started } }] : [];
}

function withSideChat(state: WorkspaceState, chatId: string, update: (chat: SideChat) => SideChat): WorkspaceState {
  return { ...state, sideChats: state.sideChats.map((chat) => chat.id === chatId ? update(chat) : chat) };
}

/** Side chats own their run state, so closing one has to cancel it rather than leave it orphaned. */
function closeSideChats(state: WorkspaceState, closing: SideChat[]): WorkspaceTransition {
  const effects: WorkspaceEffect[] = [];
  let next = state;
  for (const chat of closing) {
    const active = next.activeRuns[chat.id];
    if (active) {
      effects.push({ type: "send-run-command", command: { type: "cancel", taskId: chat.id, runId: active.runId } });
      const { [active.runId]: _abandoned, ...approvals } = next.approvals;
      next = { ...next, approvals };
    }
    next = withRunStatus(withActiveRun(next, chat.id, null), chat.id, "idle");
  }
  const closed = new Set(closing.map((chat) => chat.id));
  return {
    state: {
      ...next,
      sideChats: next.sideChats.filter((chat) => !closed.has(chat.id)),
      pendingRuns: Object.fromEntries(Object.entries(next.pendingRuns).filter(([, pending]) => !(pending.taskId && closed.has(pending.taskId)))),
    },
    effects,
  };
}

/**
 * The single writer for workspace state. Commands come from the UI (and, later, from anything else
 * driving the app); events report what the outside world did back. Nothing here touches Electron.
 */
export function reduce(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  const transition = apply(state, input);
  if (transition.state.currentId === state.currentId || !transition.state.sideChats.length) return transition;
  const closed = closeSideChats(transition.state, transition.state.sideChats);
  return { state: { ...closed.state, sideChatSequence: 0 }, effects: [...transition.effects, ...closed.effects] };
}

function apply(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  switch (input.type) {
    case "task.new": {
      const project = input.projectId ? state.projects.find((item) => item.id === input.projectId) : undefined;
      return settled({
        ...state,
        currentId: null,
        draftProjectId: input.projectId ?? null,
        actionError: null,
        lastFolder: project?.root ?? state.lastFolder,
        expandedProjects: input.projectId ? new Set(state.expandedProjects).add(input.projectId) : state.expandedProjects,
      });
    }

    case "task.select": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const project = projectFor(state, task);
      return settled(withoutAttention({
        ...state,
        currentId: input.taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: project?.root ?? state.lastFolder,
        actionError: null,
      }, input.taskId));
    }

    /** Archiving a running task cancels its run; the task leaves the sidebar without waiting for the run to settle. */
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

    case "task.move": {
      const tasks = moveTaskInList(state.tasks, input.taskId, input.target);
      if (tasks === state.tasks) return settled(state);
      const projectId = tasks.find((task) => task.id === input.taskId)?.projectId;
      return settled({
        ...state,
        tasks,
        expandedProjects: projectId ? new Set(state.expandedProjects).add(projectId) : state.expandedProjects,
        openMenu: null,
      });
    }

    case "task.set-policy":
      return settled(state.currentId
        ? applyTask({ ...state, draftPolicy: input.policy }, state.currentId, (task) => ({ ...task, executionPolicy: input.policy, updatedAt: now() }))
        : { ...state, draftPolicy: input.policy });

    case "task.set-model":
      return settled(state.currentId
        ? applyTask({ ...state, draftModel: input.model }, state.currentId, (task) => ({ ...task, model: input.model, updatedAt: now() }))
        : { ...state, draftModel: input.model });

    case "task.set-effort":
      return settled(state.currentId
        ? applyTask({ ...state, draftEffort: input.effort }, state.currentId, (task) => ({ ...task, effort: input.effort, updatedAt: now() }))
        : { ...state, draftEffort: input.effort });

    case "task.send": {
      const attachments = input.attachments ?? [];
      const draftKey = promptKey(state);
      const text = (state.prompts[draftKey] ?? "").trim();
      const alreadySending = Object.values(state.pendingRuns).some((pending) => pending.draftKey === draftKey);
      if ((!text && attachments.length === 0) || alreadySending) return settled(state);
      const task = state.tasks.find((item) => item.id === state.currentId);
      if (task && state.activeRuns[task.id]) {
        const queued: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          prompt: promptWithAttachments(text, attachments),
          attachments: attachments.map((attachment) => attachment.path),
        };
        const next = withQueued(withPrompt(state, draftKey, ""), task.id, [...queuedFor(state, task.id), queued]);
        return input.steer ? apply(next, { type: "task.steer-queued", messageId: queued.id }) : settled(next);
      }
      const projectId = task?.projectId ?? state.draftProjectId;
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      if (projectId && !project) return settled({ ...state, actionError: MISSING_PROJECT_ERROR });
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        origin: "composer",
        ...(task ? { taskId: task.id } : {}),
        ...(project ? { projectId: project.id } : {}),
        draftKey,
        text,
        prompt: promptWithAttachments(text, attachments),
        attachments: attachments.map((attachment) => attachment.path),
      };
      return settled(withPending(state, pending), [{
        type: "resolve-run-workspace",
        pendingId: pending.id,
        picker: Boolean(project && !project.workspaceId),
        ...(project?.workspaceId ? { workspaceId: project.workspaceId } : {}),
        ...(project ? { root: project.root } : {}),
      }]);
    }

    case "task.steer-queued": {
      const taskId = state.currentId;
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !active || !message || message.steering) return settled(state);
      return settled(
        withQueued(state, taskId, queued.map((item) => item.id === message.id ? { ...item, steering: true } : item)),
        [{ type: "send-run-command", command: { type: "steer", taskId, runId: active.runId, messageId: message.id, prompt: message.prompt } }],
      );
    }

    /** A steered message is already on its way to the agent, so only an unsteered one can be dropped. */
    case "task.drop-queued": {
      const taskId = state.currentId;
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !message || message.steering) return settled(state);
      return settled(withQueued(state, taskId, queued.filter((item) => item.id !== message.id)));
    }

    case "project.open":
      return settled(state, [{ type: "pick-project" }]);

    case "project.opened": {
      const id = legacyProjectId(input.workspace.root);
      const projects = state.projects.some((project) => project.id === id)
        ? state.projects.map((project) => project.id === id ? { ...project, root: input.workspace.root, workspaceId: input.workspace.id } : project)
        : [{ id, root: input.workspace.root, workspaceId: input.workspace.id }, ...state.projects];
      return settled({
        ...state,
        projects,
        currentId: null,
        draftProjectId: id,
        lastFolder: input.workspace.root,
        actionError: null,
        expandedProjects: new Set(state.expandedProjects).add(id),
      });
    }

    case "project.remove": {
      if (state.tasks.some((task) => task.projectId === input.projectId && state.activeRuns[task.id])) {
        return settled({ ...state, actionError: RUNNING_PROJECT_ERROR });
      }
      const effects = retireAutomations(state, state.tasks.filter((task) => task.projectId === input.projectId).map((task) => task.id));
      const project = state.projects.find((item) => item.id === input.projectId);
      const expandedProjects = new Set(state.expandedProjects);
      expandedProjects.delete(input.projectId);
      return settled({
        ...state,
        projects: state.projects.filter((item) => item.id !== input.projectId),
        tasks: state.tasks.map((task) => {
          if (task.projectId !== input.projectId) return task;
          const { projectId: _removed, ...projectlessTask } = task;
          return task.archivedAt === undefined ? { ...projectlessTask, archivedAt: now() } : projectlessTask;
        }),
        currentId: state.tasks.find((task) => task.id === state.currentId)?.projectId === input.projectId ? null : state.currentId,
        draftProjectId: state.draftProjectId === input.projectId ? null : state.draftProjectId,
        lastFolder: project?.root === state.lastFolder ? null : state.lastFolder,
        expandedProjects,
        openMenu: null,
        actionError: null,
      }, effects);
    }

    case "run.resolved": {
      const pending = state.pendingRuns[input.pendingId];
      if (!pending) return settled(state);
      let next = withoutPending(state, input.pendingId);
      const project = pending.projectId ? next.projects.find((item) => item.id === pending.projectId) : undefined;
      if (project && (project.workspaceId !== input.workspace.id || project.root !== input.workspace.root)) {
        next = { ...next, projects: next.projects.map((item) => item.id === project.id ? { ...item, workspaceId: input.workspace.id, root: input.workspace.root } : item) };
      }
      if (pending.origin === "automation") return startAutomationRun(next, pending, input.workspace);
      return pending.origin === "side" ? startSideRun(next, pending, input.workspace) : startComposerRun(next, pending, input.workspace);
    }

    case "run.unresolved": {
      const pending = state.pendingRuns[input.pendingId];
      if (!pending) return settled(state);
      const next = withoutPending(state, input.pendingId);
      if (pending.origin === "automation") return settled(next, ack(pending, false));
      if (pending.origin === "side") return settled(withSideChat(next, pending.taskId!, (chat) => ({ ...chat, error: input.message })));
      return settled({ ...next, actionError: input.message });
    }

    case "run.cancel": {
      const active = state.currentId ? state.activeRuns[state.currentId] : undefined;
      if (!active) return settled(state);
      return settled(state, [{ type: "send-run-command", command: { type: "cancel", taskId: active.taskId, runId: active.runId } }]);
    }

    case "run.decide": {
      const active = state.currentId ? state.activeRuns[state.currentId] : undefined;
      const approval = active ? state.approvals[active.runId] : undefined;
      if (!active || !approval) return settled(state);
      const { [active.runId]: _decided, ...approvals } = state.approvals;
      return settled({ ...state, approvals }, [{
        type: "send-run-command",
        command: { type: "approval", taskId: active.taskId, runId: active.runId, approvalId: approval.approvalId, allow: input.allow },
      }]);
    }

    case "run.event": {
      const { event } = input;
      const chat = state.sideChats.find((item) => item.id === event.taskId);
      if (chat) {
        const applied = applyRunEvent({ tasks: [chat.task], activeRuns: state.activeRuns, runStatuses: state.runStatuses, approvals: state.approvals, streamingTails: state.streamingTails }, event);
        return settled({
          ...withSideChat(state, chat.id, (item) => ({ ...item, task: applied.tasks[0]! })),
          activeRuns: applied.activeRuns,
          runStatuses: applied.runStatuses,
          approvals: applied.approvals,
          streamingTails: applied.streamingTails,
        });
      }
      const active = state.activeRuns[event.taskId];
      if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return settled(state);
      const project = projectFor(state, state.tasks.find((task) => task.id === event.taskId));
      const applied = applyRunEvent(state, event);
      const attention = attentionFor(event);
      let next = attention && !(state.focused && state.currentId === event.taskId)
        ? applyTask(applied, event.taskId, (task) => ({ ...task, attention }))
        : applied;
      if (event.type === "computer-use.setup-required") next = { ...next, computerUseSetup: true };
      if (event.type === "queued.delivered") next = withDeliveredMessage(next, event.taskId, event.messageId);
      const finished = event.type === "run.status" && (event.status === "succeeded" || event.status === "failed");
      const environment: WorkspaceEffect[] = finished && project?.workspaceId
        ? [{ type: "refresh-environment", workspaceId: project.workspaceId, taskId: event.taskId, runId: event.runId }]
        : [];
      if (event.type !== "run.status" || event.status === "running" || event.status === "awaiting-approval") return settled(next, environment);
      const drained = drainQueue(next, event.taskId, event.status);
      return settled(drained.state, [...environment, ...drained.effects]);
    }

    /** The scheduler owns the cadence; the workspace decides whether this tick can actually run. */
    case "automation.fired": {
      const { fire } = input;
      const decline: WorkspaceEffect[] = [{ type: "automation.ack", ack: { automationId: fire.automationId, runId: fire.runId, started: false } }];
      const task = state.tasks.find((item) => item.id === fire.taskId);
      if (!task || task.archivedAt !== undefined || state.activeRuns[fire.taskId]) return settled(state, decline);
      const project = projectFor(state, task);
      if (task.projectId && !project?.workspaceId) return settled(state, decline);
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: fire.runId,
        origin: "automation",
        taskId: fire.taskId,
        ...(project ? { projectId: project.id } : {}),
        text: fire.prompt,
        prompt: automationRunPrompt(fire.prompt, fire.runNumber),
        detail: automationRunLabel(fire.runNumber),
        attachments: [],
        ...(fire.policy ? { policy: fire.policy } : {}),
        automationId: fire.automationId,
      };
      return settled(withPending(state, pending), [{
        type: "resolve-run-workspace",
        pendingId: pending.id,
        picker: false,
        ...(project?.workspaceId ? { workspaceId: project.workspaceId } : {}),
        ...(project ? { root: project.root } : {}),
      }]);
    }

    case "side-chat.open": {
      const source = state.tasks.find((task) => task.id === state.currentId);
      if (!source) return settled(state);
      const sequence = state.sideChatSequence + 1;
      const chat: SideChat = {
        id: input.chatId,
        title: `Chat ${sequence}`,
        sourceTaskId: source.id,
        prompt: "",
        error: null,
        task: {
          id: input.chatId,
          title: "Side chat",
          executionPolicy: "plan",
          ...(source.model ? { model: source.model } : {}),
          ...(source.effort ? { effort: source.effort } : {}),
          messages: [],
          continuationStatus: "none",
          lastChangeSnapshot: { files: [], capturedAt: now() },
          updatedAt: now(),
        },
      };
      return settled({ ...state, sideChats: [...state.sideChats, chat], sideChatSequence: sequence });
    }

    case "side-chat.close": {
      const chat = state.sideChats.find((item) => item.id === input.chatId);
      return chat ? closeSideChats(state, [chat]) : settled(state);
    }

    case "side-chat.set-prompt":
      return settled(withSideChat(state, input.chatId, (chat) => ({ ...chat, prompt: input.prompt })));

    case "side-chat.send": {
      const chat = state.sideChats.find((item) => item.id === input.chatId);
      const text = chat?.prompt.trim();
      const source = chat ? state.tasks.find((task) => task.id === chat.sourceTaskId) : undefined;
      const sending = Object.values(state.pendingRuns).some((pending) => pending.taskId === input.chatId);
      if (!chat || !text || !source?.continuation || sending || state.activeRuns[chat.id]) return settled(state);
      const project = projectFor(state, source);
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        origin: "side",
        taskId: chat.id,
        ...(project ? { projectId: project.id } : {}),
        text,
        prompt: text,
        attachments: [],
      };
      return settled(withPending(withSideChat(state, chat.id, (item) => ({ ...item, error: null })), pending), [{
        type: "resolve-run-workspace",
        pendingId: pending.id,
        picker: Boolean(project && !project.workspaceId),
        ...(project?.workspaceId ? { workspaceId: project.workspaceId } : {}),
        ...(project ? { root: project.root } : {}),
      }]);
    }

    case "side-chat.cancel": {
      const active = state.activeRuns[input.chatId];
      if (!active) return settled(state);
      return settled(state, [{ type: "send-run-command", command: { type: "cancel", taskId: active.taskId, runId: active.runId } }]);
    }

    case "automation.save":
      return state.currentId ? settled(state, [{ type: "automation.save", draft: { ...input.draft, taskId: state.currentId } }]) : settled(state);

    case "automation.update":
      return state.currentId ? settled(state, [{ type: "automation.update", taskId: state.currentId, patch: input.patch }]) : settled(state);

    case "automation.delete":
      return state.currentId ? settled(state, [{ type: "automation.delete", taskId: state.currentId }]) : settled(state);

    case "automation.run-now":
      return state.currentId ? settled(state, [{ type: "automation.run-now", taskId: state.currentId }]) : settled(state);

    case "automations.changed":
      return settled({ ...state, automations: input.automations });

    case "view.refresh-environment": {
      const currentTask = state.tasks.find((task) => task.id === state.currentId);
      const currentProject = currentTask
        ? projectFor(state, currentTask)
        : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
      if (!currentProject?.workspaceId) return settled(state.environment === null ? state : { ...state, environment: null });
      const taskId = currentTask?.id;
      const runId = taskId ? state.lastRunIds[taskId] : undefined;
      return settled(state, [{
        type: "refresh-environment",
        workspaceId: currentProject.workspaceId,
        ...(taskId ? { taskId } : {}),
        ...(runId ? { runId } : {}),
      }]);
    }

    case "environment.updated": {
      if (input.taskId && input.runId && state.lastRunIds[input.taskId] !== input.runId) return settled(state);
      const next: WorkspaceState = { ...state, environment: { workspaceId: input.workspaceId, result: input.result } };
      if (!input.taskId || input.result.status !== "available") return settled(next);
      const files = input.result.files;
      return settled(applyTask(next, input.taskId, (task) => ({ ...task, lastChangeSnapshot: { files, capturedAt: now() }, updatedAt: now() })));
    }

    case "store.loaded":
      return settled({ ...stateFromData(input.data), automations: state.automations, focused: state.focused, sessionPanelOpen: state.sessionPanelOpen });

    case "preferences.loaded":
      return settled({ ...state, sessionPanelOpen: input.preferences.sessionPanelOpen });

    case "store.failed":
      return settled({ ...state, writable: false, storageError: input.message });

    case "action.failed":
      return settled({ ...state, actionError: input.message });

    case "view.set-prompt":
      return settled(withPrompt(state, promptKey(state), input.prompt));

    case "view.toggle-project": {
      const expandedProjects = new Set(state.expandedProjects);
      if (expandedProjects.has(input.projectId)) expandedProjects.delete(input.projectId);
      else expandedProjects.add(input.projectId);
      return settled({ ...state, expandedProjects });
    }

    case "view.set-projects-open":
      return settled({ ...state, projectsOpen: input.open });

    case "view.set-recents-open":
      return settled({ ...state, recentsOpen: input.open });

    case "view.set-session-panel-open": {
      if (state.sessionPanelOpen === input.open) return settled(state);
      const next = { ...state, sessionPanelOpen: input.open };
      return settled(next, [{ type: "persist-preferences", preferences: viewPreferences(next) }]);
    }

    case "view.set-menu":
      return settled({ ...state, openMenu: input.menu });

    case "view.set-focused":
      return settled(input.focused ? withoutAttention({ ...state, focused: true }, state.currentId) : { ...state, focused: false });

    case "view.dismiss-computer-use-setup":
      return settled({ ...state, computerUseSetup: false });
  }
}

function startComposerRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord): WorkspaceTransition {
  const existing = pending.taskId ? state.tasks.find((item) => item.id === pending.taskId) : undefined;
  if (pending.taskId && (!existing || state.activeRuns[pending.taskId])) return settled(state);
  const task: Task = existing ?? {
    id: crypto.randomUUID(),
    title: taskTitleFor(pending.text, pending.attachments.map((path) => ({ path, labels: [] }))),
    ...(pending.projectId ? { projectId: pending.projectId } : {}),
    executionPolicy: state.draftPolicy,
    model: state.draftModel,
    effort: state.draftEffort,
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: now() },
    sortIndex: nextSortIndex(state.tasks),
    updatedAt: now(),
  };
  const message = createTaskMessage("user", pending.text, undefined, pending.attachments);
  const updated = { ...task, messages: [...task.messages, message], updatedAt: now() };
  const tasks = existing ? state.tasks.map((item) => item.id === task.id ? updated : item) : [updated, ...state.tasks];
  /** Only a task the send just created needs looking at; anything else leaves the user where they are. */
  const started = beginRun({ ...state, tasks, ...(existing ? {} : { currentId: task.id }) }, task.id, pending.runId);
  const drained = pending.queuedIds
    ? withQueued(started, task.id, queuedFor(started, task.id).filter((message) => !pending.queuedIds!.includes(message.id)))
    : started;
  const titling: WorkspaceEffect[] = existing || !pending.text ? [] : [{ type: "suggest-title", taskId: task.id, text: pending.text }];
  return settled(
    pending.draftKey ? withPrompt(drained, pending.draftKey, "") : drained,
    [{ type: "start-run", command: startRunCommand(updated, pending.runId, pending.prompt, workspace.id) }, ...titling],
  );
}

/** A side chat forks the source thread on its first turn, then continues on its own branch. */
function startSideRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord): WorkspaceTransition {
  const chat = state.sideChats.find((item) => item.id === pending.taskId);
  const source = chat ? state.tasks.find((task) => task.id === chat.sourceTaskId) : undefined;
  if (!chat || !source?.continuation || state.activeRuns[chat.id]) return settled(state);
  const firstTurn = !chat.task.continuation;
  const task = { ...chat.task, messages: [...chat.task.messages, createTaskMessage("user", pending.text)], updatedAt: now() };
  const next = withSideChat(state, chat.id, (item) => ({ ...item, task, prompt: "", error: null }));
  return settled(
    withRunStatus(withActiveRun(next, chat.id, { taskId: chat.id, runId: pending.runId, sequence: 0, status: "running" }), chat.id, "running"),
    [{
      type: "start-run",
      command: {
        type: "start",
        channel: "side",
        taskId: chat.id,
        runId: pending.runId,
        prompt: pending.prompt,
        workspaceId: workspace.id,
        policy: "plan",
        model: source.model ?? DEFAULT_MODEL,
        effort: source.effort ?? DEFAULT_EFFORT,
        continuation: firstTurn ? source.continuation : chat.task.continuation!,
        ...(firstTurn ? { forkContinuation: true } : {}),
      },
    }],
  );
}

function startAutomationRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord): WorkspaceTransition {
  const taskId = pending.taskId!;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.archivedAt !== undefined || state.activeRuns[taskId]) return settled(state, ack(pending, false));
  const message = createTaskMessage("user", pending.text, pending.detail);
  const withMessage = applyTask(state, taskId, (item) => ({ ...item, messages: [...item.messages, message], updatedAt: now() }));
  return settled(beginRun(withMessage, taskId, pending.runId), [
    { type: "start-run", command: startRunCommand(task, pending.runId, pending.prompt, workspace.id, pending.policy ?? task.executionPolicy) },
    ...ack(pending, true),
  ]);
}
